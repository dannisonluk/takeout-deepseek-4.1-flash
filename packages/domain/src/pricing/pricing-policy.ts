import { CurrencyCode, ValidationError } from '../shared/index';

/**
 * How the platform charges the merchant.
 *
 * MVP model: a **flat fee per ordered main item**. The rate lives here and is
 * resolved from configuration at boot (see `PLATFORM_FEE_PER_MAIN_ITEM_HKD` in
 * `.env`), never hard-coded at a call site.
 */
export interface PlatformFeePolicy {
  /** Minor units charged per main item. 350 = HK$3.50. */
  readonly feePerMainItemMinor: number;
  readonly currency: CurrencyCode;
  /**
   * When `true`, side dishes / drinks also incur the per-item fee.
   * Default `false` — the business rule counts *main* items only.
   */
  readonly countAddOnItems: boolean;
}

/**
 * What the PSP takes before the merchant sees money.
 * Stripe HK standard card: 3.40% + HK$2.35 => `rateBps: 340, fixedMinor: 235`.
 */
export interface PaymentProcessingFeePolicy {
  /** Percentage in basis points. 340 = 3.40%. */
  readonly rateBps: number;
  /** Flat component in minor units. */
  readonly fixedMinor: number;
  /** Which amount the percentage is charged on. */
  readonly chargeOn: 'SUBTOTAL' | 'ORDER_TOTAL';
}

export interface PricingPolicy {
  readonly platformFee: PlatformFeePolicy;
  readonly paymentFee: PaymentProcessingFeePolicy;
  /**
   * Optional fee added on top of the menu subtotal and paid by the customer.
   * MVP default is 0 — the customer pays menu price only.
   */
  readonly customerServiceFeeMinor: number;
  /** Floor for merchant payout; a payout below this raises rather than silently clamping. */
  readonly minimumPayoutMinor: number;
}

export type DeepPartial<T> = {
  readonly [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * The business rule as stated: HK$3.50 per main item, merchant absorbs the
 * platform fee and the PSP fee.
 */
export const DEFAULT_PRICING_POLICY: PricingPolicy = Object.freeze({
  platformFee: Object.freeze({
    feePerMainItemMinor: 350,
    currency: 'HKD' as CurrencyCode,
    countAddOnItems: false,
  }),
  paymentFee: Object.freeze({
    rateBps: 340,
    fixedMinor: 235,
    chargeOn: 'SUBTOTAL' as const,
  }),
  customerServiceFeeMinor: 0,
  minimumPayoutMinor: 0,
});

export function validatePricingPolicy(policy: PricingPolicy): void {
  const { platformFee, paymentFee } = policy;

  if (!Number.isInteger(platformFee.feePerMainItemMinor) || platformFee.feePerMainItemMinor < 0) {
    throw new ValidationError('platformFee.feePerMainItemMinor must be a non-negative integer', {
      value: platformFee.feePerMainItemMinor,
    });
  }
  if (!Number.isInteger(paymentFee.rateBps) || paymentFee.rateBps < 0 || paymentFee.rateBps > 10_000) {
    throw new ValidationError('paymentFee.rateBps must be an integer within [0, 10000]', {
      value: paymentFee.rateBps,
    });
  }
  if (!Number.isInteger(paymentFee.fixedMinor) || paymentFee.fixedMinor < 0) {
    throw new ValidationError('paymentFee.fixedMinor must be a non-negative integer', {
      value: paymentFee.fixedMinor,
    });
  }
  if (!Number.isInteger(policy.customerServiceFeeMinor) || policy.customerServiceFeeMinor < 0) {
    throw new ValidationError('customerServiceFeeMinor must be a non-negative integer', {
      value: policy.customerServiceFeeMinor,
    });
  }
  if (!Number.isInteger(policy.minimumPayoutMinor)) {
    throw new ValidationError('minimumPayoutMinor must be an integer', {
      value: policy.minimumPayoutMinor,
    });
  }
}

/**
 * Merges overrides onto a base policy and validates the result.
 * This is the single place a policy is allowed to come into existence.
 */
export function resolvePricingPolicy(
  overrides?: DeepPartial<PricingPolicy>,
  base: PricingPolicy = DEFAULT_PRICING_POLICY,
): PricingPolicy {
  if (!overrides) {
    validatePricingPolicy(base);
    return base;
  }

  const resolved: PricingPolicy = {
    platformFee: { ...base.platformFee, ...overrides.platformFee },
    paymentFee: { ...base.paymentFee, ...overrides.paymentFee },
    customerServiceFeeMinor: overrides.customerServiceFeeMinor ?? base.customerServiceFeeMinor,
    minimumPayoutMinor: overrides.minimumPayoutMinor ?? base.minimumPayoutMinor,
  };

  validatePricingPolicy(resolved);
  return Object.freeze(resolved);
}
