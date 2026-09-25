import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRICING_POLICY,
  EmptyOrderError,
  InvalidQuantityError,
  InvalidUnitPriceError,
  NegativeMerchantPayoutError,
  PricingEngine,
  resolvePricingPolicy,
} from '../src/index';

/** Helper: a main dish at the given HK$ price. */
const mainDish = (unitPriceMinor: number, quantity = 1) => ({
  menuItemId: 'item_main',
  name: '招牌叉燒飯',
  unitPriceMinor,
  quantity,
  isMainItem: true,
});

const addOn = (unitPriceMinor: number, quantity = 1) => ({
  menuItemId: 'item_drink',
  name: '凍檸茶',
  unitPriceMinor,
  quantity,
  isMainItem: false,
});

describe('PricingEngine — platform fee', () => {
  it('charges HK$3.50 per main item by default', () => {
    expect(DEFAULT_PRICING_POLICY.platformFee.feePerMainItemMinor).toBe(350);

    const engine = new PricingEngine();
    const result = engine.calculate({ lines: [mainDish(5800)] });

    expect(result.mainItemCount).toBe(1);
    expect(result.platformFee.minor).toBe(350);
    expect(result.platformFee.format()).toBe('HK$3.50');
  });

  it('counts quantity, not line count — 3 x 招牌飯 is 3 main items', () => {
    const engine = new PricingEngine();
    const result = engine.calculate({ lines: [mainDish(5800, 3)] });

    expect(result.mainItemCount).toBe(3);
    expect(result.platformFee.minor).toBe(1050);
    expect(result.subtotal.minor).toBe(17_400);
  });

  it('ignores add-ons when counting main items', () => {
    const engine = new PricingEngine();
    const result = engine.calculate({
      lines: [mainDish(5800, 2), addOn(1800, 3)],
    });

    expect(result.mainItemCount).toBe(2);
    expect(result.platformFee.minor).toBe(700);
    expect(result.subtotal.minor).toBe(5800 * 2 + 1800 * 3);
  });

  it('can be configured to charge add-ons too', () => {
    const engine = new PricingEngine({
      platformFee: { countAddOnItems: true },
    });
    const result = engine.calculate({ lines: [mainDish(5800, 2), addOn(1800, 3)] });

    expect(result.mainItemCount).toBe(5);
    expect(result.platformFee.minor).toBe(1750);
  });

  it('takes the per-item rate from configuration, not a literal', () => {
    const engine = new PricingEngine({ platformFee: { feePerMainItemMinor: 500 } });
    expect(engine.calculate({ lines: [mainDish(5800, 4)] }).platformFee.minor).toBe(2000);

    const promo = engine.calculate({
      lines: [mainDish(5800, 4)],
      policyOverrides: { platformFee: { feePerMainItemMinor: 100 } },
    });
    expect(promo.platformFee.minor).toBe(400);
    // Per-order override must not mutate the engine policy.
    expect(engine.currentPolicy.platformFee.feePerMainItemMinor).toBe(500);
  });

  it('validates the configured rate', () => {
    expect(() => resolvePricingPolicy({ platformFee: { feePerMainItemMinor: -1 } })).toThrow();
    expect(() => resolvePricingPolicy({ paymentFee: { rateBps: 20_000 } })).toThrow();
  });
});

describe('PricingEngine — merchant payout', () => {
  it('computes Subtotal - PlatformFee - PaymentProcessingFee', () => {
    const engine = new PricingEngine();
    const result = engine.calculate({ lines: [mainDish(5800)] });

    // HK$58.00 * 3.40% = 197.2 -> 197, plus HK$2.35 fixed = 432
    expect(result.paymentProcessingFee.minor).toBe(432);
    expect(result.subtotal.minor).toBe(5800);
    expect(result.platformFee.minor).toBe(350);
    expect(result.merchantPayout.minor).toBe(5800 - 350 - 432);
    expect(result.merchantPayout.minor).toBe(5018);
  });

  it('charges the customer exactly the menu price in the MVP model', () => {
    const engine = new PricingEngine();
    const result = engine.calculate({ lines: [mainDish(5800, 2), addOn(1800)] });

    expect(result.customerServiceFee.minor).toBe(0);
    expect(result.total.minor).toBe(result.subtotal.minor);
  });

  it('separates platform revenue from merchant payout', () => {
    const engine = new PricingEngine();
    const result = engine.calculate({ lines: [mainDish(5800, 2)] });

    // The platform keeps the per-item fee; the PSP fee is nobody's revenue.
    expect(result.platformNetRevenue.minor).toBe(result.platformFee.minor);
    expect(result.total.minor).toBe(
      result.merchantPayout.minor + result.platformNetRevenue.minor + result.paymentProcessingFee.minor,
    );
  });

  it('lets the customer pay a service fee without touching merchant payout', () => {
    const engine = new PricingEngine({ customerServiceFeeMinor: 200 });
    const result = engine.calculate({ lines: [mainDish(5800)] });

    expect(result.total.minor).toBe(6000);
    expect(result.merchantPayout.minor).toBe(5018);
    expect(result.platformNetRevenue.minor).toBe(550);
  });

  it('can charge the PSP fee on the order total instead of the subtotal', () => {
    const engine = new PricingEngine({
      customerServiceFeeMinor: 1000,
      paymentFee: { chargeOn: 'ORDER_TOTAL' },
    });
    const result = engine.calculate({ lines: [mainDish(5800)] });

    // 6800 * 3.40% = 231.2 -> 231, plus 235 fixed
    expect(result.paymentProcessingFee.minor).toBe(466);
  });

  it('raises instead of silently clamping a loss-making payout', () => {
    const engine = new PricingEngine();
    // HK$4.00 basket: 350 platform + 249 PSP = 599 > 400.
    expect(() => engine.calculate({ lines: [mainDish(400)] })).toThrow(
      NegativeMerchantPayoutError,
    );
  });

  it('allows a zero floor to be relaxed for subsidised promos', () => {
    const engine = new PricingEngine({
      minimumPayoutMinor: -1000,
      platformFee: { feePerMainItemMinor: 0 },
    });
    const result = engine.calculate({ lines: [mainDish(400)] });
    expect(result.merchantPayout.minor).toBe(400 - 0 - 249);
  });
});

describe('PricingEngine — input validation', () => {
  const engine = new PricingEngine();

  it('rejects an empty basket', () => {
    expect(() => engine.calculate({ lines: [] })).toThrow(EmptyOrderError);
  });

  it('rejects a non-positive or fractional quantity', () => {
    expect(() => engine.calculate({ lines: [mainDish(5800, 0)] })).toThrow(InvalidQuantityError);
    expect(() => engine.calculate({ lines: [mainDish(5800, 1.5)] })).toThrow(InvalidQuantityError);
  });

  it('rejects a negative or fractional price', () => {
    expect(() => engine.calculate({ lines: [mainDish(-1)] })).toThrow(InvalidUnitPriceError);
    expect(() => engine.calculate({ lines: [mainDish(58.5)] })).toThrow(InvalidUnitPriceError);
  });

  it('exposes the aggregate platform fee helper used by reconciliation', () => {
    expect(engine.calculatePlatformFee(0).minor).toBe(0);
    expect(engine.calculatePlatformFee(7).minor).toBe(2450);
  });
});

describe('PricingEngine — persistence snapshot', () => {
  it('produces a plain JSON snapshot that reproduces the same numbers', () => {
    const engine = new PricingEngine();
    const snapshot = engine.calculate({ lines: [mainDish(5800, 2)] }).toSnapshot();

    expect(snapshot).toEqual({
      currency: 'HKD',
      mainItemCount: 2,
      subtotalMinor: 11_600,
      platformFeeMinor: 700,
      paymentProcessingFeeMinor: 629,
      customerServiceFeeMinor: 0,
      totalMinor: 11_600,
      merchantPayoutMinor: 11_600 - 700 - 629,
      appliedPolicy: {
        feePerMainItemMinor: 350,
        paymentFeeRateBps: 340,
        paymentFeeFixedMinor: 235,
        countAddOnItems: false,
      },
    });
    // Must survive JSON round-tripping into a JSONB column.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});
