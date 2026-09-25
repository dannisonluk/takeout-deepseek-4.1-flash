import { Actor } from '../../../common/auth/actor';

/**
 * The audit identity for a walk-in diner.
 *
 * A dine-in guest has no account and never will — the shop's decision was to
 * issue a one-time code at seating rather than make people register to eat. But
 * the audit log's `actorId` is a real column with a foreign key, so the choice
 * is between a synthetic identity and a null actor.
 *
 * Synthetic, on purpose: "who changed this" is a question that must always have
 * an answer, and `SYSTEM` would be a lie — a person did it. An empty id is
 * recorded as an unattributed guest action, which the audit view renders as
 * 現場客人 rather than as a missing value.
 */
export const DINING_GUEST_ACTOR: Actor = {
  userId: '',
  role: 'CUSTOMER' as never,
  ip: null,
};

/** The display name a provisioned per-sitting guest row carries. */
export function guestDisplayName(tableCode: string): string {
  return `現場客人 ${tableCode}`;
}
