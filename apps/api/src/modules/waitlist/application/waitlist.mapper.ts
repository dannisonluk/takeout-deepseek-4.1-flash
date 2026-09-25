import {
  QueuePosition,
  WaitlistActor,
  WaitlistPolicy,
  WaitlistStatus,
  WAITLIST_STATUS_LABEL,
  WAITLIST_STATUS_SHORT_LABEL,
  isTerminalWaitlistStatus,
} from '@takeout/domain';
import {
  PersistedWaitlistEntry,
} from '../domain/waitlist.repository.port';
import {
  CustomerQueueTicketView,
  MerchantQueueEntryView,
} from '../interface/waitlist.views';

export { WAITLIST_STATUS_LABEL, WAITLIST_STATUS_SHORT_LABEL };

/**
 * Rows → views.
 *
 * A separate module from the services because both the query service and the
 * transition use case need to project the same row, and a second `toView` is
 * how two endpoints end up labelling `CALLED` differently.
 *
 * The guest's ticket and the host's row are built by two functions on purpose:
 * see the note at the top of `waitlist.views.ts`. The host's row carries the
 * phone number and the version; the guest's never does, and keeping them apart
 * here is what makes that impossible to leak by adding a field in the wrong
 * place.
 */

/** What the guest's phone page renders. */
export function toCustomerTicket(
  entry: PersistedWaitlistEntry,
  position: QueuePosition,
  policy: Pick<WaitlistPolicy, 'callTimeoutMinutes' | 'customerNotice'>,
  now: Date,
): CustomerQueueTicketView {
  return {
    id: entry.id,
    ticketNo: entry.ticketNo,
    status: entry.status,
    statusLabel: WAITLIST_STATUS_LABEL[entry.status],
    partySize: entry.partySize,
    guestName: entry.guestName,
    joinedAt: entry.joinedAt.toISOString(),
    position: position.position,
    ahead: position.ahead,
    estimatedWaitMinutes: position.estimatedWaitMinutes,
    quotedMinutes: entry.quotedMinutes,
    calledAt: entry.calledAt?.toISOString() ?? null,
    callDeadlineAt: callDeadline(entry, policy, now),
    seatedAt: entry.seatedAt?.toISOString() ?? null,
    cancelledAt: entry.cancelledAt?.toISOString() ?? null,
    statusReason: entry.statusReason,
    // Only while still waiting. Once called, the shop is holding a table and
    // walking away without telling anyone is a no-show, not a cancellation —
    // the machine enforces the same rule, and this field is what stops the page
    // offering a button that would come back 409.
    canCancel:
      entry.status === WaitlistStatus.WAITING,
    customerNotice: policy.customerNotice,
  };
}

/** What the host board renders. Adds the contact and the permitted moves. */
export function toMerchantEntry(
  entry: PersistedWaitlistEntry,
  position: QueuePosition,
  policy: Pick<WaitlistPolicy, 'callTimeoutMinutes'>,
  allowedNextTransitions: readonly WaitlistStatus[],
  now: Date,
): MerchantQueueEntryView {
  return {
    id: entry.id,
    ticketNo: entry.ticketNo,
    status: entry.status,
    statusLabel: WAITLIST_STATUS_LABEL[entry.status],
    statusShortLabel: WAITLIST_STATUS_SHORT_LABEL[entry.status],
    partySize: entry.partySize,
    guestName: entry.guestName,
    contactPhone: entry.contactPhone,
    note: entry.note,
    joinedAt: entry.joinedAt.toISOString(),
    position: position.position,
    ahead: position.ahead,
    estimatedWaitMinutes: position.estimatedWaitMinutes,
    calledAt: entry.calledAt?.toISOString() ?? null,
    callDeadlineAt: callDeadline(entry, policy, now),
    seatedAt: entry.seatedAt?.toISOString() ?? null,
    cancelledAt: entry.cancelledAt?.toISOString() ?? null,
    statusReason: entry.statusReason,
    waitedMinutes: Math.max(
      0,
      Math.floor((now.getTime() - entry.joinedAt.getTime()) / 60_000),
    ),
    version: entry.version,
    allowedNextTransitions: [...allowedNextTransitions],
  };
}

/**
 * When a called guest's time runs out, or `null`.
 *
 * Derived from `calledAt` and the policy rather than read from a column: the
 * domain's `transition` sets `callDeadlineAt` on the *result*, but the row has
 * no such field, and inventing one would mean two sources of truth for a value
 * that is a pure function of two others. The board renders a countdown from
 * this, and the sweep computes the same instant from the same two inputs.
 */
export function callDeadline(
  entry: Pick<PersistedWaitlistEntry, 'status' | 'calledAt'>,
  policy: Pick<WaitlistPolicy, 'callTimeoutMinutes'>,
  _now: Date,
): string | null {
  if (entry.status !== WaitlistStatus.CALLED || !entry.calledAt) return null;
  return new Date(
    entry.calledAt.getTime() + policy.callTimeoutMinutes * 60_000,
  ).toISOString();
}

/** Whether a ticket still counts toward the live queue. */
export function isLive(entry: Pick<PersistedWaitlistEntry, 'status'>): boolean {
  return !isTerminalWaitlistStatus(entry.status);
}

export {
  WaitlistActor,
  WaitlistStatus,
  type PersistedWaitlistEntry,
};
