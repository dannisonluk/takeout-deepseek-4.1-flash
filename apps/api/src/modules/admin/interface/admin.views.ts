import { UserRole } from '@prisma/client';
import { OrderStatus } from '@takeout/domain';
import { MerchantAdminAction } from '../../merchants/domain/merchant-status.machine';
import {
  AnalyticsTierView,
  OwnedMerchantView,
} from '../../merchants/interface/merchant.views';
import { OrderLineView } from '../../ordering/interface/order.view';

/** Minimal user reference embedded in other admin views. */
export interface AdminUserBriefView {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface AdminUserView extends AdminUserBriefView {
  readonly role: UserRole;
  readonly isActive: boolean;
  readonly locale: string;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  /** Merchants this user owns. */
  readonly ownedMerchantCount: number;
  /** Merchants this user works for as staff. */
  readonly staffMerchantCount: number;
  readonly orderCount: number;
  /** Live refresh tokens — i.e. how many devices are signed in right now. */
  readonly activeSessionCount: number;
}

export interface AdminMerchantStatsView {
  readonly menuItems: number;
  readonly categories: number;
  readonly activeOrders: number;
  readonly totalOrders: number;
  /** Net payout not yet marked paid. */
  readonly pendingPayoutMinor: number;
  /** Gross subtotal across every order that reached COMPLETED. */
  readonly lifetimeGmvMinor: number;
}

/**
 * The full merchant record, as the platform sees it.
 *
 * Extends the owner's own projection rather than redefining it, so a field added
 * for the owner cannot be forgotten here. `isOwner` is dropped because it is
 * meaningless to an admin, who is never the owner.
 */
export interface AdminMerchantView extends Omit<OwnedMerchantView, 'isOwner'> {
  readonly createdAt: string;
  readonly owner: AdminUserBriefView | null;
  readonly stats: AdminMerchantStatsView;
  /**
   * Which lifecycle buttons to render. Served rather than derived in the
   * browser, so the console can never offer an action the API would reject.
   */
  readonly allowedActions: readonly MerchantAdminAction[];
  /**
   * 商戶營業報表 — what reporting plan this shop is on.
   *
   * Carried on the same projection the tier write returns, so the console's
   * select cannot disagree with the value the API just stored. The alternative
   * — a second read against `/merchant/:id/analytics` — would fail for a shop
   * on `NONE` for reasons the operator then has to interpret.
   */
  readonly analytics: AnalyticsTierView;
}

export interface AdminPaymentView {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly providerRef: string | null;
  readonly amountMinor: number;
  readonly processingFeeMinor: number;
  readonly currency: string;
  readonly failureCode: string | null;
  readonly authorizedAt: string | null;
  readonly capturedAt: string | null;
  readonly createdAt: string;
  readonly refundedMinor: number;
}

export interface AdminRefundView {
  readonly id: string;
  readonly paymentId: string;
  readonly amountMinor: number;
  readonly reason: string;
  readonly status: string;
  readonly providerRef: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

export interface AdminOrderEventView {
  readonly id: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actor: string;
  readonly actorName: string | null;
  readonly reason: string | null;
  readonly sideEffects: unknown;
  readonly createdAt: string;
}

/**
 * The admin's order view — the union of the customer's and the merchant's,
 * plus the audit trail. An admin is the only party that legitimately needs to
 * see both sides of a dispute at once.
 */
export interface AdminOrderView {
  readonly id: string;
  readonly orderNo: string;
  readonly pickupCode: string | null;
  readonly status: OrderStatus;
  readonly fulfilmentMode: string;
  readonly priority: string;
  readonly createdAt: string;
  readonly serviceDate: string;
  readonly scheduledPickupAt: string | null;
  readonly prepTimeMinutes: number;
  readonly acceptDeadlineAt: string | null;
  readonly acceptedAt: string | null;
  readonly readyAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;

  readonly currency: string;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
  readonly customerServiceFeeMinor: number;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly mainItemCount: number;
  /** The frozen pricing policy this order was priced with. */
  readonly pricingSnapshot: unknown;

  readonly customerNote: string | null;
  readonly contactPhone: string | null;

  readonly customer: AdminUserBriefView | null;
  readonly merchant: { id: string; slug: string; name: string } | null;
  readonly items: readonly OrderLineView[];
  readonly payments: readonly AdminPaymentView[];
  readonly refunds: readonly AdminRefundView[];
  readonly statusEvents: readonly AdminOrderEventView[];
  /** What an ADMIN actor may move this order to. Empty once terminal. */
  readonly allowedAdminTransitions: readonly OrderStatus[];
}

/**
 * The list projection.
 *
 * Deliberately not `AdminOrderView`: a queue of 25 orders should not drag every
 * line item, payment and status event across the wire. It carries the settled
 * totals instead, which is what an operator scans a list for.
 */
export interface AdminOrderSummaryView {
  readonly id: string;
  readonly orderNo: string;
  readonly pickupCode: string | null;
  readonly status: OrderStatus;
  readonly createdAt: string;
  readonly serviceDate: string;
  readonly scheduledPickupAt: string | null;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly mainItemCount: number;
  readonly itemCount: number;
  /** Captured so far, in minor units. */
  readonly paidMinor: number;
  /** Successfully refunded so far, in minor units. */
  readonly refundedMinor: number;
  readonly customer: AdminUserBriefView | null;
  readonly merchant: { id: string; slug: string; name: string } | null;
}

export interface AdminPayoutView {
  readonly id: string;
  readonly merchantId: string;
  readonly merchantName: string | null;
  readonly merchantSlug: string | null;
  readonly status: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly grossSubtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
  readonly netPayoutMinor: number;
  readonly orderCount: number;
  readonly lineCount: number;
  readonly reference: string | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
}

/**
 * One merchant-day where the platform fee on the orders and the fee on the
 * payout ledger disagree.
 *
 * A non-zero delta is a settlement bug, not a rounding curiosity — the two
 * figures are written from the same `pricingSnapshot`, so they can only diverge
 * if something failed partway. This is the screen that proves the platform's
 * own money maths is sound.
 */
export interface ReconciliationRowView {
  readonly merchantId: string;
  readonly merchantName: string | null;
  readonly serviceDate: string;
  readonly ordersPlatformFeeMinor: number;
  readonly payoutPlatformFeeMinor: number;
  readonly deltaMinor: number;
  readonly unsettledOrders: number;
}

export interface ReconciliationView {
  readonly from: string;
  readonly to: string;
  readonly rows: readonly ReconciliationRowView[];
  /** Sum of every delta in the window. `0` means the ledger agrees. */
  readonly totalDeltaMinor: number;
  readonly mismatchedDays: number;
}

export interface AdminOutboxEventView {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly version: number;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly availableAt: string;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface AdminOutboxStatsView {
  readonly byStatus: Record<string, number>;
  readonly oldestPendingAt: string | null;
  /** How long the oldest un-published event has been waiting. */
  readonly oldestPendingAgeSeconds: number | null;
  readonly deadLetterCount: number;
}

/** A `platform_config` row, with the layers that would apply without it. */
export interface PlatformConfigView {
  readonly key: string;
  /** The stored override, or `null` when the key is running on the fallback. */
  readonly value: unknown;
  readonly valueType: string;
  readonly description: string;
  /** True when a `platform_config` row exists for this key. */
  readonly hasOverride: boolean;
  /** `null` when the key has never been overridden. */
  readonly updatedAt: string | null;
  readonly updatedById: string | null;
  readonly updatedByName: string | null;
  /** True when the pricing engine consumes this key. */
  readonly isPricingKey: boolean;
  /** `pricing` or `cancellation` — which live policy consumes this key. */
  readonly namespace: string;
  /** What would apply if this row were deleted (environment, then code default). */
  readonly fallback: unknown;
  /** What is actually in force, read off the live policy. */
  readonly effectiveValue: unknown;
}

export interface PricingPolicyView {
  readonly platformFee: {
    readonly feePerMainItemMinor: number;
    readonly currency: string;
    readonly countAddOnItems: boolean;
  };
  readonly paymentFee: {
    readonly rateBps: number;
    readonly fixedMinor: number;
    readonly chargeOn: string;
  };
  readonly customerServiceFeeMinor: number;
  readonly minimumPayoutMinor: number;
  /** Which layer supplied the live policy. */
  readonly source: string;
}

export interface CancellationPolicyView {
  readonly graceMinutes: number;
  /** Refund ratio per `CancellationTier`, in basis points. */
  readonly refundBps: Readonly<Record<string, number>>;
  /** Which layer supplied the live policy. */
  readonly source: string;
}

/** One recorded write to `platform_config`. */
export interface PlatformConfigHistoryView {
  readonly id: string;
  readonly key: string;
  /** `UPSERT`, `DELETE` (override removed) or `ROLLBACK`. */
  readonly action: string;
  /** What the key held before this write. `null` means there was no row. */
  readonly previousValue: unknown;
  /** What it holds after. `null` means the row was removed. */
  readonly newValue: unknown;
  readonly description: string | null;
  readonly changedAt: string;
  readonly changedById: string | null;
  readonly changedByName: string | null;
}

export interface DashboardStatsView {
  readonly generatedAt: string;
  readonly merchants: {
    readonly total: number;
    readonly active: number;
    readonly pendingReview: number;
    readonly suspended: number;
    readonly closed: number;
    readonly acceptingOrders: number;
  };
  readonly orders: {
    readonly today: number;
    readonly todayGmvMinor: number;
    readonly todayPlatformFeeMinor: number;
    readonly todayPayoutMinor: number;
    readonly active: number;
    readonly byStatus: Record<string, number>;
  };
  readonly users: {
    readonly total: number;
    readonly customers: number;
    readonly merchantUsers: number;
    readonly admins: number;
    readonly disabled: number;
    readonly activeToday: number;
  };
  readonly payouts: {
    readonly pendingCount: number;
    readonly pendingNetMinor: number;
    readonly paidLast30DaysMinor: number;
  };
  readonly ops: {
    readonly outboxPending: number;
    readonly outboxFailed: number;
    readonly outboxDeadLetter: number;
    readonly redisConnected: boolean;
    /** Age of the oldest un-published event — `null` when the queue is empty. */
    readonly oldestPendingAt: string | null;
  };
  readonly pricing: PricingPolicyView;
}
