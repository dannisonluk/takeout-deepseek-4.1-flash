import type { ReservationPolicy } from '@takeout/domain';

/** How many days of grid a single availability request may walk. */
export const BOOKING_WINDOW_DAYS = 31;

/**
 * Clamp a requested availability window to something a single request can
 * afford to compute.
 *
 * Two caps apply and the smaller wins:
 *
 *   - The shop's own `advanceDays` — there is no point generating slots nobody
 *     may book.
 *   - `BOOKING_WINDOW_DAYS` — a hard ceiling, because `advanceDays` is a
 *     merchant-settable integer and a typo of `3650` would otherwise make one
 *     unauthenticated request allocate ten years of half-hour objects.
 *
 * `alignUp` on the start so the returned window includes the day the caller
 * asked for rather than the previous slot boundary.
 */
export function buildAvailabilityWindow(params: {
  from: Date;
  to?: Date;
  policy: ReservationPolicy;
}): { windowStart: Date; windowEnd: Date } {
  const windowStart = params.from;

  const capDays = Math.min(
    Math.max(params.policy.advanceDays, 1),
    BOOKING_WINDOW_DAYS,
  );
  const hardEnd = new Date(windowStart.getTime() + capDays * 86_400_000);

  // A caller-supplied end is honoured but never allowed past the cap — the
  // request is unauthenticated on the public booking page.
  const requestedEnd = params.to ?? hardEnd;
  const windowEnd = requestedEnd < hardEnd ? requestedEnd : hardEnd;

  return { windowStart, windowEnd };
}

/**
 * The one sentence the booking page shows above the slot grid.
 *
 * Kept as a function so the numbers and the prose cannot drift: the lead time
 * and the party-size bounds are interpolated from the same policy the booking
 * is validated against. A message typed into the front end would be a second
 * source of truth for a rule the server enforces.
 *
 * The merchant's own `customerNotice` wins when present — it is the one place
 * they get to speak in their own words ("訂位保留 15 分鐘").
 */
export function describeAvailability(
  policy: ReservationPolicy,
  customerNotice: string | null,
  bookableCount: number,
): string {
  if (!policy.enabled) {
    return '此店家暫未開放網上訂位。';
  }

  if (bookableCount === 0) {
    return '所選日期暫時沒有可訂時段，請嘗試其他日子。';
  }

  if (customerNotice) return customerNotice;

  return (
    `可預訂 ${policy.minPartySize}–${policy.maxPartySize} 人，` +
    `需於 ${policy.leadTimeMinutes} 分鐘前預訂，` +
    `最多可預訂 ${policy.advanceDays} 天內。`
  );
}
