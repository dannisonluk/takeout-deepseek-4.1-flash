/**
 * Pickup-slot policy — the single source of truth for "may this order be
 * collected at this time".
 *
 * `PlaceOrderUseCase` validates against these rules, and the public
 * `GET /merchants/:slug/pickup-slots` endpoint generates the slots the customer
 * picks from. They live in one file on purpose: if the two ever diverge, the
 * customer app offers a time that the order endpoint then rejects, and the
 * customer blames the restaurant for a platform bug.
 */
import { localDateString, localDayOfWeek, minutesSinceLocalMidnight } from './service-date';

/** The kitchen needs a head start beyond its own prep time. */
export const MIN_LEAD_TIME_MINUTES = 5;
/** How far ahead a self-pickup order may be scheduled. */
export const MAX_ADVANCE_HOURS = 24;
/** Granularity of the offered slots. */
export const SLOT_STEP_MINUTES = 15;

export interface OperatingWindow {
  readonly dayOfWeek: number;
  readonly opensAtMinute: number;
  readonly closesAtMinute: number;
  readonly isClosed: boolean;
}

export type OpeningCheck =
  | { readonly open: true; readonly window: OperatingWindow }
  /**
   * No hours configured at all. Deliberately *not* treated as "closed": a
   * merchant who has not filled in their hours yet must still be able to take
   * orders, otherwise onboarding deadlocks.
   */
  | { readonly open: false; readonly reason: 'NO_HOURS_CONFIGURED' }
  | { readonly open: false; readonly reason: 'CLOSED_TODAY'; readonly dayOfWeek: number }
  /**
   * A dated 特別休息日. Reported separately from `CLOSED_TODAY` so the customer
   * is told the truth: "this shop does not trade on Mondays" and "this shop is
   * shut this particular Monday" are the same refusal but very different
   * messages, and the second one is the shop's own doing.
   */
  | { readonly open: false; readonly reason: 'CLOSED_FOR_CLOSURE'; readonly serviceDate: string }
  | {
      readonly open: false;
      readonly reason: 'OUTSIDE_HOURS';
      readonly dayOfWeek: number;
      readonly minuteOfDay: number;
      readonly window: OperatingWindow;
    };

/**
 * Is the merchant open at `at`?
 *
 * Both the weekday and the minute-of-day are resolved in the merchant's own
 * timezone, never the server's — a 23:30 UTC request is 07:30 the next day in
 * Hong Kong, and the two answers differ by a whole trading day.
 *
 * `closures` is optional and, when supplied, is the set of `YYYY-MM-DD` service
 * dates the shop has marked shut. It is checked BEFORE the weekly pattern: a
 * closure is an exception to the week, so it has to win, and a shop that closes
 * for a public holiday must not be kept open by its own `isClosed: false`
 * Tuesday row. Callers that have no closure data (the onboarding path, the
 * legacy tests) pass nothing and get the old behaviour exactly.
 */
export function checkOpening(
  hours: readonly OperatingWindow[],
  timeZone: string,
  at: Date,
  closures?: ReadonlySet<string>,
): OpeningCheck {
  // Closures are checked first and independently of `hours`: a shop that has
  // not configured any hours is still shut on a day it explicitly closed, and
  // the NO_HOURS_CONFIGURED escape hatch must not reopen it.
  if (closures && closures.size > 0) {
    const serviceDate = localDateString(timeZone, at);
    if (closures.has(serviceDate)) {
      return { open: false, reason: 'CLOSED_FOR_CLOSURE', serviceDate };
    }
  }

  if (hours.length === 0) return { open: false, reason: 'NO_HOURS_CONFIGURED' };

  const dayOfWeek = localDayOfWeek(timeZone, at);
  const minuteOfDay = minutesSinceLocalMidnight(timeZone, at);
  const window = hours.find((entry) => entry.dayOfWeek === dayOfWeek);

  if (!window || window.isClosed) return { open: false, reason: 'CLOSED_TODAY', dayOfWeek };

  // Inclusive at both ends: a merchant open 11:00–22:00 accepts 22:00.
  if (minuteOfDay < window.opensAtMinute || minuteOfDay > window.closesAtMinute) {
    return { open: false, reason: 'OUTSIDE_HOURS', dayOfWeek, minuteOfDay, window };
  }

  return { open: true, window };
}

/** The soonest a customer may collect: now + prep time + the platform's lead time. */
export function earliestPickupAt(now: Date, prepTimeMinutes: number): Date {
  return new Date(now.getTime() + (prepTimeMinutes + MIN_LEAD_TIME_MINUTES) * 60_000);
}

/** The furthest ahead a customer may schedule. */
export function latestPickupAt(now: Date): Date {
  return new Date(now.getTime() + MAX_ADVANCE_HOURS * 3_600_000);
}

/**
 * Round a wall-clock time up to the next slot boundary.
 *
 * Alignment is on the *local* minute of the day, so the slots a customer sees
 * are 12:00 / 12:15 / 12:30 rather than 12:07 / 12:22. The seconds are dropped
 * first, which relies on the timezone offset being a whole number of minutes —
 * true for every zone in current use.
 */
export function roundUpToSlot(
  at: Date,
  timeZone: string,
  stepMinutes: number = SLOT_STEP_MINUTES,
): Date {
  const wholeMinute = new Date(Math.ceil(at.getTime() / 60_000) * 60_000);
  const remainder = minutesSinceLocalMidnight(timeZone, wholeMinute) % stepMinutes;
  const delta = remainder === 0 ? 0 : stepMinutes - remainder;
  return new Date(wholeMinute.getTime() + delta * 60_000);
}
