import { DomainError } from '@takeout/domain';

/**
 * 店內點餐 — the failures this context can produce that the domain does not
 * already name.
 *
 * `DiningSessionClosedError` and `DiningSessionConflictError` live in the domain
 * package because they are rules about the state machine and must be unit-
 * testable with no database. What is here is the persistence-shaped failure the
 * domain cannot know about: a row that was expected to be there and is not.
 */

/** No table carries this QR token — a scanned code that was rotated or forged. */
export class DiningTableNotFoundError extends DomainError {
  constructor(readonly token: string) {
    super('DINING_TABLE_NOT_FOUND', '找不到此代碼對應的桌號，可能已被重新產生。', { token });
  }
}

/** No such table on this shop's floor plan. */
export class DiningTableIdNotFoundError extends DomainError {
  constructor(readonly tableId: string) {
    super('DINING_TABLE_NOT_FOUND', '找不到指定的桌號。', { tableId });
  }
}

/** Two writers raced on one sitting; the conditional UPDATE matched nothing. */
export class ConcurrentDiningModificationError extends DomainError {
  constructor(
    readonly sessionId: string,
    readonly expectedStatus: string,
  ) {
    super('DINING_NOT_PERMITTED', '此餐桌狀態已被其他人更新，請重新載入後再試。', {
      sessionId,
      expectedStatus,
    });
  }
}

/** The table is on the floor plan but switched off. */
export class DiningTableInactiveError extends DomainError {
  constructor(readonly tableCode: string) {
    super('DINING_TABLE_INACTIVE', `桌號 ${tableCode} 目前未啟用。`, { tableCode });
  }
}

/** The sitting does not exist, or is not this merchant's. */
export class DiningSessionNotFoundError extends DomainError {
  constructor(readonly sessionId: string) {
    super('DINING_SESSION_NOT_FOUND', '找不到指定的用餐時段。', { sessionId });
  }
}
