import { Injectable } from '@nestjs/common';
import {
  Prisma,
  RefundReasonCode as PrismaRefundReasonCode,
  RefundRequestStatus as PrismaRefundRequestStatus,
} from '@prisma/client';
import {
  RefundReasonCode,
  RefundRequestStatus,
  isActiveRefundRequestStatus,
} from '@takeout/domain';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  CreateRefundRequestData,
  CustomerRefundQuery,
  PersistedRefundRequest,
  RefundPage,
  RefundQueueQuery,
  RefundRepositoryPort,
  RefundRequestStatusPatch,
  RefundableOrder,
} from '../domain/refund.repository.port';

/** Domain enum <-> Prisma enum. Same string values, different TS types. */
const toPrismaStatus = (status: RefundRequestStatus): PrismaRefundRequestStatus =>
  status as unknown as PrismaRefundRequestStatus;
const fromPrismaStatus = (status: PrismaRefundRequestStatus): RefundRequestStatus =>
  status as unknown as RefundRequestStatus;
const toPrismaReason = (reason: RefundReasonCode): PrismaRefundReasonCode =>
  reason as unknown as PrismaRefundReasonCode;
const fromPrismaReason = (reason: PrismaRefundReasonCode): RefundReasonCode =>
  reason as unknown as RefundReasonCode;

/** The join every read view needs: the ticket plus its order's number and total. */
const WITH_ORDER = {
  order: {
    select: {
      orderNo: true,
      status: true,
      customerId: true,
      totalMinor: true,
      customer: { select: { displayName: true } },
    },
  },
} satisfies Prisma.RefundRequestInclude;

type RowWithOrder = Prisma.RefundRequestGetPayload<{ include: typeof WITH_ORDER }>;

/**
 * Prisma-backed refund tickets.
 *
 * The concurrency story mirrors the other two repositories deliberately: a
 * conditional `UPDATE` whose row count *is* the answer, rather than a
 * read-then-write that two requests can both pass.
 *
 * NOTE ON IDENTIFIERS: Prisma emits camelCase column names for any field
 * without an explicit `@map`, so hand-written SQL must quote them. Only table
 * names are snake_case, via `@@map`.
 *
 * NOTE ON SCOPE: this class has no `payment`, `payout` or provider access, and
 * it never will for this flow. A refund ticket records an agreement; it does
 * not move money. The platform is booking-only.
 */
@Injectable()
export class PrismaRefundRepository implements RefundRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findOrder(orderId: string): Promise<RefundableOrder | null> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNo: true,
        status: true,
        customerId: true,
        merchantId: true,
        totalMinor: true,
        currency: true,
      },
    });
    return order ?? null;
  }

  async findOpenForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<PersistedRefundRequest | null> {
    const row = await tx.refundRequest.findFirst({
      where: { orderId, status: { in: ACTIVE_PRISMA_STATUSES } },
      include: WITH_ORDER,
      orderBy: { createdAt: 'desc' },
    });
    return row ? toPersisted(row) : null;
  }

  async insert(
    tx: Prisma.TransactionClient,
    data: CreateRefundRequestData,
  ): Promise<PersistedRefundRequest> {
    const row = await tx.refundRequest.create({
      data: {
        orderId: data.orderId,
        merchantId: data.merchantId,
        customerId: data.customerId,
        status: toPrismaStatus(RefundRequestStatus.OPEN),
        reasonCode: toPrismaReason(data.reasonCode),
        requestedAmountMinor: data.requestedAmountMinor,
        orderTotalMinor: data.orderTotalMinor,
        customerNote: data.customerNote,
      },
      include: WITH_ORDER,
    });
    return toPersisted(row);
  }

  async findById(refundRequestId: string): Promise<PersistedRefundRequest | null> {
    const row = await this.prisma.refundRequest.findUnique({
      where: { id: refundRequestId },
      include: WITH_ORDER,
    });
    return row ? toPersisted(row) : null;
  }

  async findByIdForUpdate(
    tx: Prisma.TransactionClient,
    refundRequestId: string,
  ): Promise<PersistedRefundRequest | null> {
    const row = await tx.refundRequest.findUnique({
      where: { id: refundRequestId },
      include: WITH_ORDER,
    });
    return row ? toPersisted(row) : null;
  }

  async updateStatus(
    tx: Prisma.TransactionClient,
    refundRequestId: string,
    expectedStatus: RefundRequestStatus,
    nextStatus: RefundRequestStatus,
    patch: RefundRequestStatusPatch,
  ): Promise<boolean> {
    const result = await tx.refundRequest.updateMany({
      where: { id: refundRequestId, status: toPrismaStatus(expectedStatus) },
      data: {
        status: toPrismaStatus(nextStatus),
        version: { increment: 1 },
        // `!== undefined`, not truthiness: `null` is a real value here
        // ("clear the shop's note"), and a truthy check would keep the old one.
        ...(patch.merchantNote !== undefined ? { merchantNote: patch.merchantNote } : {}),
        ...(patch.settledAmountMinor !== undefined
          ? { settledAmountMinor: patch.settledAmountMinor }
          : {}),
        ...(patch.settlementReference !== undefined
          ? { settlementReference: patch.settlementReference }
          : {}),
        ...(patch.resolvedById !== undefined ? { resolvedById: patch.resolvedById } : {}),
        ...(patch.resolvedAt ? { resolvedAt: patch.resolvedAt } : {}),
        ...(patch.cancelledAt ? { cancelledAt: patch.cancelledAt } : {}),
      },
    });
    return result.count === 1;
  }

  async listForMerchant(query: RefundQueueQuery): Promise<RefundPage<PersistedRefundRequest>> {
    const where = {
      merchantId: query.merchantId,
      ...statusFilter(query.status),
    };
    const [rows, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where,
        include: WITH_ORDER,
        // Newest first: this is a work queue. The `[merchantId, status,
        // createdAt desc]` index covers exactly this read.
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.refundRequest.count({ where }),
    ]);
    return { data: rows.map(toPersisted), total };
  }

  async countByStatusForMerchant(
    merchantId: string,
  ): Promise<Readonly<Record<RefundRequestStatus, number>>> {
    const grouped = await this.prisma.refundRequest.groupBy({
      by: ['status'],
      where: { merchantId },
      _count: { _all: true },
    });

    // Start from a complete zeroed map rather than from the grouped rows: the
    // queue renders every tab, and a status with no tickets must show 0 rather
    // than being absent from the object (which reads as "unknown" in the UI).
    const counts = Object.fromEntries(
      Object.values(RefundRequestStatus).map((status) => [status, 0]),
    ) as Record<RefundRequestStatus, number>;

    for (const row of grouped) {
      counts[fromPrismaStatus(row.status)] = row._count._all;
    }
    return counts;
  }

  async listForCustomer(query: CustomerRefundQuery): Promise<RefundPage<PersistedRefundRequest>> {
    const where = { customerId: query.customerId };
    const [rows, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where,
        include: WITH_ORDER,
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        skip: query.offset,
      }),
      this.prisma.refundRequest.count({ where }),
    ]);
    return { data: rows.map(toPersisted), total };
  }

  async listForOrder(orderId: string): Promise<readonly PersistedRefundRequest[]> {
    const rows = await this.prisma.refundRequest.findMany({
      where: { orderId },
      include: WITH_ORDER,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPersisted);
  }

  async listAll(params: {
    status?: RefundRequestStatus | 'ACTIVE' | 'ALL';
    merchantId?: string;
    limit: number;
    offset: number;
  }): Promise<RefundPage<PersistedRefundRequest>> {
    const where = {
      ...(params.merchantId ? { merchantId: params.merchantId } : {}),
      ...statusFilter(params.status),
    };
    const [rows, total] = await Promise.all([
      this.prisma.refundRequest.findMany({
        where,
        include: WITH_ORDER,
        orderBy: { createdAt: 'desc' },
        take: params.limit,
        skip: params.offset,
      }),
      this.prisma.refundRequest.count({ where }),
    ]);
    return { data: rows.map(toPersisted), total };
  }
}

// ---------------------------------------------------------------------------

/**
 * The three filter shapes the callers ask for.
 *
 * `undefined` and `'ACTIVE'` both mean "the tickets somebody still has to work
 * on" — that is the useful default for a queue, and a bare `GET` should not
 * dump a year of resolved tickets. `'ALL'` is the explicit opt-in.
 */
function statusFilter(status?: RefundRequestStatus | 'ACTIVE' | 'ALL'): {
  status?: PrismaRefundRequestStatus | { in: PrismaRefundRequestStatus[] };
} {
  if (!status || status === 'ACTIVE') {
    return { status: { in: ACTIVE_PRISMA_STATUSES } };
  }
  if (status === 'ALL') return {};
  return { status: toPrismaStatus(status) };
}

const ACTIVE_PRISMA_STATUSES: PrismaRefundRequestStatus[] = Object.values(
  RefundRequestStatus,
)
  .filter(isActiveRefundRequestStatus)
  .map(toPrismaStatus);

/** One mapping point, so a new column is added in a single place. */
function toPersisted(row: RowWithOrder): PersistedRefundRequest {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.order.orderNo,
    orderStatus: row.order.status,
    merchantId: row.merchantId,
    customerId: row.customerId,
    customerName: row.order.customer?.displayName ?? '顧客',
    status: fromPrismaStatus(row.status),
    reasonCode: fromPrismaReason(row.reasonCode),
    requestedAmountMinor: row.requestedAmountMinor,
    orderTotalMinor: row.orderTotalMinor,
    customerNote: row.customerNote,
    merchantNote: row.merchantNote,
    settledAmountMinor: row.settledAmountMinor,
    settlementReference: row.settlementReference,
    resolvedById: row.resolvedById,
    resolvedAt: row.resolvedAt,
    cancelledAt: row.cancelledAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
