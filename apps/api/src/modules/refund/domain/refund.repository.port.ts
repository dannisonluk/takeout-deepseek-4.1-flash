import { Prisma } from '@prisma/client';
import {
  RefundReasonCode,
  RefundRequestActor,
  RefundRequestStatus,
} from '@takeout/domain';

/**
 * Persistence port for refund tickets.
 *
 * Same contract as the other two ports: the application layer depends on this
 * interface, and every mutating method takes the caller's
 * `Prisma.TransactionClient` so a use case owns the transactional boundary.
 *
 * **There is deliberately no method that touches `payments`, `payouts` or any
 * provider.** That absence is the feature. The platform is booking-only: this
 * flow records what the shop and the customer agreed, and never moves money.
 * If a future requirement needs the money path, it must be added here as an
 * obviously-named method that a reviewer will stop at — not smuggled into
 * `updateStatus`.
 */

/**
 * A ticket, plus the two facts about its order that every reader needs.
 *
 * Joined rather than looked up separately because the shop's queue renders the
 * order number and the amount at stake on every row; making the caller do a
 * second query per ticket would be an N+1 on the one screen that has the most
 * rows.
 */
export interface PersistedRefundRequest {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly orderStatus: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly status: RefundRequestStatus;
  readonly reasonCode: RefundReasonCode;
  readonly requestedAmountMinor: number | null;
  readonly orderTotalMinor: number;
  readonly customerNote: string | null;
  readonly merchantNote: string | null;
  readonly settledAmountMinor: number | null;
  readonly settlementReference: string | null;
  readonly resolvedById: string | null;
  readonly resolvedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The order, as the filing path must see it before it will create a ticket. */
export interface RefundableOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly status: string;
  readonly customerId: string;
  readonly merchantId: string;
  readonly totalMinor: number;
  readonly currency: string;
}

export interface CreateRefundRequestData {
  readonly orderId: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly reasonCode: RefundReasonCode;
  readonly requestedAmountMinor: number | null;
  readonly orderTotalMinor: number;
  readonly customerNote: string | null;
}

/** Fields a transition writes alongside the new status. */
export interface RefundRequestStatusPatch {
  readonly merchantNote?: string | null;
  readonly settledAmountMinor?: number | null;
  readonly settlementReference?: string | null;
  readonly resolvedById?: string | null;
  readonly resolvedAt?: Date;
  readonly cancelledAt?: Date;
}

export interface RefundQueueQuery {
  readonly merchantId: string;
  /** Defaults to active-only, which is what a work queue usually wants. */
  readonly status?: RefundRequestStatus | 'ACTIVE' | 'ALL';
  readonly limit: number;
  readonly offset: number;
}

export interface CustomerRefundQuery {
  readonly customerId: string;
  readonly limit: number;
  readonly offset: number;
}

export interface RefundPage<T> {
  readonly data: readonly T[];
  readonly total: number;
}

export interface RefundRepositoryPort {
  findOrder(orderId: string): Promise<RefundableOrder | null>;

  /**
   * The one-and-only-open rule, as a query.
   *
   * Checked inside the caller's transaction so two simultaneous filings cannot
   * both see "none open" and both insert.
   */
  findOpenForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<PersistedRefundRequest | null>;

  insert(
    tx: Prisma.TransactionClient,
    data: CreateRefundRequestData,
  ): Promise<PersistedRefundRequest>;

  findById(refundRequestId: string): Promise<PersistedRefundRequest | null>;

  /** Locking read for the transition path. */
  findByIdForUpdate(
    tx: Prisma.TransactionClient,
    refundRequestId: string,
  ): Promise<PersistedRefundRequest | null>;

  /**
   * Optimistic status change: `WHERE id = ? AND status = ?`.
   * Returns `false` when another writer got there first.
   *
   * Also bumps `version` — that counter is the outbox event version, and the
   * ticket row is the lifecycle record, so the bump happens here rather than in
   * a separate audit write a crash could skip.
   */
  updateStatus(
    tx: Prisma.TransactionClient,
    refundRequestId: string,
    expectedStatus: RefundRequestStatus,
    nextStatus: RefundRequestStatus,
    patch: RefundRequestStatusPatch,
  ): Promise<boolean>;

  /** The shop's queue. Newest first — a work queue, not a ledger. */
  listForMerchant(query: RefundQueueQuery): Promise<RefundPage<PersistedRefundRequest>>;

  /** Counts per status, for the queue's tabs. */
  countByStatusForMerchant(
    merchantId: string,
  ): Promise<Readonly<Record<RefundRequestStatus, number>>>;

  /** The customer's own tickets, newest first. */
  listForCustomer(query: CustomerRefundQuery): Promise<RefundPage<PersistedRefundRequest>>;

  /** All tickets on one order — used by the order detail view. */
  listForOrder(orderId: string): Promise<readonly PersistedRefundRequest[]>;

  /** Platform-wide view, read-only. */
  listAll(params: {
    status?: RefundRequestStatus | 'ACTIVE' | 'ALL';
    merchantId?: string;
    limit: number;
    offset: number;
  }): Promise<RefundPage<PersistedRefundRequest>>;
}

/** Re-exported so use cases can name the actor without a deep import. */
export type { RefundRequestActor };
