import { DomainError, ValidationError } from '../shared/index';

export class EmptyOrderError extends ValidationError {
  constructor() {
    super('An order must contain at least one line item');
  }
}

export class InvalidQuantityError extends ValidationError {
  constructor(menuItemId: string, quantity: number) {
    super(`Line quantity must be a positive integer, received ${quantity}`, {
      menuItemId,
      quantity,
    });
  }
}

export class InvalidUnitPriceError extends ValidationError {
  constructor(menuItemId: string, unitPriceMinor: number) {
    super(`Unit price must be a non-negative integer number of minor units`, {
      menuItemId,
      unitPriceMinor,
    });
  }
}

/**
 * Raised when `Subtotal - PlatformFee - PaymentFee` falls below the configured
 * floor. This signals a misconfiguration (or a basket too small to be viable),
 * not a user error — clamping silently would hide a money-losing order.
 */
export class NegativeMerchantPayoutError extends DomainError {
  constructor(
    readonly payoutMinor: number,
    readonly minimumPayoutMinor: number,
    readonly context: Record<string, unknown>,
  ) {
    super(
      'NEGATIVE_MERCHANT_PAYOUT',
      `Merchant payout ${payoutMinor} is below the configured floor ${minimumPayoutMinor}`,
      { payoutMinor, minimumPayoutMinor, ...context },
    );
  }
}
