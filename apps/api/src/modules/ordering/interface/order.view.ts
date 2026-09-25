import { OrderStatus } from '@takeout/domain';
import { PickupNotice } from '../domain/pickup-notice';

/** Line as returned by the read models. */
export interface OrderLineView {
  readonly menuItemId: string | null;
  readonly nameSnapshot: string;
  readonly imageKeySnapshot: string | null;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly lineTotalMinor: number;
  readonly isMainItem: boolean;
}

/**
 * One refund ticket, as an order's detail page needs it.
 *
 * A summary, not the full ticket: the order page only has to decide whether to
 * offer the 「申請退款」 button, whether one is already open, and whether to link
 * to the history. Rendering the whole conversation here would duplicate
 * `/refund-requests/:id`, which is where a ticket actually lives.
 *
 * `settledAmountMinor` / `settlementReference` are deliberately absent — this
 * projection is not where a settlement is shown, and including them invites a
 * second, subtly different rendering of a claim the platform never verified.
 */
export interface OrderRefundSummaryView {
  readonly id: string;
  readonly status: string;
  readonly reasonCode: string;
  readonly requestedAmountMinor: number | null;
  readonly createdAt: string;
}

/** The customer-facing projection. Commission split is deliberately absent. */
export interface CustomerOrderView {
  readonly id: string;
  readonly orderNo: string;
  readonly pickupCode: string | null;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantSlug: string;
  readonly merchantTimezone: string;
  readonly status: OrderStatus;
  readonly fulfilmentMode: string;
  /** `ONLINE` | `PAY_AT_STORE` — decides what the customer is told to do. */
  readonly paymentMode: string;
  /** What the customer asked for. `null` = 即時製作. */
  readonly scheduledPickupAt: string | null;
  /**
   * What the merchant promised. `null` until they confirm — deliberately a
   * separate field from `scheduledPickupAt`, because "I asked for 18:30" and
   * "the kitchen will have it ready at 18:45" are different facts and a UI
   * that conflates them lies to somebody.
   */
  readonly estimatedReadyAt: string | null;
  readonly readyInMinutes: number | null;
  /** Free-text message from the kitchen. Shown verbatim. */
  readonly merchantNote: string | null;
  /** The one sentence to show next to the status. `null` when nothing applies. */
  readonly pickupNotice: PickupNotice | null;
  readonly createdAt: string;
  readonly items: readonly OrderLineView[];
  readonly totalMinor: number;
  readonly currency: string;
  readonly customerNote: string | null;
  /**
   * Every refund ticket filed against this order, newest first.
   *
   * Present so the order page can offer 「申請退款」 without a second request,
   * and so it can tell "no ticket yet" from "one is already open" — the latter
   * must NOT show a button, because filing again is a 409 the customer would
   * read as a bug.
   */
  readonly refundRequests: readonly OrderRefundSummaryView[];
}

/**
 * The merchant-facing projection — includes the money split, because the
 * merchant is the party being settled.
 */
export interface MerchantOrderView extends CustomerOrderView {
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentFeeMinor: number;
  readonly merchantPayoutMinor: number;
  readonly mainItemCount: number;
  readonly acceptDeadlineAt: string | null;
  readonly acceptedAt: string | null;
  readonly readyAt: string | null;
  readonly completedAt: string | null;
}

/** The creation response, mirroring `POST /orders` in docs/API.md. */
export interface OrderCreatedView {
  readonly id: string;
  readonly orderNo: string;
  readonly pickupCode: string;
  readonly status: OrderStatus;
  readonly paymentMode: string;
  readonly scheduledPickupAt: string | null;
  /**
   * The pre-order estimate — the kitchen's lead time, not a promise. It is
   * what the checkout page shows the moment the order lands; the merchant's
   * own `estimatedReadyAt` supersedes it on confirmation.
   */
  readonly estimatedReadyAt: string;
  readonly pickupNotice: PickupNotice | null;
  readonly currency: string;
  readonly items: readonly OrderLineView[];
  readonly pricing: {
    readonly mainItemCount: number;
    readonly subtotalMinor: number;
    readonly platformFeeMinor: number;
    readonly paymentProcessingFeeMinor: number;
    readonly customerServiceFeeMinor: number;
    readonly totalMinor: number;
    readonly merchantPayoutMinor: number;
  };
}
