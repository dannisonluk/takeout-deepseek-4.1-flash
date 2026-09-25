/**
 * 退款申請工單 — the vocabulary.
 *
 * This is a **ticket**, not a payment operation. The platform is a booking-only
 * product: it never captures the customer's money and it will never hand any
 * back. A refund request exists so the customer has a way to raise the problem
 * through the product they bought from, and so the shop has a queue to work
 * through — after that, the shop and the customer settle it between themselves.
 *
 * That single decision is why there is no `REFUNDED` status here and why
 * `RESOLVED_OFFLINE` is named the way it is. If this enum ever grows a state
 * that implies the platform moved money, the boundary has been crossed.
 */

export enum RefundRequestStatus {
  /** The customer filed it. The shop has not looked yet. */
  OPEN = 'OPEN',
  /** The shop has replied and the two sides are talking. */
  IN_DISCUSSION = 'IN_DISCUSSION',
  /**
   * The shop says it handed something back outside the platform.
   *
   * Recorded, never verified. The platform has no way to check it and must not
   * pretend otherwise — nobody may render this as "refunded by the platform".
   */
  RESOLVED_OFFLINE = 'RESOLVED_OFFLINE',
  /** The shop will not refund. */
  DECLINED = 'DECLINED',
  /** The customer withdrew it. */
  CANCELLED = 'CANCELLED',
}

export enum RefundRequestActor {
  CUSTOMER = 'CUSTOMER',
  MERCHANT = 'MERCHANT',
  ADMIN = 'ADMIN',
}

/**
 * Why the customer is asking.
 *
 * A closed list rather than free text, because the shop needs to triage a queue
 * and "OTHER" plus a note is a different thing from fifty spellings of "cold".
 */
export enum RefundReasonCode {
  NEVER_RECEIVED = 'NEVER_RECEIVED',
  WRONG_ITEM = 'WRONG_ITEM',
  QUALITY = 'QUALITY',
  LATE = 'LATE',
  DUPLICATE_CHARGE = 'DUPLICATE_CHARGE',
  OTHER = 'OTHER',
}

/** Nobody is going to work on this ticket again. */
const TERMINAL: readonly RefundRequestStatus[] = [
  RefundRequestStatus.RESOLVED_OFFLINE,
  RefundRequestStatus.DECLINED,
  RefundRequestStatus.CANCELLED,
];

/**
 * The ticket is still somebody's job.
 *
 * This is what the shop's queue filters on and what the "one open request per
 * order" rule counts — a customer may file a fresh request after a resolution,
 * but not while one is being worked.
 */
const ACTIVE: readonly RefundRequestStatus[] = [
  RefundRequestStatus.OPEN,
  RefundRequestStatus.IN_DISCUSSION,
];

export function isTerminalRefundRequestStatus(status: RefundRequestStatus): boolean {
  return TERMINAL.includes(status);
}

export function isActiveRefundRequestStatus(status: RefundRequestStatus): boolean {
  return ACTIVE.includes(status);
}

/** Human-facing label for the reason, used by both the shop queue and the customer's own view. */
export const REFUND_REASON_LABEL: Readonly<Record<RefundReasonCode, string>> = {
  [RefundReasonCode.NEVER_RECEIVED]: '沒有收到餐點',
  [RefundReasonCode.WRONG_ITEM]: '餐點與訂單不符',
  [RefundReasonCode.QUALITY]: '餐點品質有問題',
  [RefundReasonCode.LATE]: '等候過久',
  [RefundReasonCode.DUPLICATE_CHARGE]: '重複收費',
  [RefundReasonCode.OTHER]: '其他原因',
};

/** Human-facing label for the status, so no consumer invents its own wording. */
export const REFUND_STATUS_LABEL: Readonly<Record<RefundRequestStatus, string>> = {
  [RefundRequestStatus.OPEN]: '待店家處理',
  [RefundRequestStatus.IN_DISCUSSION]: '商議中',
  [RefundRequestStatus.RESOLVED_OFFLINE]: '店家已線下處理',
  [RefundRequestStatus.DECLINED]: '店家拒絕',
  [RefundRequestStatus.CANCELLED]: '已撤回',
};

/**
 * Which order statuses may carry a refund request at all.
 *
 * Deliberately broad — anything from a captured payment onwards. The platform
 * cannot judge whether a complaint is valid, so it does not try; the only thing
 * it refuses is filing against an order that was never paid for, because there
 * is nothing to ask for.
 */
const REFUNDABLE_ORDER_STATUSES: readonly string[] = [
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'COMPLETED',
  'REJECTED',
  'REFUNDED',
];

export function isOrderRefundRequestable(orderStatus: string): boolean {
  return REFUNDABLE_ORDER_STATUSES.includes(orderStatus);
}
