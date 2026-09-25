import { DomainError } from '@takeout/domain';

/**
 * Payment-rail errors.
 *
 * Codes line up with `DOMAIN_CODE_TO_STATUS` in the exception filter. They live
 * here rather than in `ordering.errors.ts` because they are about *how money is
 * taken*, not about the order lifecycle — the ordering error file was already
 * carrying `PaymentIntentFailedError` and `PaymentNotRequiredError`, which made
 * "which context owns this rule?" unanswerable from the file path.
 */

/**
 * The rail exists but this deployment holds no credentials for it.
 *
 * 422, not 400: the request was well-formed and the rail name was valid. The
 * deployment simply cannot take that payment, and no edit to the payload fixes
 * it. The message names the environment variables, because "PAYME is not
 * configured" without them is a support ticket rather than a diagnosis.
 */
export class PaymentRailUnavailableError extends DomainError {
  constructor(
    readonly provider: string,
    readonly envVars: string,
  ) {
    super('PAYMENT_RAIL_UNAVAILABLE', `${provider} 尚未設定，無法使用此付款方式`, {
      provider,
      envVars,
    });
  }
}

/** A rail name that is not in the registry at all — a typo, not a config gap. */
export class UnknownPaymentProviderError extends DomainError {
  constructor(
    readonly provider: string,
    readonly known: readonly string[],
  ) {
    super('UNKNOWN_PAYMENT_PROVIDER', `不支援的付款方式：${provider}`, {
      provider,
      known: [...known],
    });
  }
}

/**
 * The callback did not prove it came from the acquirer — a missing header or a
 * signature that does not match.
 *
 * 401, and deliberately **not** a 500. Left as a bare `Error`, this reached the
 * exception filter unmapped and became `INTERNAL_ERROR`, which tells a webhook
 * sender "our fault, retry" — so a forged or stale-signature payload is retried
 * on a backoff forever, and the operator sees an alert about a server bug
 * instead of a rejected forgery.
 */
export class InvalidWebhookSignatureError extends DomainError {
  constructor(
    readonly provider: string,
    readonly detail: string,
  ) {
    super('INVALID_WEBHOOK_SIGNATURE', `${provider} 回呼簽章驗證失敗`, { provider, detail });
  }
}

/**
 * The signature cannot be checked because this deployment has no secret for the
 * rail.
 *
 * 503 rather than 401: the payload may be perfectly genuine, we are simply
 * unable to tell. A retry is the right instruction — once an operator restores
 * the secret, the same delivery will verify.
 */
export class WebhookNotConfiguredError extends DomainError {
  constructor(
    readonly provider: string,
    readonly envVar: string,
  ) {
    super('WEBHOOK_NOT_CONFIGURED', `${provider} 回呼密鑰未設定，無法驗證簽章`, {
      provider,
      envVar,
    });
  }
}
