import { Prisma } from '@prisma/client';
import { OrderActor, OrderStatus, PaymentMode } from '@takeout/domain';

/** A menu item as the ordering flow needs to see it. */
export interface OrderableMenuItem {
  readonly id: string;
  readonly merchantId: string;
  readonly name: string;
  readonly imageKey: string | null;
  readonly priceMinor: number;
  readonly isMainItem: boolean;
  readonly availability: string;
  /** `null` when the item has no daily cap. */
  readonly remainingToday: number | null;
}

export interface OrderableMerchant {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly acceptsOrders: boolean;
  readonly autoAcceptOrders: boolean;
  readonly prepTimeMinutes: number;
  readonly pickupWindowMinutes: number;
  readonly acceptTimeoutMinutes: number;
}

/** Opening window for one weekday, in the merchant's local timezone. */
export interface OperatingHour {
  readonly dayOfWeek: number;
  readonly opensAtMinute: number;
  readonly closesAtMinute: number;
  readonly isClosed: boolean;
}

/** Row shape handed to the pricing engine. */
export interface OrderLineRequest {
  readonly menuItemId: string;
  readonly quantity: number;
}

export interface PersistedOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly pickupCode: string | null;
  readonly customerId: string;
  readonly merchantId: string;
  readonly status: OrderStatus;
  readonly paymentMode: PaymentMode;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly mainItemCount: number;
  /** The lead time quoted at placement — the default when a merchant confirms
   *  without naming a time of their own. */
  readonly prepTimeMinutes: number;
  readonly scheduledPickupAt: Date | null;
  /** The merchant's promise. `null` until they confirm the order. */
  readonly estimatedReadyAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly readyAt: Date | null;
  readonly completedAt: Date | null;
  readonly acceptDeadlineAt: Date | null;
  readonly pricingSnapshot: unknown;
  readonly updatedAt: Date;
}

export interface CreateOrderData {
  readonly orderNo: string;
  readonly pickupCode: string;
  /**
   * The caller's `Idempotency-Key`, when one was supplied.
   *
   * Persisted on the order row and protected by a UNIQUE index, so a replayed
   * submission is refused by the database and not only by the Redis lock in
   * front of it. `undefined` means the caller did not ask for idempotency —
   * the API only promises it when a key is present.
   */
  readonly idempotencyKey?: string;
  readonly customerId: string;
  readonly merchantId: string;
  readonly currency: string;
  readonly serviceDate: Date;
  readonly prepTimeMinutes: number;
  readonly paymentMode: PaymentMode;
  readonly scheduledPickupAt: Date | null;
  readonly acceptDeadlineAt: Date;
  readonly customerNote: string | null;
  readonly contactPhone: string | null;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
  readonly customerServiceFeeMinor: number;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly mainItemCount: number;
  readonly pricingSnapshot: Prisma.InputJsonValue;
  /**
   * 店內點餐 — the sitting this order belongs to, when it is a dine-in order.
   *
   * Null for every collection order, including all of Phase 1. Nullable rather
   * than defaulting to a sentinel session for exactly that reason: a sentinel
   * would have to exist as a row, and every "is this dine-in?" check would then
   * be comparing against it instead of against `null`.
   *
   * An in-store order is otherwise an ORDINARY order — same money, same
   * kitchen, same state machine. The session does not change how it is priced
   * or prepared; it only groups the several orders a table places across one
   * sitting and gives the kitchen ticket a table number to print.
   */
  readonly diningSessionId?: string | null;
  readonly items: readonly {
    menuItemId: string;
    nameSnapshot: string;
    imageKeySnapshot: string | null;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    isMainItem: boolean;
  }[];
}

/** Fields the state machine's side effects need written alongside the status. */
export interface OrderStatusPatch {
  readonly acceptedAt?: Date;
  /**
   * Recomputed when the order becomes `PAID`.
   *
   * The column is also written at placement, which is correct for a
   * pay-at-store order — the shop has to confirm receipt within the window and
   * the clock starts the moment the customer submits. For an online order the
   * clock must start when the **money lands**, not when the order was created:
   * an order placed at 12:00 and paid at 12:04 against a 5-minute timeout had
   * exactly one minute to be accepted before the sweeper expired it and
   * refunded the customer. That is what `PAID` rewrites here.
   */
  readonly acceptDeadlineAt?: Date;
  readonly readyAt?: Date;
  readonly completedAt?: Date;
  readonly cancelledAt?: Date;
  /**
   * The kitchen's promised ready time, written on the same `UPDATE` as the
   * `ACCEPTED` status.
   *
   * Same reasoning as `refundDueMinor`: a crash between "the merchant is told
   * the order is accepted" and "the customer is told when to come" would leave
   * an accepted order with no promise, and the customer page would fall back
   * to the pre-order estimate the merchant had just overridden.
   */
  readonly estimatedReadyAt?: Date;
  readonly readyInMinutes?: number;
  /** Kitchen's message to the customer. `null` clears a previous one. */
  readonly merchantNote?: string | null;
  /**
   * What `CancellationPolicyEngine` decided to return, in minor units.
   *
   * Written on the same `UPDATE` as the status, deliberately: if the decision
   * were stored separately, a crash between the two would leave an order that is
   * `CANCELLED` with no refund amount, and the reactor would fall back to
   * refunding everything — quietly overriding the policy.
   *
   * `null` means "no policy was consulted" (the reactor refunds the full
   * refundable balance); `0` means "the policy decided the customer gets
   * nothing", which is a different thing and must not be conflated with it.
   */
  readonly refundDueMinor?: number | null;
  /** The `CancellationTier` behind `refundDueMinor`, for the admin timeline. */
  readonly cancellationTier?: string | null;
}

export interface StatusEventRecord {
  readonly orderId: string;
  readonly fromStatus: OrderStatus;
  readonly toStatus: OrderStatus;
  readonly actor: OrderActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly sideEffects: readonly string[];
}

/**
 * Persistence port for the ordering aggregate.
 *
 * The application layer depends on this interface, never on Prisma. Every
 * mutating method takes the caller's `Prisma.TransactionClient`, so a use case
 * decides the transactional boundary and the repository cannot open its own.
 */
export interface OrderRepositoryPort {
  findMerchantForOrdering(merchantId: string): Promise<OrderableMerchant | null>;

  /**
   * The merchant's accept-timeout setting, read **regardless of status**.
   *
   * `findMerchantForOrdering` returns `null` for anything that is not ACTIVE,
   * which is right for placing an order and wrong for this: an order placed
   * before a suspension still has to be given a deadline when its payment
   * lands. `null` means "no such merchant" and the caller falls back to the
   * platform default.
   */
  findAcceptTimeoutMinutes(merchantId: string): Promise<number | null>;

  /** Opening hours, used to validate a requested pickup slot. */
  findOperatingHours(merchantId: string): Promise<readonly OperatingHour[]>;

  /**
   * The 特別休息日 (`YYYY-MM-DD`) a merchant has between two local dates, inclusive.
   *
   * A separate read from `findOperatingHours` rather than a field on it: the
   * weekly pattern is a fixed seven rows, while closures are a growable dated
   * list that must be windowed — folding them into one query would either drag
   * a shop's whole closure history into every order or force the hours read to
   * carry a date range it does not have. The write path and the slot generator
   * must both call this, or the app offers a time the order endpoint rejects.
   */
  findClosureDates(merchantId: string, from: string, to: string): Promise<readonly string[]>;

  findMenuItems(
    merchantId: string,
    menuItemIds: readonly string[],
    serviceDate: Date,
  ): Promise<OrderableMenuItem[]>;

  /** Allocate quota for the given lines. Returns `false` if any line is short. */
  holdDailyQuota(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
    lines: readonly { menuItemId: string; quantity: number }[],
  ): Promise<boolean>;

  /** Return held units to the pool (cancellation / expiry). */
  releaseDailyQuota(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
    lines: readonly { menuItemId: string; quantity: number }[],
  ): Promise<void>;

  /**
   * Move held units into `sold` — the units were produced and are not coming
   * back. Backs `OrderSideEffect.CONVERT_HOLD_TO_SOLD`.
   *
   * `GREATEST(..., 0)` on both columns for the same reason `releaseDailyQuota`
   * uses it: a retried transition must not be able to push either counter
   * negative, and the clamp keeps the failure visible in the numbers instead of
   * throwing inside a settlement transaction.
   */
  convertHoldToSold(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
    lines: readonly { menuItemId: string; quantity: number }[],
  ): Promise<void>;

  /** Monotonic per-merchant-per-day counter behind the pickup code. */
  nextPickupSequence(tx: Prisma.TransactionClient, merchantId: string, serviceDate: Date): Promise<number>;

  insertOrder(tx: Prisma.TransactionClient, data: CreateOrderData): Promise<PersistedOrder>;

  findById(orderId: string): Promise<PersistedOrder | null>;

  /** Locking read for the transition path. */
  findByIdForUpdate(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<PersistedOrder | null>;

  /**
   * Optimistic status change: `WHERE id = ? AND status = ?`.
   * Returns `false` when another writer got there first.
   */
  updateStatus(
    tx: Prisma.TransactionClient,
    orderId: string,
    expectedStatus: OrderStatus,
    nextStatus: OrderStatus,
    patch: OrderStatusPatch,
  ): Promise<boolean>;

  appendStatusEvent(tx: Prisma.TransactionClient, event: StatusEventRecord): Promise<void>;

  /**
   * Audit-trail length, used as the outbox `version`.
   *
   * MUST run on the caller's transaction client. Reading it through the plain
   * client would not see the status event this very transition just inserted —
   * that row is still uncommitted and lives on another connection — so the
   * version would lag by one and the first two events for an aggregate would
   * both claim version 1, defeating the monotonic counter consumers rely on to
   * detect out-of-order delivery.
   */
  countStatusEvents(tx: Prisma.TransactionClient, orderId: string): Promise<number>;

  /**
   * Everything the quota-release side effect needs, in one read.
   * `RELEASE_DAILY_QUOTA` fires on cancel/expire/reject, and the caller only
   * has the order id at that point.
   */
  findReleaseContext(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{
    readonly serviceDate: Date;
    readonly lines: readonly { menuItemId: string; quantity: number }[];
  } | null>;

  listOrderLines(orderId: string): Promise<
    readonly { menuItemId: string | null; nameSnapshot: string; quantity: number }[]
  >;

  /**
   * Append this order to its merchant's settlement batch.
   *
   * Backs the `RECORD_PAYOUT_LEDGER` side effect fired on COMPLETED / EXPIRED.
   * Idempotent per order — the batch is upserted and a duplicate line for the
   * same `orderId` is ignored — so a replayed transition cannot double-pay.
   */
  recordPayoutLedger(tx: Prisma.TransactionClient, orderId: string): Promise<void>;
}
