import { DomainError } from '../shared/index';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the API's exception filter. */

// ============================================================================
//  Walk-in waitlist
// ============================================================================

/** The guest asked for a party size the shop does not seat. */
export class WaitlistPartySizeError extends DomainError {
  constructor(min: number, max: number) {
    super('WAITLIST_PARTY_SIZE', `人數需介乎 ${min} 至 ${max} 人之間`, { min, max });
  }
}

/** The queue is switched off. */
export class WaitlistDisabledError extends DomainError {
  constructor(merchantId: string) {
    super('WAITLIST_DISABLED', '此店家目前未提供現場候位', { merchantId });
  }
}

/**
 * The shop is shut and does not take tickets while shut.
 *
 * Deliberately **not** the same code as `WAITLIST_DISABLED`: one means "come
 * back when we are open", the other means "this shop does not do queues". The
 * page shows different copy and the guest takes a different action.
 */
export class WaitlistClosedError extends DomainError {
  constructor(merchantId: string) {
    super('WAITLIST_CLOSED', '店家尚未營業，暫停派發候位號碼', { merchantId });
  }
}

/** One guest, one live ticket. */
export class WaitlistAlreadyQueuedError extends DomainError {
  constructor(existingId: string, ticketNo: string) {
    super('WAITLIST_ALREADY_QUEUED', `你已有一張候位號碼 ${ticketNo}`, {
      waitlistEntryId: existingId,
      ticketNo,
    });
  }
}

/** Someone else's ticket, or nobody's. Answered as 404 at the controller. */
export class WaitlistEntryNotFoundError extends DomainError {
  constructor(waitlistEntryId: string) {
    super('WAITLIST_ENTRY_NOT_FOUND', '找不到此候位號碼', { waitlistEntryId });
  }
}

/** The ticket is already seated, cancelled or a no-show. */
export class WaitlistAlreadyTerminalError extends DomainError {
  constructor(status: string) {
    super('WAITLIST_ALREADY_TERMINAL', `此候位號碼已結束（${status}），無法再變更`, { status });
  }
}

/** The move does not exist from here. */
export class WaitlistNotPermittedError extends DomainError {
  constructor(from: string, to: string, actor: string, allowed: readonly string[]) {
    super(
      'WAITLIST_NOT_PERMITTED',
      `無法由 ${from} 轉為 ${to}（${actor}）${allowed.length ? `，可轉為：${allowed.join(' / ')}` : ''}`,
      { from, to, actor, allowed: [...allowed] },
    );
  }
}

/** Reachable, but not by this actor — the "not yours to make" case. */
export class WaitlistActorNotPermittedError extends DomainError {
  constructor(from: string, to: string, actor: string, allowed: readonly string[]) {
    super(
      'WAITLIST_ACTOR_NOT_PERMITTED',
      `${actor} 不能將候位由 ${from} 轉為 ${to}${allowed.length ? `，可執行者：${allowed.join(' / ')}` : ''}`,
      { from, to, actor, allowed: [...allowed] },
    );
  }
}

/**
 * Two writers raced on one ticket.
 *
 * Surfaced as 409: the request was well-formed, the ticket moved underneath it.
 */
export class ConcurrentWaitlistModificationError extends DomainError {
  constructor(waitlistEntryId: string, expectedStatus: string) {
    super('WAITLIST_NOT_PERMITTED', '此候位號碼已由其他操作更新，請重新整理', {
      waitlistEntryId,
      expectedStatus,
    });
  }
}

// ============================================================================
//  In-store dining
// ============================================================================

/** A table code or QR token that does not exist / is switched off. */
export class DiningTableNotFoundError extends DomainError {
  constructor(code: string) {
    super('DINING_TABLE_NOT_FOUND', '找不到此桌號，請向店員確認 QR 碼', { code });
  }
}

/** The QR token is stale — the shop rotated it, or the table was switched off. */
export class DiningTableInactiveError extends DomainError {
  constructor(tableId: string) {
    super('DINING_TABLE_INACTIVE', '此桌號已停用，請向店員索取新的 QR 碼', { tableId });
  }
}

/**
 * A table with this code already exists on the floor plan.
 *
 * Reached only after `normalizeTableCode` has canonicalised the input, so
 * `A 12` and `a-12` both collide with the stored `A12` — which is the point.
 * Surfaced as a 409 rather than letting the underlying unique-constraint
 * violation escape as a 500: a shop typing a code it already uses is an
 * ordinary mistake, and the answer is "that table already exists", not "the
 * server broke".
 */
export class DiningTableCodeTakenError extends DomainError {
  constructor(code: string) {
    super('DINING_TABLE_CODE_TAKEN', `桌號 ${code} 已存在`, { code });
  }
}

/**
 * A table can only have one open sitting.
 *
 * Also used for the "close to a non-terminal state" guard, because both are the
 * same failure: the caller asked for a sitting invariant that cannot hold.
 */
export class DiningSessionConflictError extends DomainError {
  constructor(tableId: string, existingId: string) {
    super('DINING_SESSION_CONFLICT', '此桌已有進行中的用餐時段', {
      tableId,
      conflictingDiningSessionId: existingId,
    });
  }
}

export class DiningSessionNotFoundError extends DomainError {
  constructor(diningSessionId: string) {
    super('DINING_SESSION_NOT_FOUND', '找不到此用餐時段', { diningSessionId });
  }
}

/** The sitting is closed; a new order would be a tab nobody is going to pay for. */
export class DiningSessionClosedError extends DomainError {
  constructor(status: string) {
    super('DINING_SESSION_CLOSED', `此用餐時段已結束（${status}），無法再加點`, { status });
  }
}
