import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor } from '../../../common/auth/actor';
import { paginate } from '../../../common/validation/query';
import { AuditLogView, AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import {
  OrderSweepReport,
  OrderTimeoutSweeperService,
} from '../../ordering/application/order-timeout-sweeper.service';
import {
  OrderRefundReactorService,
  RefundSweepReport,
} from '../../payment/application/order-refund-reactor.service';
import { AdminTargetNotFoundError, OutboxEventNotRetryableError } from '../domain/admin.errors';
import { AdminOutboxEventView, AdminOutboxStatsView } from '../interface/admin.views';
import {
  AdminAuditQueryDto,
  AdminOutboxQueryDto,
} from '../interface/dto/admin.dto';

const outboxSelect = {
  id: true,
  aggregateType: true,
  aggregateId: true,
  eventType: true,
  version: true,
  status: true,
  attempts: true,
  lastError: true,
  availableAt: true,
  publishedAt: true,
  createdAt: true,
} as const;

type OutboxRow = {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  version: number;
  status: string;
  attempts: number;
  lastError: string | null;
  availableAt: Date;
  publishedAt: Date | null;
  createdAt: Date;
};

/**
 * Operational visibility.
 *
 * The outbox is the one subsystem whose failure is silent: a stuck relay means
 * orders keep working while notifications quietly stop arriving. So the console
 * exposes not just the counts but the *age of the oldest un-published event* —
 * a backlog that is not draining is the symptom, and a count alone cannot show
 * it.
 */
@Injectable()
export class AdminOpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    // The two background loops. Injected so the console can run a pass on
    // demand: "this order has been sitting in PAID for an hour" should be
    // answerable without waiting up to a sweep interval, and the e2e suite
    // needs a deterministic trigger rather than a sleep.
    private readonly orderSweeper: OrderTimeoutSweeperService,
    private readonly refundReactor: OrderRefundReactorService,
  ) {}

  /**
   * Run both background passes now and report what they did.
   *
   * Sequential, not `Promise.all`: the refund reactor only sees orders the
   * order sweeper has already expired, so running them concurrently would make
   * the report depend on scheduling luck.
   */
  async runSweeps(): Promise<{
    orders: OrderSweepReport;
    refunds: RefundSweepReport;
  }> {
    const orders = await this.orderSweeper.sweep();
    const refunds = await this.refundReactor.sweep();
    return { orders, refunds };
  }

  async outboxStats(now: Date = new Date()): Promise<AdminOutboxStatsView> {
    const [groups, oldest] = await Promise.all([
      this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.outboxEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const group of groups) byStatus[group.status] = group._count._all;

    return {
      byStatus,
      oldestPendingAt: oldest?.createdAt.toISOString() ?? null,
      oldestPendingAgeSeconds: oldest
        ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000))
        : null,
      deadLetterCount: byStatus.DEAD_LETTER ?? 0,
    };
  }

  async listOutbox(
    query: AdminOutboxQueryDto,
  ): Promise<{ data: AdminOutboxEventView[]; total: number }> {
    const where: Prisma.OutboxEventWhereInput = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.eventType ? { eventType: { contains: query.eventType } } : {}),
      ...(query.aggregateId ? { aggregateId: query.aggregateId } : {}),
    };

    const { take, skip } = paginate(query);
    const [rows, total] = await Promise.all([
      this.prisma.outboxEvent.findMany({
        where,
        // Newest first by default; the stats endpoint is what surfaces the
        // oldest pending one, so the list can favour recency.
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: outboxSelect,
      }),
      this.prisma.outboxEvent.count({ where }),
    ]);

    return { data: rows.map(toOutboxView), total };
  }

  /**
   * Put a failed event back in the queue.
   *
   * Only `FAILED` and `DEAD_LETTER` qualify. Requeuing a `PENDING` event would
   * reset its attempt counter and hide a relay that is failing in a loop;
   * requeuing a `PUBLISHED` one would deliver a duplicate.
   */
  async retryOutbox(eventId: string, actor: Actor): Promise<AdminOutboxEventView> {
    const current = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
      select: outboxSelect,
    });
    if (!current) throw new AdminTargetNotFoundError('事件', eventId);
    if (current.status !== 'FAILED' && current.status !== 'DEAD_LETTER') {
      throw new OutboxEventNotRetryableError(eventId, current.status);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.outboxEvent.update({
        where: { id: eventId },
        data: {
          status: 'PENDING',
          attempts: 0,
          lastError: null,
          availableAt: new Date(),
        },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'outbox.retry',
          targetType: 'OutboxEvent',
          targetId: eventId,
          before: { status: current.status, attempts: current.attempts, lastError: current.lastError },
          after: { status: 'PENDING', attempts: 0 },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.getOutboxEvent(eventId);
  }

  /** Stop retrying an event that will never succeed. */
  async deadLetter(eventId: string, actor: Actor): Promise<AdminOutboxEventView> {
    const current = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
      select: outboxSelect,
    });
    if (!current) throw new AdminTargetNotFoundError('事件', eventId);
    if (current.status === 'PUBLISHED' || current.status === 'DEAD_LETTER') {
      throw new OutboxEventNotRetryableError(eventId, current.status);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.outboxEvent.update({
        where: { id: eventId },
        data: { status: 'DEAD_LETTER' },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'outbox.dead_letter',
          targetType: 'OutboxEvent',
          targetId: eventId,
          before: { status: current.status, attempts: current.attempts },
          after: { status: 'DEAD_LETTER' },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.getOutboxEvent(eventId);
  }

  /** The platform audit trail, newest first. */
  async listAudit(
    query: AdminAuditQueryDto,
  ): Promise<{ data: AuditLogView[]; total: number }> {
    const { take, skip } = paginate(query);
    return this.audit.list({
      limit: take,
      offset: skip,
      actorId: query.actorId,
      targetType: query.targetType,
      action: query.action,
    });
  }

  /** Connectivity probe for the console's status strip. */
  async health(): Promise<{ database: boolean; redis: boolean }> {
    const [database, redis] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(
        () => true,
        () => false,
      ),
      this.redis.isHealthy(),
    ]);
    return { database, redis };
  }

  private async getOutboxEvent(eventId: string): Promise<AdminOutboxEventView> {
    const row = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
      select: outboxSelect,
    });
    if (!row) throw new AdminTargetNotFoundError('事件', eventId);
    return toOutboxView(row);
  }
}

function toOutboxView(row: OutboxRow): AdminOutboxEventView {
  return {
    id: row.id,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    version: row.version,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    availableAt: row.availableAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
