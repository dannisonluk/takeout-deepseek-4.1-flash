import { DomainError } from '../shared/index';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the API's exception filter. */

export class RefundRequestNotFoundError extends DomainError {
  constructor(refundRequestId: string) {
    super('REFUND_REQUEST_NOT_FOUND', 'Refund request not found', { refundRequestId });
  }
}

/**
 * A request is already being worked.
 *
 * Distinct from a plain validation error because the customer's fix is specific
 * — wait for the shop, or withdraw the open one. Filing a second ticket while
 * the first is live splits the conversation across two threads and makes the
 * shop's queue lie about how many problems it has.
 */
export class RefundRequestAlreadyOpenError extends DomainError {
  constructor(
    readonly orderId: string,
    readonly existingRefundRequestId: string,
  ) {
    super('REFUND_REQUEST_ALREADY_OPEN', '此訂單已有一張待處理的退款申請', {
      orderId,
      existingRefundRequestId,
    });
  }
}

/**
 * The order this is filed against has no payment to ask about.
 *
 * Separate from `REFUND_NOT_AVAILABLE` (the admin money-path refund, which this
 * feature deliberately does not touch) so that the two never get confused in a
 * log or in a support conversation.
 */
export class RefundRequestNotAllowedError extends DomainError {
  constructor(
    readonly orderId: string,
    readonly orderStatus: string,
  ) {
    super('REFUND_REQUEST_NOT_ALLOWED', '此訂單的狀態無法提出退款申請', {
      orderId,
      orderStatus,
    });
  }
}

export class RefundRequestNotPermittedError extends DomainError {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly actor: string,
    readonly allowed: readonly string[],
  ) {
    super(
      'REFUND_REQUEST_NOT_PERMITTED',
      `${actor} 不能把退款申請由 ${from} 改成 ${to}`,
      { from, to, actor, allowed: [...allowed] },
    );
  }
}

export class RefundRequestAlreadyTerminalError extends DomainError {
  constructor(readonly from: string) {
    super('REFUND_REQUEST_ALREADY_TERMINAL', `退款申請已是 ${from}，不能再變更`, { from });
  }
}

/**
 * The shop says it is done, but did not say what it handed over.
 *
 * A `RESOLVED_OFFLINE` ticket with no amount and no reference is a ticket that
 * records nothing — it would let a shop close a queue item by pressing a button
 * while the customer is still waiting. At least one of the two is required.
 */
export class RefundSettlementDetailsRequiredError extends DomainError {
  constructor(readonly refundRequestId: string) {
    super(
      'REFUND_SETTLEMENT_DETAILS_REQUIRED',
      '標記為已線下處理時，需要填寫金額或參考編號',
      { refundRequestId },
    );
  }
}

/**
 * `OTHER` with nothing written in the note.
 *
 * Refused at the edge rather than stored: a ticket that says only "other" is
 * unanswerable, so it would sit in the shop's queue as a blank row and cost
 * both sides a round trip. A distinct code from the amount error because the
 * fix is different — this one is "say what happened".
 */
export class RefundNoteRequiredError extends DomainError {
  constructor(readonly reasonCode: string) {
    super('REFUND_NOTE_REQUIRED', '選擇「其他原因」時需要填寫說明', { reasonCode });
  }
}

/** An amount that is not a positive whole number of minor units. */
export class RefundAmountInvalidError extends DomainError {
  constructor(
    readonly amountMinor: number,
    readonly orderTotalMinor: number,
  ) {
    super('REFUND_AMOUNT_INVALID', '退款金額不合法', {
      amountMinor,
      orderTotalMinor,
    });
  }
}
