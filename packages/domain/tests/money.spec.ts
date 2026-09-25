import { describe, expect, it } from 'vitest';
import { DomainError, Money, ValidationError, roundHalfAwayFromZero } from '../src/index';

describe('Money', () => {
  it('stores value as integer minor units', () => {
    const fee = Money.of(350);
    expect(fee.minor).toBe(350);
    expect(fee.currency).toBe('HKD');
    expect(fee.format()).toBe('HK$3.50');
  });

  it('converts a human amount without float drift', () => {
    expect(Money.fromMajor(3.5).minor).toBe(350);
    // 1.15 * 100 === 114.99999999999999 in IEEE-754; rounding must absorb it.
    expect(Money.fromMajor(1.15).minor).toBe(115);
    expect(Money.fromMajor(0.1).add(Money.fromMajor(0.2)).minor).toBe(30);
  });

  it('rejects non-integer minor units', () => {
    expect(() => Money.of(3.5)).toThrow(ValidationError);
  });

  it('formats with thousands separators', () => {
    expect(Money.of(123456).format()).toBe('HK$1,234.56');
    expect(Money.of(0).format()).toBe('HK$0.00');
    expect(Money.of(-350).format()).toBe('-HK$3.50');
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of(100, 'HKD').add(Money.of(100, 'CNY'))).toThrow(DomainError);
  });

  it('applies basis points with integer intermediates', () => {
    // Stripe HK: 3.40% of HK$58.00
    expect(Money.of(5800).applyBasisPoints(340).minor).toBe(197);
    expect(Money.of(10_000).applyBasisPoints(340).minor).toBe(340);
    expect(() => Money.of(100).applyBasisPoints(3.4)).toThrow(ValidationError);
  });

  it('rounds half away from zero, not towards +Infinity', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
  });

  it('compares and clamps', () => {
    expect(Money.of(100).greaterThan(Money.of(99))).toBe(true);
    expect(Money.of(-1).clampToZero().minor).toBe(0);
    expect(Money.of(5).compare(Money.of(5))).toBe(0);
  });

  it('is immutable — arithmetic never mutates the receiver', () => {
    const base = Money.of(100);
    const sum = base.add(Money.of(50));
    expect(base.minor).toBe(100);
    expect(sum.minor).toBe(150);
    expect(Object.isFrozen(base)).toBe(true);
  });
});
