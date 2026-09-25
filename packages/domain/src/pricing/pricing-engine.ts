import { CurrencyCode, Money } from '../shared/index';
import {
  DeepPartial,
  PricingPolicy,
  resolvePricingPolicy,
} from './pricing-policy';
import {
  EmptyOrderError,
  InvalidQuantityError,
  InvalidUnitPriceError,
  NegativeMerchantPayoutError,
} from './pricing.errors';

export interface PricingLineInput {
  readonly menuItemId: string;
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  /** `true` for a main dish — the only thing the per-item platform fee counts. */
  readonly isMainItem: boolean;
}

export interface PricingInput {
  readonly lines: readonly PricingLineInput[];
  /** Per-order policy override (e.g. a promo merchant). Falls back to engine policy. */
  readonly policyOverrides?: DeepPartial<PricingPolicy>;
}

export interface PricedLine {
  readonly menuItemId: string;
  readonly name: string;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly isMainItem: boolean;
  /** `unitPriceMinor * quantity` */
  readonly lineTotalMinor: number;
  /** Whether this line contributed to `mainItemCount`. */
  readonly countsTowardPlatformFee: boolean;
}

/** Plain-JSON projection persisted on `Order.pricingSnapshot`. */
export interface PricingSnapshot {
  readonly currency: CurrencyCode;
  readonly mainItemCount: number;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly paymentProcessingFeeMinor: number;
  readonly customerServiceFeeMinor: number;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly appliedPolicy: {
    readonly feePerMainItemMinor: number;
    readonly paymentFeeRateBps: number;
    readonly paymentFeeFixedMinor: number;
    readonly countAddOnItems: boolean;
  };
}

/** Constructor payload for `PricingBreakdown`. */
export interface PricingBreakdownParams {
  readonly lines: readonly PricedLine[];
  readonly currency: CurrencyCode;
  readonly mainItemCount: number;
  readonly subtotal: Money;
  readonly platformFee: Money;
  readonly paymentProcessingFee: Money;
  readonly customerServiceFee: Money;
  readonly total: Money;
  readonly merchantPayout: Money;
  readonly policy: PricingPolicy;
}

/**
 * The immutable result of pricing an order.
 *
 * Every monetary figure is a `Money`, so the amount is never re-derived from a
 * float and the currency can never be silently mixed.
 */
export class PricingBreakdown {
  private constructor(private readonly params: PricingBreakdownParams) {
    Object.freeze(this);
  }

  static of(params: PricingBreakdownParams): PricingBreakdown {
    return new PricingBreakdown(params);
  }

  get lines(): readonly PricedLine[] {
    return this.params.lines;
  }
  get currency(): CurrencyCode {
    return this.params.currency;
  }
  get mainItemCount(): number {
    return this.params.mainItemCount;
  }
  /** Menu price total, before any platform charge. */
  get subtotal(): Money {
    return this.params.subtotal;
  }
  /** Flat per-main-item commission retained by the platform. */
  get platformFee(): Money {
    return this.params.platformFee;
  }
  /** Card / wallet processing cost, deducted from the merchant. */
  get paymentProcessingFee(): Money {
    return this.params.paymentProcessingFee;
  }
  get customerServiceFee(): Money {
    return this.params.customerServiceFee;
  }
  /** What the customer is charged. */
  get total(): Money {
    return this.params.total;
  }
  /** `Subtotal - PlatformFee - PaymentProcessingFee` — what the merchant banks. */
  get merchantPayout(): Money {
    return this.params.merchantPayout;
  }
  /** `PlatformFee + CustomerServiceFee` — retained by the platform. */
  get platformNetRevenue(): Money {
    return this.params.platformFee.add(this.params.customerServiceFee);
  }

  toSnapshot(): PricingSnapshot {
    return {
      currency: this.params.currency,
      mainItemCount: this.params.mainItemCount,
      subtotalMinor: this.params.subtotal.minor,
      platformFeeMinor: this.params.platformFee.minor,
      paymentProcessingFeeMinor: this.params.paymentProcessingFee.minor,
      customerServiceFeeMinor: this.params.customerServiceFee.minor,
      totalMinor: this.params.total.minor,
      merchantPayoutMinor: this.params.merchantPayout.minor,
      appliedPolicy: {
        feePerMainItemMinor: this.params.policy.platformFee.feePerMainItemMinor,
        paymentFeeRateBps: this.params.policy.paymentFee.rateBps,
        paymentFeeFixedMinor: this.params.policy.paymentFee.fixedMinor,
        countAddOnItems: this.params.policy.platformFee.countAddOnItems,
      },
    };
  }
}

/**
 * Deterministic, side-effect-free billing engine.
 *
 * ```
 * Platform_Fee     = Count(Ordered_Main_Items) * feePerMainItem
 * Merchant_Payout  = Subtotal - Platform_Fee - Payment_Processing_Fee
 * ```
 *
 * No I/O, no clock, no database: this class is the unit-test surface for the
 * money rules, and it is reused verbatim by the refund path and the payout
 * reconciliation job so the three can never disagree.
 */
export class PricingEngine {
  private policy: PricingPolicy;

  constructor(policy?: DeepPartial<PricingPolicy>) {
    this.policy = resolvePricingPolicy(policy);
  }

  get currentPolicy(): PricingPolicy {
    return this.policy;
  }

  /**
   * Adopt a new policy in place.
   *
   * The engine's *identity* is what the composition root hands to every
   * consumer, so building a fresh engine on a config change would leave those
   * consumers holding the policy resolved at boot — the operator would change
   * the fee, watch the console show the new number, and still be charged the
   * old one on the next order. Mutating in place is what makes a live change
   * actually reach the money.
   *
   * Safe under concurrency because every public method snapshots `this.policy`
   * once on entry, so no caller can observe a half-applied swap.
   */
  usePolicy(policy?: DeepPartial<PricingPolicy>): void {
    this.policy = resolvePricingPolicy(policy);
  }

  /** `Count(Ordered_Main_Items) * feePerMainItem` */
  calculatePlatformFee(mainItemCount: number): Money {
    if (!Number.isInteger(mainItemCount) || mainItemCount < 0) {
      throw new InvalidQuantityError('<aggregate>', mainItemCount);
    }
    const policy = this.policy;
    return Money.of(
      policy.platformFee.feePerMainItemMinor * mainItemCount,
      policy.platformFee.currency,
    );
  }

  calculatePaymentProcessingFee(chargeBase: Money): Money {
    const policy = this.policy;
    return chargeBase
      .applyBasisPoints(policy.paymentFee.rateBps)
      .add(Money.of(policy.paymentFee.fixedMinor, policy.platformFee.currency));
  }

  /** `Subtotal - PlatformFee - PaymentFee`, floored by `minimumPayoutMinor`. */
  calculateMerchantPayout(subtotal: Money, platformFee: Money, paymentFee: Money): Money {
    const policy = this.policy;
    const payout = subtotal.subtract(platformFee).subtract(paymentFee);
    if (payout.minor < policy.minimumPayoutMinor) {
      throw new NegativeMerchantPayoutError(payout.minor, policy.minimumPayoutMinor, {
        subtotalMinor: subtotal.minor,
        platformFeeMinor: platformFee.minor,
        paymentFeeMinor: paymentFee.minor,
      });
    }
    return payout;
  }

  /** Full order pricing. Throws on invalid input rather than returning NaN. */
  calculate(input: PricingInput): PricingBreakdown {
    const policy = input.policyOverrides
      ? resolvePricingPolicy(input.policyOverrides, this.policy)
      : this.policy;
    const currency = policy.platformFee.currency;

    if (!input.lines || input.lines.length === 0) {
      throw new EmptyOrderError();
    }

    let subtotal = Money.zero(currency);
    let mainItemCount = 0;
    const pricedLines: PricedLine[] = [];

    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new InvalidQuantityError(line.menuItemId, line.quantity);
      }
      if (!Number.isInteger(line.unitPriceMinor) || line.unitPriceMinor < 0) {
        throw new InvalidUnitPriceError(line.menuItemId, line.unitPriceMinor);
      }

      const countsTowardPlatformFee = line.isMainItem || policy.platformFee.countAddOnItems;
      // Quantity counts: 3 x 招牌飯 is 3 main items, not 1.
      if (countsTowardPlatformFee) {
        mainItemCount += line.quantity;
      }

      const lineTotalMinor = line.unitPriceMinor * line.quantity;
      subtotal = subtotal.add(Money.of(lineTotalMinor, currency));

      pricedLines.push({
        menuItemId: line.menuItemId,
        name: line.name,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        isMainItem: line.isMainItem,
        lineTotalMinor,
        countsTowardPlatformFee,
      });
    }

    const platformFee = Money.of(
      policy.platformFee.feePerMainItemMinor * mainItemCount,
      currency,
    );
    const customerServiceFee = Money.of(policy.customerServiceFeeMinor, currency);
    const total = subtotal.add(customerServiceFee);

    const chargeBase = policy.paymentFee.chargeOn === 'SUBTOTAL' ? subtotal : total;
    const paymentProcessingFee = chargeBase
      .applyBasisPoints(policy.paymentFee.rateBps)
      .add(Money.of(policy.paymentFee.fixedMinor, currency));

    const merchantPayout = this.calculateMerchantPayout(subtotal, platformFee, paymentProcessingFee);

    return PricingBreakdown.of({
      lines: Object.freeze(pricedLines),
      currency,
      mainItemCount,
      subtotal,
      platformFee,
      paymentProcessingFee,
      customerServiceFee,
      total,
      merchantPayout,
      policy,
    });
  }

  private get currency(): CurrencyCode {
    return this.policy.platformFee.currency;
  }
}
