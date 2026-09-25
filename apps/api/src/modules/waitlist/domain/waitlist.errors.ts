import { DomainError } from '@takeout/domain';

/**
 * Waitlist errors that belong to the API layer rather than the domain.
 *
 * The distinction is deliberate and worth one paragraph: `packages/domain`
 * declares every refusal the *state machine* can produce — "that move does not
 * exist", "not yours to make", "already terminal" — because those are the rules
 * the machine owns. What lives here is the class of failure that only exists
 * once there is a database: a row that another writer moved between our read
 * and our write.
 *
 * Putting `ConcurrentWaitlistModificationError` in the domain would mean the
 * pure package had an error about transactions in it, which it has no other
 * example of and no way to unit-test.
 */

/**
 * Two writers raced on one ticket.
 *
 * Surfaced as 409: the request was well-formed, the ticket moved underneath it,
 * and retrying with fresh state is the instruction. It is deliberately the SAME
 * code as `WAITLIST_NOT_PERMITTED` rather than a new one — both mean "this move
 * did not happen, reload and try again", and a distinct code would need a
 * distinct mapping with no distinct behaviour behind it.
 */
export class ConcurrentWaitlistModificationError extends DomainError {
  constructor(waitlistEntryId: string, expectedStatus: string) {
    super('WAITLIST_NOT_PERMITTED', '此候位號碼已由其他操作更新，請重新整理', {
      waitlistEntryId,
      expectedStatus,
    });
  }
}

/**
 * The shop has no queue to configure.
 *
 * Its own code rather than reusing `WAITLIST_DISABLED`: that one is what a GUEST
 * is told when the feature is off ("this shop does not do queues"), and telling
 * a merchant's own settings screen the same thing would be reporting their
 * configuration back to them as a customer-facing refusal.
 */
export class WaitlistSettingsNotFoundError extends DomainError {
  constructor(merchantId: string) {
    super('WAITLIST_ENTRY_NOT_FOUND', '找不到此商戶的候位設定', { merchantId });
  }
}
