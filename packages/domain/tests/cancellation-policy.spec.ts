import { describe, expect, it } from 'vitest';
import {
  CancellationPolicyEngine,
  CancellationTier,
  DEFAULT_CANCELLATION_POLICY,
  Money,
  OrderActor,
  OrderStatus,
  ValidationError,
} from '../src/index';

const NOW = new Date('2026-09-24T05:00:00.000Z');
const engine = new CancellationPolicyEngine();

/** HK$100.00 captured — round numbers make a wrong ratio obvious. */
const CAPTURED = 10_000;

function quote(overrides: Partial<Parameters<CancellationPolicyEngine['quote']>[0]> = {}) {
  return engine.quote({
    orderId: 'ord_1',
    from: OrderStatus.PAID,
    to: OrderStatus.CANCELLED,
    actor: OrderActor.CUSTOMER,
    paidAmountMinor: CAPTURED,
    now: NOW,
    ...overrides,
  });
}

describe('CancellationPolicyEngine — who pays', () => {
  it('refunds in full when the customer cancels before the kitchen is involved', () => {
    for (const from of [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID]) {
      const result = quote({ from });
      expect(result.tier).toBe(CancellationTier.FREE);
      expect(result.refundBps).toBe(10_000);
      expect(result.refund.minor).toBe(CAPTURED);
      expect(result.retained.minor).toBe(0);
    }
  });

  it('refunds in full when the merchant rejects — never the customer’s fault', () => {
    const result = quote({ from: OrderStatus.PAID, to: OrderStatus.REJECTED, actor: OrderActor.MERCHANT });
    expect(result.tier).toBe(CancellationTier.MERCHANT_FAULT);
    expect(result.refund.minor).toBe(CAPTURED);
  });

  it('refunds in full when the merchant cancels mid-prep, because they stopped it', () => {
    const result = quote({ from: OrderStatus.PREPARING, actor: OrderActor.MERCHANT });
    expect(result.tier).toBe(CancellationTier.MERCHANT_FAULT);
    expect(result.refund.minor).toBe(CAPTURED);
  });

  it('refunds in full when a timer expired an order nobody accepted', () => {
    const result = quote({ from: OrderStatus.PAID, to: OrderStatus.EXPIRED, actor: OrderActor.SYSTEM });
    expect(result.tier).toBe(CancellationTier.PLATFORM_FAULT);
    expect(result.refund.minor).toBe(CAPTURED);
  });

  it('refunds nothing when the food was ready and nobody collected it', () => {
    const result = quote({
      from: OrderStatus.READY_FOR_PICKUP,
      to: OrderStatus.EXPIRED,
      actor: OrderActor.SYSTEM,
    });
    expect(result.tier).toBe(CancellationTier.NON_REFUNDABLE);
    expect(result.refundBps).toBe(0);
    expect(result.refund.isZero()).toBe(true);
    // The merchant cooked it; the money stays with them rather than vanishing.
    expect(result.retained.minor).toBe(CAPTURED);
  });
});

describe('CancellationPolicyEngine — the grace window', () => {
  const acceptedAt = new Date(NOW.getTime() - 60_000); // one minute ago

  it('is free inside the window, because the merchant has not started cooking', () => {
    const result = quote({ from: OrderStatus.ACCEPTED, acceptedAt });
    expect(result.tier).toBe(CancellationTier.FREE);
    expect(result.refund.minor).toBe(CAPTURED);
  });

  it('costs the basket once the window has passed', () => {
    const longAgo = new Date(NOW.getTime() - 30 * 60_000);
    const result = quote({ from: OrderStatus.ACCEPTED, acceptedAt: longAgo });
    expect(result.tier).toBe(CancellationTier.LATE);
    expect(result.refundBps).toBe(0);
    expect(result.refund.isZero()).toBe(true);
  });

  it('treats the boundary itself as inside the window', () => {
    const exactly = new Date(NOW.getTime() - DEFAULT_CANCELLATION_POLICY.graceMinutes * 60_000);
    expect(quote({ from: OrderStatus.ACCEPTED, acceptedAt: exactly }).tier).toBe(CancellationTier.FREE);
    const oneSecondLater = new Date(exactly.getTime() - 1_000);
    expect(quote({ from: OrderStatus.ACCEPTED, acceptedAt: oneSecondLater }).tier).toBe(
      CancellationTier.LATE,
    );
  });

  it('treats a future timestamp as inside the window rather than punishing clock skew', () => {
    const future = new Date(NOW.getTime() + 5 * 60_000);
    expect(quote({ from: OrderStatus.ACCEPTED, acceptedAt: future }).tier).toBe(CancellationTier.FREE);
  });

  it('treats a missing acceptance timestamp as a late cancellation, not a free one', () => {
    // Fails closed: an order that claims to be ACCEPTED with no acceptance time
    // must not become a free cancellation by omission.
    const result = quote({ from: OrderStatus.ACCEPTED, acceptedAt: null });
    expect(result.tier).toBe(CancellationTier.LATE);
  });
});

describe('CancellationPolicyEngine — operator overrides', () => {
  it('lets an operator choose the ratio, and only an operator', () => {
    const admin = quote({ actor: OrderActor.ADMIN, overrideBps: 5_000 });
    expect(admin.tier).toBe(CancellationTier.GOODWILL);
    expect(admin.refundBps).toBe(5_000);
    expect(admin.refund.minor).toBe(5_000);
    expect(admin.retained.minor).toBe(5_000);

    // A customer supplying the same override is ignored: it is not their money
    // to decide how much of it to keep.
    const customer = quote({ actor: OrderActor.CUSTOMER, from: OrderStatus.PAID, overrideBps: 10_000 });
    expect(customer.refundBps).toBe(10_000);
    expect(customer.tier).toBe(CancellationTier.FREE);

    const sneaky = quote({
      actor: OrderActor.CUSTOMER,
      from: OrderStatus.ACCEPTED,
      acceptedAt: new Date(NOW.getTime() - 60 * 60_000),
      overrideBps: 10_000,
    });
    expect(sneaky.tier).toBe(CancellationTier.LATE);
    expect(sneaky.refundBps).toBe(0);
  });

  it('falls back to the configured goodwill ratio when the operator gives none', () => {
    expect(quote({ actor: OrderActor.ADMIN }).refundBps).toBe(10_000);
  });
});

describe('CancellationPolicyEngine — the arithmetic', () => {
  it('rounds half away from zero, so a 50% refund of an odd amount is not biased down', () => {
    const engine50 = engine.withPolicy({
      refundBps: { ...DEFAULT_CANCELLATION_POLICY.refundBps, [CancellationTier.GOODWILL]: 5_000 },
    });
    const result = engine50.quote({
      orderId: 'ord_1',
      from: OrderStatus.PREPARING,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.ADMIN,
      paidAmountMinor: 101,
      now: NOW,
    });
    expect(result.refund.minor).toBe(51); // 50.5 rounds up
    expect(result.retained.minor).toBe(50);
  });

  it('never refunds more than was captured', () => {
    const result = quote({ from: OrderStatus.PAID, paidAmountMinor: 0 });
    expect(result.refund.minor).toBe(0);
    expect(result.retained.minor).toBe(0);
  });

  it('keeps refund + retained equal to the captured amount, in minor units', () => {
    for (const paid of [1, 7, 350, 9_999, 123_456]) {
      for (const bps of [0, 1, 3_333, 5_000, 9_999, 10_000]) {
        const e = engine.withPolicy({
          refundBps: { ...DEFAULT_CANCELLATION_POLICY.refundBps, [CancellationTier.GOODWILL]: bps },
        });
        const result = e.quote({
          orderId: 'ord_1',
          from: OrderStatus.PAID,
          to: OrderStatus.CANCELLED,
          actor: OrderActor.ADMIN,
          paidAmountMinor: paid,
          now: NOW,
        });
        expect(result.refund.minor + result.retained.minor).toBe(paid);
        expect(Number.isInteger(result.refund.minor)).toBe(true);
        expect(result.refund.minor).toBeGreaterThanOrEqual(0);
        expect(result.refund.minor).toBeLessThanOrEqual(paid);
      }
    }
  });

  it('honours the currency rather than assuming HKD', () => {
    const result = quote({ currency: 'USD', from: OrderStatus.PAID });
    expect(result.refund.currency).toBe('USD');
    expect(result.refund).toEqual(Money.of(CAPTURED, 'USD'));
  });
});

describe('CancellationPolicyEngine — configuration safety', () => {
  it('refuses a ratio above 100%, which would refund money that was never taken', () => {
    expect(
      () =>
        new CancellationPolicyEngine({
          ...DEFAULT_CANCELLATION_POLICY,
          refundBps: { ...DEFAULT_CANCELLATION_POLICY.refundBps, [CancellationTier.FREE]: 10_001 },
        }),
    ).toThrow(ValidationError);
  });

  it('refuses a negative or fractional ratio', () => {
    for (const bad of [-1, 33.3, Number.NaN]) {
      expect(
        () =>
          new CancellationPolicyEngine({
            ...DEFAULT_CANCELLATION_POLICY,
            refundBps: { ...DEFAULT_CANCELLATION_POLICY.refundBps, [CancellationTier.LATE]: bad },
          }),
      ).toThrow(ValidationError);
    }
  });

  it('refuses a policy that forgot a tier, rather than pricing it as NaN', () => {
    expect(
      () =>
        new CancellationPolicyEngine({
          graceMinutes: 2,
          refundBps: { [CancellationTier.FREE]: 10_000 } as never,
        }),
    ).toThrow(ValidationError);
  });

  it('refuses a negative grace window', () => {
    expect(
      () => new CancellationPolicyEngine({ ...DEFAULT_CANCELLATION_POLICY, graceMinutes: -1 }),
    ).toThrow(ValidationError);
  });

  it('rejects a target status that does not return money', () => {
    expect(() => quote({ to: OrderStatus.COMPLETED })).toThrow(ValidationError);
    expect(() => quote({ to: OrderStatus.PREPARING })).toThrow(ValidationError);
  });

  it('withPolicy returns a new engine, because two requests can price at the same time', () => {
    const base = new CancellationPolicyEngine();
    const tuned = base.withPolicy({ graceMinutes: 30 });

    expect(tuned).not.toBe(base);
    expect(tuned.config.graceMinutes).toBe(30);
    // The original is untouched — a shared mutable engine would let one
    // request's tuning leak into another's quote.
    expect(base.config.graceMinutes).toBe(DEFAULT_CANCELLATION_POLICY.graceMinutes);
    expect(base.config.refundBps).toBe(DEFAULT_CANCELLATION_POLICY.refundBps);
  });

  it('ships an immutable default, so one caller cannot poison every later quote', () => {
    expect(Object.isFrozen(DEFAULT_CANCELLATION_POLICY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CANCELLATION_POLICY.refundBps)).toBe(true);
  });

  it('returns a frozen quote', () => {
    expect(Object.isFrozen(quote())).toBe(true);
  });

  it('explains itself in plain language for every tier', () => {
    const cases = [
      quote({ from: OrderStatus.PAID }),
      quote({ from: OrderStatus.ACCEPTED, acceptedAt: new Date(NOW.getTime() - 60 * 60_000) }),
      quote({ from: OrderStatus.READY_FOR_PICKUP, to: OrderStatus.EXPIRED, actor: OrderActor.SYSTEM }),
      quote({ from: OrderStatus.PAID, to: OrderStatus.REJECTED, actor: OrderActor.MERCHANT }),
      quote({ from: OrderStatus.PAID, to: OrderStatus.EXPIRED, actor: OrderActor.SYSTEM }),
      quote({ actor: OrderActor.ADMIN }),
    ];
    for (const result of cases) {
      expect(result.reason.length).toBeGreaterThan(20);
      expect(result.reason.endsWith('.')).toBe(true);
    }
  });
});
