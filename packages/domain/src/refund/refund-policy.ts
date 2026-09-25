import { RefundAmountInvalidError, RefundNoteRequiredError } from './refund.errors';
import { RefundReasonCode } from './refund-status';

/**
 * The rules for *filing* a request, kept separate from the lifecycle machine.
 *
 * The machine answers "may this ticket move from A to B". This file answers
 * "may this ticket exist at all" — a different question with different inputs
 * (the order's state, what the customer typed), and one that would otherwise end
 * up re-implemented inside the use case.
 */

/** A closed list, so the shop can triage. `OTHER` plus a note covers the rest. */
export const REFUND_REASON_CODES: readonly RefundReasonCode[] = Object.values(RefundReasonCode);

export function isRefundReasonCode(value: unknown): value is RefundReasonCode {
  return typeof value === 'string' && (REFUND_REASON_CODES as readonly string[]).includes(value);
}

export const REFUND_NOTE_MAX_LENGTH = 1000;
export const REFUND_REPLY_MAX_LENGTH = 1000;
export const REFUND_REFERENCE_MAX_LENGTH = 120;

/**
 * The customer's ask is **advisory**.
 *
 * It shapes the conversation and it must never be treated as an authorisation.
 * The platform is not in the money path here, so the only thing an amount can do
 * is inform — clamping it to the order total keeps the ticket honest, but a
 * request for less than the total is completely normal and must be allowed.
 */
export function validateRequestedAmount(
  amountMinor: number | null | undefined,
  orderTotalMinor: number,
): number | null {
  if (amountMinor === null || amountMinor === undefined) return null;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > orderTotalMinor) {
    throw new RefundAmountInvalidError(amountMinor, orderTotalMinor);
  }
  return amountMinor;
}

/**
 * Whether a freshly-filed request needs the customer to say more.
 *
 * `OTHER` with no note is unanswerable — the shop has nothing to act on — so it
 * is rejected at the edge rather than landing in a queue as a blank row.
 *
 * Exported as an `assert` rather than a predicate: every caller that asked
 * "needs a note?" immediately threw the same error, and a predicate invites one
 * of them to forget.
 */
export function assertNoteSupplied(
  reasonCode: RefundReasonCode,
  note?: string | null,
): void {
  if (note && note.trim().length > 0) return;
  if (reasonCode === RefundReasonCode.OTHER) {
    throw new RefundNoteRequiredError(reasonCode);
  }
}

/**
 * Kept for the write path's own validation and for tests, in terms of the
 * assert above so the two can never disagree.
 */
export function requiresNote(reasonCode: RefundReasonCode, note?: string | null): boolean {
  try {
    assertNoteSupplied(reasonCode, note);
    return false;
  } catch {
    return true;
  }
}
