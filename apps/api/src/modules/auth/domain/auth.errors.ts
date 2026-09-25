import { DomainError } from '@takeout/domain';

/**
 * Auth failures.
 *
 * Codes are registered in `DOMAIN_CODE_TO_STATUS`, so each one maps to a
 * deliberate HTTP status rather than falling through to a generic 500.
 */

/** Wrong code, expired code, or already-consumed code — one indistinguishable 401. */
export class InvalidOtpError extends DomainError {
  constructor(details: Record<string, unknown> = {}) {
    // Deliberately one message for all three cases: telling an attacker
    // "that code was right but expired" is free information.
    super('INVALID_OTP', '驗證碼不正確或已失效', details);
  }
}

export class OtpRateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super('OTP_RATE_LIMITED', '要求驗證碼過於頻繁，請稍後再試', { retryAfterSeconds });
  }
}

/** Refresh token missing, expired, revoked, or already rotated. */
export class SessionExpiredError extends DomainError {
  constructor(reason = '登入狀態已失效，請重新登入') {
    super('SESSION_EXPIRED', reason);
  }
}

export class AccountDisabledError extends DomainError {
  constructor() {
    super('ACCOUNT_DISABLED', '此帳號已被停用，請聯絡平台客服');
  }
}

/** The token is valid but the principal lacks the required role. */
export class InsufficientRoleError extends DomainError {
  constructor(required: string, actual: string) {
    super('FORBIDDEN', `此操作需要 ${required} 權限`, { required, actual });
  }
}
