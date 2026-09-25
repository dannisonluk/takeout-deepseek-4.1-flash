import { RefundReasonCode, RefundRequestStatus } from '@takeout/domain';
import { PersistedRefundRequest } from '../domain/refund.repository.port';

/**
 * A refund ticket, as the customer sees it.
 *
 * Carries no merchant-internal fields and no `resolvedById`. The customer sees
 * their own ask, the shop's reply, and what the shop says it handed over.
 *
 * `settledAmountMinor` and `settlementReference` are **claims the shop made**.
 * The platform did not verify them and did not process them — the UI must not
 * render them as "refunded by the platform".
 */
export interface CustomerRefundRequestView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly merchantId: string;
  readonly status: RefundRequestStatus;
  readonly reasonCode: RefundReasonCode;
  readonly requestedAmountMinor: number | null;
  readonly orderTotalMinor: number;
  readonly currency: string;
  readonly customerNote: string | null;
  readonly merchantNote: string | null;
  readonly settledAmountMinor: number | null;
  readonly settlementReference: string | null;
  readonly resolvedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** What this customer may do next — the withdraw button, or nothing. */
  readonly allowedNextTransitions: readonly RefundRequestStatus[];
}

/**
 * A refund ticket, as the shop sees it.
 *
 * Adds the customer's display name (the shop has to know who it is talking to)
 * and nothing else. There is deliberately no "unread" flag and no assignment:
 * a ticket queue one person works does not need either, and both would need a
 * read-receipt model the platform has no use for.
 */
export interface MerchantRefundRequestView extends CustomerRefundRequestView {
  readonly customerId: string;
  readonly customerName: string;
  readonly orderStatus: string;
  readonly version: number;
}

/** A page of tickets plus the per-status counts that drive the queue's tabs. */
export interface MerchantRefundQueueView {
  readonly data: readonly MerchantRefundRequestView[];
  readonly total: number;
  readonly counts: Readonly<Record<RefundRequestStatus, number>>;
}

export interface CustomerRefundPageView {
  readonly data: readonly CustomerRefundRequestView[];
  readonly total: number;
}

export interface AdminRefundPageView {
  readonly data: readonly MerchantRefundRequestView[];
  readonly total: number;
}

/**
 * The result of a status change.
 *
 * `refundRequest` is the ticket **after** the move, so the caller does not have
 * to fetch it again. The field is `refundRequestId` rather than `id` because
 * the controller spreads the use case's result rather than re-mapping it —
 * `ReservationTransitionView` got this wrong once and nothing caught it.
 */
export interface RefundTransitionView {
  readonly refundRequestId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly fromStatus: RefundRequestStatus;
  readonly toStatus: RefundRequestStatus;
  readonly occurredAt: Date;
  readonly sideEffects: readonly string[];
  readonly allowedNextTransitions: readonly RefundRequestStatus[];
  readonly refundRequest: MerchantRefundRequestView;
}

/**
 * The result of a status change, as the customer sees it.
 *
 * Same shape as `RefundTransitionView` but carrying the customer projection —
 * a customer endpoint must not answer with the merchant's view of their own
 * ticket, even though the extra fields happen to be harmless.
 */
export interface CustomerRefundTransitionView {
  readonly refundRequestId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly fromStatus: RefundRequestStatus;
  readonly toStatus: RefundRequestStatus;
  readonly occurredAt: Date;
  readonly sideEffects: readonly string[];
  readonly allowedNextTransitions: readonly RefundRequestStatus[];
  readonly refundRequest: CustomerRefundRequestView;
}

/** Shared projection so the two views cannot drift apart. */
export function toCustomerRefundView(
  row: PersistedRefundRequest,
  allowedNextTransitions: readonly RefundRequestStatus[],
  currency = 'HKD',
): CustomerRefundRequestView {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNo: row.orderNo,
    merchantId: row.merchantId,
    status: row.status,
    reasonCode: row.reasonCode,
    requestedAmountMinor: row.requestedAmountMinor,
    orderTotalMinor: row.orderTotalMinor,
    currency,
    customerNote: row.customerNote,
    merchantNote: row.merchantNote,
    settledAmountMinor: row.settledAmountMinor,
    settlementReference: row.settlementReference,
    resolvedAt: row.resolvedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    allowedNextTransitions,
  };
}

export function toMerchantRefundView(
  row: PersistedRefundRequest,
  allowedNextTransitions: readonly RefundRequestStatus[],
  currency = 'HKD',
): MerchantRefundRequestView {
  return {
    ...toCustomerRefundView(row, allowedNextTransitions, currency),
    customerId: row.customerId,
    customerName: row.customerName,
    orderStatus: row.orderStatus,
    version: row.version,
  };
}
