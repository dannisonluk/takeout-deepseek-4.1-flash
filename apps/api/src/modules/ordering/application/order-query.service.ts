import { Inject, Injectable } from '@nestjs/common';
import {
  CancellationQuote,
  OrderActor,
  OrderStateMachine,
  OrderStatus,
  PaymentMode,
} from '@takeout/domain';
import { ORDER_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { PricingConfigService } from '../../pricing/pricing.module';
import { buildPickupNotice } from '../domain/pickup-notice';
import { CustomerOrderView, MerchantOrderView, OrderLineView } from '../interface/order.view';

/** What a customer would get back if they cancelled right now. */
export interface CancellationQuoteView {
  readonly orderId: string;
  /**
   * Whether the state machine would even allow it. `false` means the button
   * should be absent, not disabled — the food is already being made.
   */
  readonly cancellable: boolean;
  /** `null` when nothing was captured yet. */
  readonly refundMinor: number | null;
  readonly refundFormatted: string | null;
  readonly retainedMinor: number | null;
  /** Refund ratio in basis points. `null` when there is nothing to refund. */
  readonly refundBps: number | null;
  /** `CancellationTier`, for the UI to pick a wording. `null` when not cancellable. */
  readonly tier: string | null;
  /** One sentence explaining the number, safe to show verbatim. */
  readonly reason: string;
}

/**
 * Read side.
 *
 * Queries deliberately do NOT go through `OrderRepositoryPort` — they never need
 * the aggregate's invariants, and coupling a list endpoint to the write model
 * would drag `pricingSnapshot` blobs into a kitchen-board poll. This is the
 * CQRS split in miniature: one write model, purpose-built read models.
 */
@Injectable()
export class OrderQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingConfigService,
    @Inject(ORDER_STATE_MACHINE) private readonly stateMachine: OrderStateMachine,
  ) {}

  async listForMerchant(params: {
    merchantId: string;
    statuses: readonly OrderStatus[];
    limit: number;
    cursor?: string;
    /**
     * Include `PENDING_PAYMENT` orders placed to be paid at the counter.
     *
     * Those orders are not "active" by the lifecycle's definition — no money
     * has moved — but they are absolutely work for the merchant: somebody is
     * standing at the counter and the shop has to confirm receipt. Leaving
     * them off the board is how a pay-at-store order gets silently forgotten.
     * The kitchen board turns this on; the merchant dashboard does not.
     */
    includeAwaitingSettlement?: boolean;
  }): Promise<MerchantOrderView[]> {
    const awaitingSettlement = params.includeAwaitingSettlement
      ? [
          {
            status: OrderStatus.PENDING_PAYMENT as unknown as never,
            paymentMode: 'PAY_AT_STORE' as never,
          },
        ]
      : [];

    const rows = await this.prisma.order.findMany({
      where: {
        merchantId: params.merchantId,
        ...(params.statuses.length > 0 || awaitingSettlement.length > 0
          ? {
              OR: [
                ...(params.statuses.length > 0
                  ? [{ status: { in: params.statuses as unknown as never[] } }]
                  : []),
                ...awaitingSettlement,
              ],
            }
          : {}),
        ...(params.cursor ? { createdAt: { lt: new Date(params.cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      select: merchantOrderSelect,
    });

    return rows.map((row) => this.toMerchantView(row));
  }

  async getForMerchant(merchantId: string, orderId: string): Promise<MerchantOrderView | null> {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, merchantId },
      select: merchantOrderSelect,
    });
    return row ? this.toMerchantView(row) : null;
  }

  async listForCustomer(params: {
    customerId: string;
    statuses: readonly OrderStatus[];
    limit: number;
    cursor?: string;
  }): Promise<CustomerOrderView[]> {
    const rows = await this.prisma.order.findMany({
      where: {
        customerId: params.customerId,
        ...(params.statuses.length > 0
          ? { status: { in: params.statuses as unknown as never[] } }
          : {}),
        ...(params.cursor ? { createdAt: { lt: new Date(params.cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      select: customerOrderSelect,
    });

    return rows.map((row) => this.toCustomerView(row));
  }

  async getForCustomer(customerId: string, orderId: string): Promise<CustomerOrderView | null> {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: customerOrderSelect,
    });
    return row ? this.toCustomerView(row) : null;
  }

  /**
   * "If I cancel now, what do I get back?"
   *
   * The same two decisions the cancel endpoint will make, answered in advance:
   * `OrderStateMachine` says whether the transition is allowed, and
   * `CancellationPolicyEngine` says what it costs. Deriving both from the same
   * objects the write path uses is the whole point — a quote that disagreed with
   * the actual refund would be worse than showing nothing.
   *
   * Read-only and side-effect free, so it is safe to call on every page render.
   * Returns `null` only when the order is not this customer's.
   */
  async cancellationQuoteForCustomer(
    customerId: string,
    orderId: string,
  ): Promise<CancellationQuoteView | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: {
        id: true,
        status: true,
        totalMinor: true,
        currency: true,
        acceptedAt: true,
        payments: {
          where: { status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
          orderBy: { capturedAt: 'desc' },
          take: 1,
          select: { amountMinor: true },
        },
      },
    });
    if (!order) return null;

    const from = order.status as unknown as OrderStatus;
    const capturedMinor = order.payments[0]?.amountMinor ?? 0;

    const cancellable = this.stateMachine.can(from, OrderStatus.CANCELLED, OrderActor.CUSTOMER);
    if (!cancellable || capturedMinor <= 0) {
      return {
        orderId: order.id,
        cancellable,
        refundMinor: null,
        refundFormatted: null,
        retainedMinor: null,
        refundBps: null,
        tier: null,
        reason: cancellable
          ? '尚未付款，取消訂單不會產生任何費用。'
          : '訂單已進入製作流程，無法由顧客取消。如遇特殊情況請聯絡客服。',
      };
    }

    const quote: CancellationQuote = this.pricing.quoteCancellation({
      orderId: order.id,
      from,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.CUSTOMER,
      paidAmountMinor: capturedMinor,
      currency: order.currency as 'HKD' | 'CNY' | 'USD',
      acceptedAt: order.acceptedAt,
      now: new Date(),
    });

    return {
      orderId: order.id,
      cancellable: true,
      refundMinor: quote.refund.minor,
      refundFormatted: quote.refund.format(),
      retainedMinor: quote.retained.minor,
      refundBps: quote.refundBps,
      tier: quote.tier,
      reason: quote.reason,
    };
  }

  private toMerchantView(row: MerchantOrderRow): MerchantOrderView {
    return {
      ...this.toCustomerView(row),
      subtotalMinor: row.subtotalMinor,
      platformFeeMinor: row.platformFeeMinor,
      paymentFeeMinor: row.paymentFeeMinor,
      merchantPayoutMinor: row.merchantPayoutMinor,
      mainItemCount: row.mainItemCount,
      acceptDeadlineAt: row.acceptDeadlineAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      readyAt: row.readyAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toCustomerView(row: CustomerOrderRow): CustomerOrderView {
    const status = row.status as unknown as OrderStatus;
    const paymentMode = row.paymentMode as unknown as PaymentMode;

    return {
      id: row.id,
      orderNo: row.orderNo,
      pickupCode: row.pickupCode,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      merchantSlug: row.merchant.slug,
      merchantTimezone: row.merchant.timezone,
      status,
      fulfilmentMode: row.fulfilmentMode,
      paymentMode: row.paymentMode,
      scheduledPickupAt: row.scheduledPickupAt?.toISOString() ?? null,
      estimatedReadyAt: row.estimatedReadyAt?.toISOString() ?? null,
      readyInMinutes: row.readyInMinutes,
      merchantNote: row.merchantNote,
      pickupNotice: buildPickupNotice({
        status,
        paymentMode,
        scheduledPickupAt: row.scheduledPickupAt,
        estimatedReadyAt: row.estimatedReadyAt,
        readyAt: row.readyAt,
        acceptDeadlineAt: row.acceptDeadlineAt,
        pickupWindowMinutes: row.merchant.pickupWindowMinutes,
        pickupCode: row.pickupCode,
        totalMinor: row.totalMinor,
        currency: row.currency,
        timeZone: row.merchant.timezone,
        now: new Date(),
      }),
      createdAt: row.createdAt.toISOString(),
      items: row.items.map(
        (item): OrderLineView => ({
          menuItemId: item.menuItemId,
          nameSnapshot: item.nameSnapshot,
          imageKeySnapshot: item.imageKeySnapshot,
          unitPriceMinor: item.unitPriceMinor,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
          isMainItem: item.isMainItem,
        }),
      ),
      totalMinor: row.totalMinor,
      currency: row.currency,
      customerNote: row.customerNote,
      refundRequests: row.refundRequests.map((ticket) => ({
        id: ticket.id,
        status: ticket.status,
        reasonCode: ticket.reasonCode,
        requestedAmountMinor: ticket.requestedAmountMinor,
        createdAt: ticket.createdAt.toISOString(),
      })),
    };
  }
}

const lineSelect = {
  menuItemId: true,
  nameSnapshot: true,
  imageKeySnapshot: true,
  unitPriceMinor: true,
  quantity: true,
  lineTotalMinor: true,
  isMainItem: true,
} as const;

const customerOrderSelect = {
  id: true,
  orderNo: true,
  pickupCode: true,
  merchantId: true,
  status: true,
  fulfilmentMode: true,
  paymentMode: true,
  scheduledPickupAt: true,
  estimatedReadyAt: true,
  readyInMinutes: true,
  merchantNote: true,
  // Read (not written) on the customer projection: the pickup notice needs the
  // payment deadline and the ready timestamp to say "collect before 19:45".
  readyAt: true,
  acceptDeadlineAt: true,
  createdAt: true,
  totalMinor: true,
  currency: true,
  customerNote: true,
  // The merchant's own clock and window: a pickup promise is only meaningful
  // when rendered in the timezone the kitchen is working in, and the hold
  // deadline is per-merchant.
  merchant: {
    select: { name: true, slug: true, timezone: true, pickupWindowMinutes: true },
  },
  items: { select: lineSelect, orderBy: { id: 'asc' } },
  // Newest first: the order page cares about the ticket that is live, not the
  // one from six weeks ago. The full conversation lives at /refund-requests/:id.
  refundRequests: {
    select: {
      id: true,
      status: true,
      reasonCode: true,
      requestedAmountMinor: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  },
} as const;

const merchantOrderSelect = {
  ...customerOrderSelect,
  subtotalMinor: true,
  platformFeeMinor: true,
  paymentFeeMinor: true,
  merchantPayoutMinor: true,
  mainItemCount: true,
  acceptedAt: true,
  completedAt: true,
} as const;

type CustomerOrderRow = {
  id: string;
  orderNo: string;
  pickupCode: string | null;
  merchantId: string;
  status: string;
  fulfilmentMode: string;
  paymentMode: string;
  scheduledPickupAt: Date | null;
  estimatedReadyAt: Date | null;
  readyInMinutes: number | null;
  merchantNote: string | null;
  readyAt: Date | null;
  acceptDeadlineAt: Date | null;
  createdAt: Date;
  totalMinor: number;
  currency: string;
  customerNote: string | null;
  merchant: {
    name: string;
    slug: string;
    timezone: string;
    pickupWindowMinutes: number;
  };
  items: {
    menuItemId: string | null;
    nameSnapshot: string;
    imageKeySnapshot: string | null;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    isMainItem: boolean;
  }[];
  refundRequests: {
    id: string;
    status: string;
    reasonCode: string;
    requestedAmountMinor: number | null;
    createdAt: Date;
  }[];
};

type MerchantOrderRow = CustomerOrderRow & {
  subtotalMinor: number;
  platformFeeMinor: number;
  paymentFeeMinor: number;
  merchantPayoutMinor: number;
  mainItemCount: number;
  acceptedAt: Date | null;
  completedAt: Date | null;
};
