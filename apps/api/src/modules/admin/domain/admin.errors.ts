import { DomainError } from '@takeout/domain';

/**
 * Admin-console errors.
 *
 * Each carries a machine-readable code so `DomainExceptionFilter` can map it to
 * the right HTTP status and the console can react to the specific case rather
 * than parsing a message.
 */

/** A referenced row does not exist. `resource` names it, e.g. `User`. */
export class AdminTargetNotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('ADMIN_TARGET_NOT_FOUND', `找不到指定的${resource}`, { resource, id });
  }
}

/**
 * Refusing to remove the last usable admin.
 *
 * Without this the platform can be locked out of its own console: an admin
 * demotes themselves, and there is no longer anyone who can promote anyone.
 */
export class LastAdminError extends DomainError {
  constructor(reason: string) {
    super('LAST_ADMIN', `不可移除最後一位管理員：${reason}`);
  }
}

/** An admin may not change their own privileged fields — that needs a peer. */
export class SelfModificationError extends DomainError {
  constructor(field: string) {
    super('SELF_MODIFICATION', `不可修改自己的 ${field}，請由另一位管理員操作`, { field });
  }
}

/** A `platform_config` value failed validation for its key. */
export class PlatformConfigInvalidError extends DomainError {
  constructor(key: string, reason: string) {
    super('PLATFORM_CONFIG_INVALID', `設定「${key}」不合法：${reason}`, { key, reason });
  }
}

/**
 * A config key that is load-bearing for historical data and therefore frozen.
 * Today: none. Kept because the alternative — a key that looks editable but
 * silently does nothing — is worse than an explicit refusal.
 */
export class PlatformConfigReadOnlyError extends DomainError {
  constructor(key: string) {
    super('PLATFORM_CONFIG_READONLY', `設定「${key}」為系統保留，不可修改`, { key });
  }
}

/** Only `FAILED` or `DEAD_LETTER` events may be requeued. */
export class OutboxEventNotRetryableError extends DomainError {
  constructor(eventId: string, status: string) {
    super('OUTBOX_NOT_RETRYABLE', `事件狀態為 ${status}，無需重試`, { eventId, status });
  }
}

/** A payout may only be settled from `PENDING` or `FAILED`. */
export class PayoutNotSettleableError extends DomainError {
  constructor(payoutId: string, status: string) {
    super('PAYOUT_NOT_SETTLEABLE', `此結算單狀態為 ${status}，不可標記為已付款`, {
      payoutId,
      status,
    });
  }
}

/** A refund was requested for an order that has no captured payment. */
export class RefundNotAvailableError extends DomainError {
  constructor(orderId: string) {
    super('REFUND_NOT_AVAILABLE', '此訂單沒有已收款項，無法退款', { orderId });
  }
}

/** The requested refund is larger than the amount still refundable. */
export class RefundExceedsCaptureError extends DomainError {
  constructor(requestedMinor: number, refundableMinor: number) {
    super('REFUND_EXCEEDS_CAPTURE', '退款金額超過可退款餘額', {
      requestedMinor,
      refundableMinor,
    });
  }
}
