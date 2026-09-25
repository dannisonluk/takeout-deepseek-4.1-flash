/**
 * Order lifecycle.
 *
 * ```
 * PENDING_PAYMENT ──▶ PAID ──▶ ACCEPTED ──▶ PREPARING ──▶ READY_FOR_PICKUP ──▶ COMPLETED
 *        │             │         │            │                │
 *        │             ├──▶ REJECTED ─────────┴──▶ REFUNDED ◀──┘
 *        ├──▶ EXPIRED  ├──▶ CANCELLED ──▶ REFUNDED
 *        └──▶ CANCELLED└──▶ EXPIRED
 * ```
 *
 * `REJECTED` is deliberately **not** terminal: a rejected order was already paid,
 * so it must pass through `REFUNDED` before it can be closed.
 */
export enum OrderStatus {
  /** Created, awaiting payment authorisation. Stock is soft-held. */
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  /** Payment captured. The merchant's accept window is now running. */
  PAID = 'PAID',
  /** Merchant confirmed they will fulfil it. */
  ACCEPTED = 'ACCEPTED',
  /** Kitchen is cooking. */
  PREPARING = 'PREPARING',
  /** Waiting at the counter. The pickup window timer is now running. */
  READY_FOR_PICKUP = 'READY_FOR_PICKUP',
  /** Customer collected it. Triggers the payout ledger entry. */
  COMPLETED = 'COMPLETED',
  /** Merchant declined to fulfil. */
  REJECTED = 'REJECTED',
  /** Cancelled by customer, merchant, or system before it was collected. */
  CANCELLED = 'CANCELLED',
  /** Merchant never accepted in time, or the pickup window lapsed. */
  EXPIRED = 'EXPIRED',
  /** Money returned to the customer. */
  REFUNDED = 'REFUNDED',
}

/** Who is driving the transition. Authorisation lives in the transition table. */
export enum OrderActor {
  CUSTOMER = 'CUSTOMER',
  MERCHANT = 'MERCHANT',
  /** Timers, payment webhooks, schedulers. */
  SYSTEM = 'SYSTEM',
  /** Support / operations staff overriding the normal flow. */
  ADMIN = 'ADMIN',
}

/**
 * How the money is meant to arrive.
 *
 * This is a property of the **order**, not of the payment rail, because it
 * decides *who is allowed to advance the order out of `PENDING_PAYMENT`*:
 * an online order is settled by a signed webhook (`SYSTEM`), a pay-at-store
 * order by the merchant who took the cash (`MERCHANT`). Encoding it here keeps
 * that rule in the transition table instead of in a controller.
 */
export enum PaymentMode {
  ONLINE = 'ONLINE',
  PAY_AT_STORE = 'PAY_AT_STORE',
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.COMPLETED,
  OrderStatus.EXPIRED,
  OrderStatus.REFUNDED,
]);

/** Statuses a merchant should see on the live kitchen board. */
const ACTIVE: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.PAID,
  OrderStatus.ACCEPTED,
  OrderStatus.PREPARING,
  OrderStatus.READY_FOR_PICKUP,
]);

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

export function isActiveStatus(status: OrderStatus): boolean {
  return ACTIVE.has(status);
}

/** Display labels for the merchant app and the customer order-tracking page. */
export const ORDER_STATUS_LABEL_ZH_HK: Readonly<Record<OrderStatus, string>> = {
  [OrderStatus.PENDING_PAYMENT]: '待付款',
  [OrderStatus.PAID]: '待商戶接單',
  [OrderStatus.ACCEPTED]: '已接單',
  [OrderStatus.PREPARING]: '製作中',
  [OrderStatus.READY_FOR_PICKUP]: '可取餐',
  [OrderStatus.COMPLETED]: '已完成',
  [OrderStatus.REJECTED]: '商戶已拒單',
  [OrderStatus.CANCELLED]: '已取消',
  [OrderStatus.EXPIRED]: '已逾時',
  [OrderStatus.REFUNDED]: '已退款',
};
