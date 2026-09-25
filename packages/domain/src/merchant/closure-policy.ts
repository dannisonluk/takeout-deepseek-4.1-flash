/**
 * 特別休息日 — a dated day the shop is shut.
 *
 * Two things are deliberately NOT modelled here:
 *
 *   - **No "special rest" vs "regular rest" distinction.** A shop that never
 *     opens on Mondays expresses that once, in its weekly operating hours
 *     (`isClosed`). A shop that is shut on one particular Monday writes a
 *     closure. The two mechanisms are the same rule seen from two angles, and
 *     giving the dated one a different *kind* of closure ("holiday" vs
 *     "maintenance") would be a taxonomy nobody queries by.
 *   - **No time range.** A closure is a whole trading day. Half-days are what
 *     the weekly hours already do, and a dated row that could also carry
 *     `opensAtMinute` would need its own overlap arithmetic against the weekly
 *     window — a second source of truth for "when are we open" that would
 *     disagree with the first the moment somebody edited one and not the other.
 *
 * The `reason` is a LABEL, not a rule. It changes what the customer is told and
 * nothing else — see `describeClosure`.
 */

/** Why the shop is shut. Free of behaviour; presentational only. */
export enum ClosureReason {
  PUBLIC_HOLIDAY = 'PUBLIC_HOLIDAY',
  STAFF_HOLIDAY = 'STAFF_HOLIDAY',
  PRIVATE_EVENT = 'PRIVATE_EVENT',
  MAINTENANCE = 'MAINTENANCE',
  OTHER = 'OTHER',
}

/** One dated closure, as the policy functions need to see it. */
export interface ClosureDay {
  /** `YYYY-MM-DD`, in the merchant's own timezone. */
  readonly serviceDate: string;
  readonly reason: ClosureReason;
  readonly note?: string | null;
}

/**
 * Is `serviceDate` listed as a closure?
 *
 * A `Set` lookup rather than an array scan: the caller builds the set once per
 * request and probes it for every slot in the walk, and a pickup grid is 96
 * candidates against a list that grows with how far ahead the shop plans.
 * Not a measured bottleneck — but the alternative is a nested loop that reads
 * as if it might be, which is its own cost.
 */
export function isClosedOn(closures: ReadonlySet<string>, serviceDate: string): boolean {
  return closures.has(serviceDate);
}

/**
 * The closures in `closures` that fall inside `[from, toInclusive]`, as a set.
 *
 * Bounded rather than "all of them": an availability query walks at most
 * `BOOKING_WINDOW_DAYS` and reads the same window from the shop's plan, so
 * pulling a shop's whole closure history into memory to answer "are we shut next
 * Tuesday" is work that grows forever while the answer stays 31 days wide.
 */
export function closuresWithin(
  closures: readonly ClosureDay[],
  from: string,
  toInclusive: string,
): Set<string> {
  const within = new Set<string>();
  for (const closure of closures) {
    if (closure.serviceDate >= from && closure.serviceDate <= toInclusive) {
      within.add(closure.serviceDate);
    }
  }
  return within;
}

/**
 * The sentence the customer sees, generated from the same value the server
 * enforces.
 *
 * Kept in the domain rather than typed into the front end for the usual reason:
 * a message written in two places drifts, and the one place it must not drift is
 * the explanation for why somebody's booking was cancelled.
 */
export function describeClosure(reason: ClosureReason, note?: string | null): string {
  const trimmed = note?.trim();
  if (trimmed) return trimmed;

  switch (reason) {
    case ClosureReason.PUBLIC_HOLIDAY:
      return '店家於公眾假期休息。';
    case ClosureReason.STAFF_HOLIDAY:
      return '店家員工休假，暫停營業。';
    case ClosureReason.PRIVATE_EVENT:
      return '店家當日有包場活動，暫停營業。';
    case ClosureReason.MAINTENANCE:
      return '店家當日暫停營業進行維修。';
    default:
      return '店家當日休息。';
  }
}

/**
 * The `statusReason` written onto each reservation the closure cancels.
 *
 * Separate from `describeClosure` on purpose: the customer-facing notice is the
 * shop speaking in its own words, while this is the audit trail saying *why the
 * system moved the booking*. A shop that writes a friendly note must not thereby
 * erase the fact that the cancellation came from a closure rather than from a
 * human tapping Cancel — the two are different events and only one of them is
 * reversible with an apology.
 */
export function closureCancellationReason(serviceDate: string): string {
  return `MERCHANT_CLOSED:${serviceDate}`;
}

/** Whether a `statusReason` was written by the closure sweep rather than a person. */
export function isClosureCancellationReason(reason: string | null): boolean {
  return reason?.startsWith('MERCHANT_CLOSED:') ?? false;
}
