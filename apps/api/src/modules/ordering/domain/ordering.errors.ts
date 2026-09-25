import { DomainError } from '@takeout/domain';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the exception filter. */

export class MerchantNotFoundError extends DomainError {
  constructor(merchantId: string) {
    super('MERCHANT_NOT_FOUND', 'Merchant does not exist or is not accepting orders', {
      merchantId,
    });
  }
}

export class OrderNotFoundError extends DomainError {
  constructor(orderId: string) {
    super('ORDER_NOT_FOUND', 'Order not found', { orderId });
  }
}

export class MenuItemNotFoundError extends DomainError {
  constructor(menuItemIds: readonly string[]) {
    super('MENU_ITEM_NOT_FOUND', 'One or more menu items do not belong to this merchant', {
      menuItemIds: [...menuItemIds],
    });
  }
}

export class MenuItemUnavailableError extends DomainError {
  constructor(
    readonly menuItemId: string,
    readonly availability: string,
  ) {
    super('MENU_ITEM_UNAVAILABLE', 'Menu item is not currently orderable', {
      menuItemId,
      availability,
    });
  }
}

export class DailyQuotaExhaustedError extends DomainError {
  constructor(readonly menuItemIds: readonly string[]) {
    super('DAILY_QUOTA_EXHAUSTED', 'Daily supply for one or more items is exhausted', {
      menuItemIds: [...menuItemIds],
    });
  }
}

export class PickupTimeNotFeasibleError extends DomainError {
  constructor(message: string, details: Record<string, unknown>) {
    // A dedicated code, not `VALIDATION_ERROR`. Sharing that code made an
    // unusable pickup slot indistinguishable from a malformed request body —
    // both surfaced as 400 — so a client could not tell which field to fix.
    super('PICKUP_TIME_NOT_FEASIBLE', message, details);
  }
}

/**
 * The order is not waiting for money — already paid, cancelled, expired, or
 * completed. 409, not 400: the request was well-formed, the state moved on.
 */
export class PaymentNotRequiredError extends DomainError {
  constructor(orderId: string, status: string) {
    super('PAYMENT_NOT_REQUIRED', `訂單目前狀態為 ${status}，無需付款`, { orderId, status });
  }
}

/** The provider refused to open a payment session. A 502 — it is not the client's fault. */
export class PaymentIntentFailedError extends DomainError {
  constructor(orderId: string, reason: string) {
    super('PAYMENT_INTENT_FAILED', '無法建立付款，請稍後再試或改用其他付款方式', {
      orderId,
      reason,
    });
  }
}

export class ConcurrentOrderModificationError extends DomainError {
  constructor(orderId: string, expectedStatus: string) {
    super(
      'ILLEGAL_ORDER_TRANSITION',
      `Order ${orderId} was modified by another request while it was ${expectedStatus}`,
      { orderId, expectedStatus },
    );
  }
}

/**
 * The same `Idempotency-Key` was submitted twice.
 *
 * Raised by the repository when `orders.idempotency_key` collides, and by the
 * controller when the Redis fast-path lock says somebody already holds it. It
 * lives here rather than in the controller because the durable guard is the
 * unique index — the controller is only the first of the two places that can
 * detect it.
 *
 * 409 with a machine-readable code: a client that double-tapped should treat
 * this as "your order already exists", not as a server fault to retry.
 */
export class ConflictOnIdempotencyKey extends DomainError {
  constructor(idempotencyKey?: string) {
    super('DUPLICATE_IDEMPOTENCY_KEY', 'This Idempotency-Key has already been used', {
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }
}
