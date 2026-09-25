import { DomainError, ValidationError } from './domain-error';

export type CurrencyCode = 'HKD' | 'CNY' | 'USD';

/** Number of decimal places in the minor unit of each supported currency. */
const MINOR_UNIT_EXPONENT: Readonly<Record<CurrencyCode, number>> = {
  HKD: 2,
  CNY: 2,
  USD: 2,
};

const CURRENCY_SYMBOL: Readonly<Record<CurrencyCode, string>> = {
  HKD: 'HK$',
  CNY: '¥',
  USD: 'US$',
};

/**
 * Rounds half away from zero.
 *
 * `Math.round` rounds `-0.5` to `-0` (towards +Infinity), which silently biases
 * negative amounts. Accounting code must not do that.
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    throw new DomainError('MONEY_NOT_FINITE', `Cannot round non-finite value: ${value}`);
  }
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * Immutable monetary value.
 *
 * Stored as an **integer count of minor units** (HK$3.50 => 350). Floating point
 * is never used to hold a balance, so `0.1 + 0.2` style drift cannot reach the
 * ledger. All arithmetic returns a new instance.
 */
export class Money {
  private constructor(
    private readonly _minor: number,
    private readonly _currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  /** Build from minor units. `Money.of(350)` === HK$3.50 */
  static of(minor: number, currency: CurrencyCode = 'HKD'): Money {
    if (!Number.isInteger(minor)) {
      throw new ValidationError(
        `Money must be an integer number of minor units, received ${minor}`,
        { minor, currency },
      );
    }
    return new Money(minor, currency);
  }

  /** Build from a human amount. `Money.fromMajor(3.5)` === HK$3.50 */
  static fromMajor(major: number, currency: CurrencyCode = 'HKD'): Money {
    if (!Number.isFinite(major)) {
      throw new ValidationError(`Money amount must be finite, received ${major}`, { major });
    }
    return new Money(roundHalfAwayFromZero(major * 10 ** MINOR_UNIT_EXPONENT[currency]), currency);
  }

  static zero(currency: CurrencyCode = 'HKD'): Money {
    return new Money(0, currency);
  }

  get minor(): number {
    return this._minor;
  }

  get currency(): CurrencyCode {
    return this._currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other, 'add');
    return new Money(this._minor + other._minor, this._currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other, 'subtract');
    return new Money(this._minor - other._minor, this._currency);
  }

  /** Multiply by an arbitrary factor, rounding half away from zero. */
  multiply(factor: number): Money {
    return new Money(roundHalfAwayFromZero(this._minor * factor), this._currency);
  }

  /**
   * Apply an integer rate expressed in **basis points** (1 bps = 0.01%).
   * `Money.of(10_000).applyBasisPoints(340)` === HK$3.40 (Stripe HK 3.40%).
   *
   * Integer intermediate math avoids the float drift of `minor * 0.034`.
   */
  applyBasisPoints(basisPoints: number): Money {
    if (!Number.isInteger(basisPoints)) {
      throw new ValidationError(`Basis points must be an integer, received ${basisPoints}`);
    }
    return new Money(roundHalfAwayFromZero((this._minor * basisPoints) / 10_000), this._currency);
  }

  negate(): Money {
    return new Money(-this._minor, this._currency);
  }

  /** Clamp to zero — never returns a negative amount. */
  clampToZero(): Money {
    return this._minor < 0 ? Money.zero(this._currency) : this;
  }

  isZero(): boolean {
    return this._minor === 0;
  }

  isNegative(): boolean {
    return this._minor < 0;
  }

  isPositive(): boolean {
    return this._minor > 0;
  }

  greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other, 'compare');
    if (this._minor === other._minor) return 0;
    return this._minor > other._minor ? 1 : -1;
  }

  equals(other: Money): boolean {
    return this._currency === other._currency && this._minor === other._minor;
  }

  /** `HK$3.50` — deterministic, locale-independent (safe in logs and tests). */
  format(): string {
    const exponent = MINOR_UNIT_EXPONENT[this._currency];
    const sign = this._minor < 0 ? '-' : '';
    const absolute = Math.abs(this._minor);
    const unit = Math.floor(absolute / 10 ** exponent);
    const fraction = String(absolute % 10 ** exponent).padStart(exponent, '0');
    return `${sign}${CURRENCY_SYMBOL[this._currency]}${unit.toLocaleString('en-US')}.${fraction}`;
  }

  toJSON(): { minor: number; currency: CurrencyCode; formatted: string } {
    return { minor: this._minor, currency: this._currency, formatted: this.format() };
  }

  toString(): string {
    return this.format();
  }

  private assertSameCurrency(other: Money, operation: string): void {
    if (this._currency !== other._currency) {
      throw new DomainError(
        'MONEY_CURRENCY_MISMATCH',
        `Cannot ${operation} ${this._currency} and ${other._currency}`,
        { left: this._currency, right: other._currency, operation },
      );
    }
  }
}
