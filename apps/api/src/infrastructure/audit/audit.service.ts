import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  readonly actorId?: string | null;
  /** Denormalised so the trail still reads correctly after a role change. */
  readonly actorRole?: string | null;
  /** `resource.verb`, e.g. `platform_config.update`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | null;
}

export interface AuditLogView {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly actorRole: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly createdAt: string;
}

/**
 * Append-only audit trail for privileged mutations.
 *
 * The `tx` argument is the important part of the design. Pass the caller's
 * transaction and the audit row commits or rolls back **with** the change it
 * describes — so "the fee was changed but nobody recorded who changed it" is
 * impossible. Omit it and a failure is logged rather than thrown, which is the
 * right trade-off for best-effort events like a login.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const data = {
      actorId: entry.actorId ?? null,
      actorRole: entry.actorRole ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      before: (entry.before ?? null) as Prisma.InputJsonValue,
      after: (entry.after ?? null) as Prisma.InputJsonValue,
      ip: entry.ip ?? null,
    };

    if (tx) {
      // Inside a transaction: propagate. An unaudited privileged change must not
      // be allowed to commit.
      await tx.auditLog.create({ data });
      return;
    }

    try {
      await this.prisma.auditLog.create({ data });
    } catch (error) {
      this.logger.error(
        `Could not write audit row for ${entry.action}: ${(error as Error).message}`,
      );
    }
  }

  async list(params: {
    limit: number;
    offset?: number;
    cursor?: string;
    actorId?: string;
    targetType?: string;
    action?: string;
  }): Promise<{ data: AuditLogView[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.targetType ? { targetType: params.targetType } : {}),
      // A substring match: operators search for "platform_config" and expect
      // both the update and the delete.
      ...(params.action ? { action: { contains: params.action } } : {}),
      ...(params.cursor ? { createdAt: { lt: new Date(params.cursor) } } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset ?? 0,
        include: { actor: { select: { displayName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        actorId: row.actorId,
        actorName: row.actor?.displayName ?? null,
        actorRole: row.actorRole,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        before: row.before,
        after: row.after,
        ip: row.ip,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
    };
  }
}

@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
