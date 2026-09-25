import { Injectable } from '@nestjs/common';
import { Actor } from '../../../common/auth/actor';
import { paginate } from '../../../common/validation/query';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AdminTargetNotFoundError, PayoutNotSettleableError } from '../domain/admin.errors';
import {
  AdminPayoutView,
  ReconciliationRowView,
  ReconciliationView,
} from '../interface/admin.views';
import {
  AdminPayoutQueryDto,
  FailPayoutDto,
  MarkPayoutDto,
} from '../interface/dto/admin.dto';

const payoutSelect = {
  id: true,
  merchantId: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  currency: true,
  grossSubtotalMinor: true,
  platformFeeMinor: true,
  paymentFeeMinor: true,
  netPayoutMinor: true,
  orderCount: true,
  reference: true,
  paidAt: true,
  createdAt: true,
  merchant: { select: { name: true, slug: true } },
  _count: { select: { lines: true } },
} as const;

/** A payout that has been settled may not be settled again. */
const SETTLEABLE_STATUSES = ['PENDING', 'FAILED'];

export interface PayoutLineView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string | null;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
  readonly merchantPayoutMinor: number;
}

export interface AdminPayoutDetailView extends AdminPayoutView {
  readonly lines: readonly PayoutLineView[];
}

/**
 * Settlement and reconciliation.
 *
 * The payout aggregates are maintained by the order state machine
 * (`RECORD_PAYOUT_LEDGER` on `COMPLETED`/`EXPIRED`), so nothing here recomputes
 * money. What this service does is move a batch through its own lifecycle and
 * prove, via the reconciliation view, that the ledger and the orders agree.
 */
@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listPayouts(query: AdminPayoutQueryDto): Promise<{
    data: AdminPayoutView[];
    total: number;
    totals: { pendingNetMinor: number; paidNetMinor: number };
  }> {
    const where = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.merchantId ? { merchantId: query.merchantId } : {}),
    };

    const { take, skip } = paginate(query);
    const [rows, total, pending, paid] = await Promise.all([
      this.prisma.merchantPayout.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { merchantId: 'asc' }],
        take,
        skip,
        select: payoutSelect,
      }),
      this.prisma.merchantPayout.count({ where }),
      this.prisma.merchantPayout.aggregate({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        _sum: { netPayoutMinor: true },
      }),
      this.prisma.merchantPayout.aggregate({
        where: { status: 'PAID' },
        _sum: { netPayoutMinor: true },
      }),
    ]);

    return {
      data: rows.map(toPayoutView),
      total,
      totals: {
        // Prisma returns BigInt for a BigInt column — convert at the boundary,
        // never let it reach JSON.stringify.
        pendingNetMinor: Number(pending._sum.netPayoutMinor ?? 0n),
        paidNetMinor: Number(paid._sum.netPayoutMinor ?? 0n),
      },
    };
  }

  async getPayout(payoutId: string): Promise<AdminPayoutDetailView> {
    const row = await this.prisma.merchantPayout.findUnique({
      where: { id: payoutId },
      select: {
        ...payoutSelect,
        lines: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            orderId: true,
            subtotalMinor: true,
            platformFeeMinor: true,
            paymentFeeMinor: true,
            merchantPayoutMinor: true,
            order: { select: { orderNo: true } },
          },
        },
      },
    });
    if (!row) throw new AdminTargetNotFoundError('結算單', payoutId);

    return {
      ...toPayoutView(row),
      lines: row.lines.map((line) => ({
        id: line.id,
        orderId: line.orderId,
        orderNo: line.order?.orderNo ?? null,
        subtotalMinor: line.subtotalMinor,
        platformFeeMinor: line.platformFeeMinor,
        paymentFeeMinor: line.paymentFeeMinor,
        merchantPayoutMinor: line.merchantPayoutMinor,
      })),
    };
  }

  /** Record that the money left the platform's account. */
  async markPaid(
    payoutId: string,
    dto: MarkPayoutDto,
    actor: Actor,
  ): Promise<AdminPayoutDetailView> {
    const current = await this.requireSettleable(payoutId);

    await this.prisma.$transaction(async (tx) => {
      await tx.merchantPayout.update({
        where: { id: payoutId },
        data: { status: 'PAID', paidAt: new Date(), reference: dto.reference ?? null },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'payout.mark_paid',
          targetType: 'MerchantPayout',
          targetId: payoutId,
          before: { status: current.status, reference: current.reference },
          after: {
            status: 'PAID',
            reference: dto.reference ?? null,
            netPayoutMinor: Number(current.netPayoutMinor),
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.getPayout(payoutId);
  }

  /** A transfer that bounced. The batch returns to the queue for another attempt. */
  async markFailed(
    payoutId: string,
    dto: FailPayoutDto,
    actor: Actor,
  ): Promise<AdminPayoutDetailView> {
    const current = await this.requireSettleable(payoutId);

    await this.prisma.$transaction(async (tx) => {
      await tx.merchantPayout.update({
        where: { id: payoutId },
        data: { status: 'FAILED' },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'payout.mark_failed',
          targetType: 'MerchantPayout',
          targetId: payoutId,
          before: { status: current.status },
          after: { status: 'FAILED', reason: dto.reason },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.getPayout(payoutId);
  }

  /**
   * Compare the platform fee on the orders against the fee on the payout
   * ledger, per merchant per day.
   *
   * Reads the `v_daily_platform_fee_reconciliation` view rather than joining the
   * two tables here, so the SQL the operators audit against is the SQL in
   * `prisma/sql/post-init.sql` — one definition, reviewable on its own.
   */
  async reconciliation(params: {
    from: Date;
    to: Date;
    limit?: number;
    onlyMismatched?: boolean;
  }): Promise<ReconciliationView> {
    const limit = Math.min(params.limit ?? 200, 1000);

    const rows = await this.prisma.$queryRaw<
      {
        merchantId: string;
        serviceDate: Date;
        orders_platform_fee: bigint;
        payout_platform_fee: bigint;
        delta: bigint;
        unsettled_orders: bigint;
      }[]
    >`
      SELECT r."merchantId",
             r."serviceDate",
             r.orders_platform_fee,
             r.payout_platform_fee,
             r.delta,
             r.unsettled_orders
        FROM v_daily_platform_fee_reconciliation r
       WHERE r."serviceDate" >= ${params.from}::date
         AND r."serviceDate" <= ${params.to}::date
         AND (${params.onlyMismatched ?? false} = false OR r.delta <> 0)
       ORDER BY r.delta DESC, r."serviceDate" DESC
       LIMIT ${limit}
    `;

    const names = await this.merchantNames(rows.map((row) => row.merchantId));

    const mapped: ReconciliationRowView[] = rows.map((row) => ({
      merchantId: row.merchantId,
      merchantName: names.get(row.merchantId) ?? null,
      serviceDate: row.serviceDate.toISOString().slice(0, 10),
      ordersPlatformFeeMinor: Number(row.orders_platform_fee),
      payoutPlatformFeeMinor: Number(row.payout_platform_fee),
      deltaMinor: Number(row.delta),
      unsettledOrders: Number(row.unsettled_orders),
    }));

    return {
      from: params.from.toISOString().slice(0, 10),
      to: params.to.toISOString().slice(0, 10),
      rows: mapped,
      totalDeltaMinor: mapped.reduce((sum, row) => sum + row.deltaMinor, 0),
      mismatchedDays: mapped.filter((row) => row.deltaMinor !== 0).length,
    };
  }

  private async requireSettleable(payoutId: string): Promise<{
    status: string;
    reference: string | null;
    netPayoutMinor: bigint;
  }> {
    const current = await this.prisma.merchantPayout.findUnique({
      where: { id: payoutId },
      select: { status: true, reference: true, netPayoutMinor: true },
    });
    if (!current) throw new AdminTargetNotFoundError('結算單', payoutId);
    if (!SETTLEABLE_STATUSES.includes(current.status)) {
      throw new PayoutNotSettleableError(payoutId, current.status);
    }
    return current;
  }

  private async merchantNames(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const merchants = await this.prisma.merchant.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(merchants.map((merchant) => [merchant.id, merchant.name]));
  }
}

function toPayoutView(row: {
  id: string;
  merchantId: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  grossSubtotalMinor: bigint;
  platformFeeMinor: bigint;
  paymentFeeMinor: bigint;
  netPayoutMinor: bigint;
  orderCount: number;
  reference: string | null;
  paidAt: Date | null;
  createdAt: Date;
  merchant: { name: string; slug: string } | null;
  _count: { lines: number };
}): AdminPayoutView {
  return {
    id: row.id,
    merchantId: row.merchantId,
    merchantName: row.merchant?.name ?? null,
    merchantSlug: row.merchant?.slug ?? null,
    status: row.status,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    currency: row.currency,
    grossSubtotalMinor: Number(row.grossSubtotalMinor),
    platformFeeMinor: Number(row.platformFeeMinor),
    paymentFeeMinor: Number(row.paymentFeeMinor),
    netPayoutMinor: Number(row.netPayoutMinor),
    orderCount: row.orderCount,
    lineCount: row._count.lines,
    reference: row.reference,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
