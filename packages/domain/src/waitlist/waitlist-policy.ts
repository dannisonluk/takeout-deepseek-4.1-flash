import { WaitlistPartySizeError } from './waitlist.errors';
import { WaitlistPolicy, WaitlistStatus } from './waitlist-status';

/**
 * 現場候位 — the pure queue arithmetic.
 *
 * Two things live here, both of which a host will argue about with a guest, so
 * both need to be one definition rather than three:
 *
 *   1. **The ticket number.** `A-014` — a letter per trading day, a counter that
 *      resets daily. Guests remember letters; a global monotonic id reaching
 *      `#4821` tells a guest nothing about how long they will wait.
 *   2. **The estimate.** Derived from the guests already ahead of them, not
 *      from a stopwatch. It is labelled an estimate everywhere it appears,
 *      because a shop cannot be held to it and pretending otherwise turns a
 *      helpful number into a promise the host has to break.
 */

/** The number shown to a guest, and the ordering key behind it. */
export interface QueuePosition {
  /** 1-based position among the tickets still ahead or equal. */
  readonly position: number;
  /** How many active tickets are ahead of this one. */
  readonly ahead: number;
  /** Rough minutes until they are called. `null` when it cannot be estimated. */
  readonly estimatedWaitMinutes: number | null;
}

/** The minimum a ticket must expose for the arithmetic. */
export interface QueueTicket {
  readonly id: string;
  readonly status: WaitlistStatus;
  readonly joinedAt: Date;
  readonly calledAt: Date | null;
}

/**
 * Where a guest sits in the queue.
 *
 * Position is **computed on read, never stored**. A stored position would have
 * to be renumbered on every cancellation, and that renumbering write is exactly
 * what races between two hosts working the same board. Sorting by `joinedAt`
 * makes cancellation self-healing: the rows do not move, the count in front of
 * you simply drops.
 *
 * `CALLED` tickets are counted as ahead. They have not been seated yet, so the
 * kitchen is still working through them — omitting them would quote a guest a
 * wait that the host knows is wrong.
 */
export function queuePosition(
  tickets: readonly QueueTicket[],
  targetId: string,
  policy: Pick<WaitlistPolicy, 'averageTurnMinutes'>,
): QueuePosition {
  // The queue is total order by join time; the id breaks ties so two tickets
  // stamped in the same millisecond do not swap places between two reads.
  const ordered = [...tickets]
    .filter(
      (ticket) =>
        ticket.status === WaitlistStatus.WAITING || ticket.status === WaitlistStatus.CALLED,
    )
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id.localeCompare(b.id));

  const index = ordered.findIndex((ticket) => ticket.id === targetId);
  if (index === -1) {
    // Cancelled, seated, or never queued: no position to report. Not an error —
    // the guest's own page polls this and must survive their ticket ending.
    return { position: 0, ahead: 0, estimatedWaitMinutes: null };
  }

  const ahead = index;

  return {
    position: index + 1,
    ahead,
    estimatedWaitMinutes: estimateWaitMinutes(ahead, tickets, policy),
  };
}

/**
 * Rough minutes until this guest is called.
 *
 * The party ahead of them may be a table of two or a table of nine, and the
 * ticket does not know the tables. So the estimate is `ahead × averageTurn`,
 * and the *floor* of one turn is applied as soon as anybody is ahead: quoting
 * "2 minutes" to the second person in a queue with a 45-minute turn is worse
 * than quoting nothing, because they will stand at the counter.
 *
 * Head-of-queue returns `0` rather than a turn length — they are next, and the
 * copy reads "下一位".
 */
export function estimateWaitMinutes(
  ahead: number,
  tickets: readonly QueueTicket[],
  policy: Pick<WaitlistPolicy, 'averageTurnMinutes'>,
): number {
  if (ahead <= 0) return 0;

  const turn = Math.max(1, Math.round(policy.averageTurnMinutes));

  // A called party is already being walked to a table, so their own turn is
  // half spent from the point of view of someone behind them. Ignoring that
  // makes the quote visibly pessimistic whenever the host is mid-seating.
  const calledAhead = tickets.filter((ticket) => ticket.status === WaitlistStatus.CALLED).length;
  const waitingAhead = Math.max(0, ahead - calledAhead);

  return calledAhead * Math.ceil(turn / 2) + waitingAhead * turn;
}

/**
 * Build the next ticket number for a trading day.
 *
 * Format is `<letter><dash><3 digits>`: `A-001`, `A-014`. The letter is fixed
 * per day rather than rotating through the alphabet — a guest who is told "A14"
 * goes home, comes back and asks for "A14" again; if the letter had rotated in
 * between, nobody would find their ticket.
 *
 * `existing` is the set of numbers already issued today. Gaps are **not**
 * reused: after `A-014` is cancelled the next ticket is `A-015`, because
 * reusing `A-014` means two different parties were briefly holding the same
 * number, and one of them is still in the corridor.
 */
export function nextTicketNo(existing: readonly string[], dayLetter = 'A'): string {
  let highest = 0;
  for (const ticket of existing) {
    const match = /^([A-Z])-(\d{1,4})$/.exec(ticket.trim().toUpperCase());
    if (!match) continue;
    const digits = match[2];
    if (digits === undefined) continue;
    const value = Number.parseInt(digits, 10);
    if (Number.isFinite(value) && value > highest) highest = value;
  }
  return `${dayLetter}-${String(highest + 1).padStart(3, '0')}`;
}

/**
 * The letter for a trading day.
 *
 * A stable, deterministic function of the date — **not** a rotating counter
 * held somewhere. The same date must always yield the same letter on a second
 * server and after a restart, or a guest's ticket number changes meaning
 * overnight.
 */
export function dayLetterFor(serviceDate: string): string {
  // Sum of the date's digits, mapped into A–H. Deterministic, and spread wide
  // enough that two consecutive days rarely share a letter.
  const digits = serviceDate.replace(/\D/g, '');
  let sum = 0;
  for (const char of digits) sum += Number.parseInt(char, 10);
  return String.fromCharCode(65 + (sum % 8));
}

/** Whether a party size is one this shop seats. */
export function assertPartySize(partySize: number, policy: WaitlistPolicy): void {
  const value = Math.trunc(partySize);
  if (!Number.isFinite(value) || value < policy.minPartySize || value > policy.maxPartySize) {
    throw new WaitlistPartySizeError(policy.minPartySize, policy.maxPartySize);
  }
}

/**
 * Hold a guest to a sane contact and name.
 *
 * Trimmed and length-capped here rather than only in the DTO, so the rules hold
 * for any caller — including the seed script and the e2e suite, which do not go
 * through `class-validator`.
 */
export function normalizeGuestName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return trimmed.slice(0, 80);
}

export function normalizePhone(phone: string): string {
  return phone.trim().replace(/[\s-]/g, '').slice(0, 32);
}

/**
 * Normalise a table code printed on a QR label.
 *
 * Uppercased and stripped of anything that is not alphanumeric, because a code
 * arrives from a URL path segment a human may have typed from a label, and
 * `a12`, `A-12` and `A 12` are the same table.
 */
export function normalizeTableCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

