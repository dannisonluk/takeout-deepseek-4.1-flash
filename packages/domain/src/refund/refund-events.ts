import { RefundReasonCode, RefundRequestStatus } from './refund-status';

/**
 * Integration events for refund tickets, published through the same
 * transactional outbox as orders and reservations.
 *
 * Kept in its own file for the same reason as `reservation-events.ts`: a
 * consumer that handles `order.*` should not have to know that
 * `refund_request.*` exists, and `aggregateType` is what the relay partitions on.
 */
export enum RefundRequestEventType {
  REFUND_REQUEST_OPENED = 'refund_request.opened',
  REFUND_REQUEST_IN_DISCUSSION = 'refund_request.in_discussion',
  REFUND_REQUEST_RESOLVED_OFFLINE = 'refund_request.resolved_offline',
  REFUND_REQUEST_DECLINED = 'refund_request.declined',
  REFUND_REQUEST_CANCELLED = 'refund_request.cancelled',
}

/** Status -> event type. Keeps the mapping out of every consumer. */
export const REFUND_STATUS_EVENT: Readonly<
  Record<RefundRequestStatus, RefundRequestEventType>
> = {
  [RefundRequestStatus.OPEN]: RefundRequestEventType.REFUND_REQUEST_OPENED,
  [RefundRequestStatus.IN_DISCUSSION]: RefundRequestEventType.REFUND_REQUEST_IN_DISCUSSION,
  [RefundRequestStatus.RESOLVED_OFFLINE]:
    RefundRequestEventType.REFUND_REQUEST_RESOLVED_OFFLINE,
  [RefundRequestStatus.DECLINED]: RefundRequestEventType.REFUND_REQUEST_DECLINED,
  [RefundRequestStatus.CANCELLED]: RefundRequestEventType.REFUND_REQUEST_CANCELLED,
};

/**
 * Denormalised projection embedded in every refund event.
 *
 * Carries the order number and the reason label, because every consumer that
 * matters — the shop's queue, the customer's notification — renders those and
 * nothing else. Making them re-query the row for it would mean a ticket event
 * that cannot be rendered on its own.
 */
export interface RefundRequestEventPayload {
  readonly refundRequestId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly status: RefundRequestStatus;
  readonly reasonCode: RefundReasonCode;
  readonly requestedAmountMinor: number | null;
}

export interface RefundRequestDomainEvent {
  readonly eventId: string;
  readonly type: RefundRequestEventType;
  readonly aggregateType: 'RefundRequest';
  readonly aggregateId: string;
  readonly version: number;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  readonly payload: RefundRequestEventPayload;
}

/** Socket.IO room names — one room per ticket, one per merchant queue. */
export const refundRequestRoom = (refundRequestId: string): string =>
  `refund_request:${refundRequestId}`;
export const merchantRefundQueueRoom = (merchantId: string): string =>
  `merchant-refunds:${merchantId}`;
