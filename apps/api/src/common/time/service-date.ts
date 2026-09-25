/**
 * Service-date helpers.
 *
 * "Today" for a merchant in `Asia/Hong_Kong` is not "today" in UTC. An order
 * placed at 00:30 HKT belongs to that HKT day, but its UTC timestamp is still
 * the previous day. Every daily-quota, pickup-code and payout calculation goes
 * through here so the boundary is defined exactly once.
 */

/** Local calendar date (`YYYY-MM-DD`) for `at` in `timeZone`. */
export function localDateString(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * `serviceDate` as a UTC-midnight `Date`, which is what a Prisma `@db.Date`
 * column round-trips. Storing local midnight instead would shift the row by the
 * UTC offset and break the `@@unique([menuItemId, serviceDate])` constraint.
 */
export function serviceDateIn(timeZone: string, at: Date): Date {
  return new Date(`${localDateString(timeZone, at)}T00:00:00.000Z`);
}

/** Minutes elapsed since local midnight — used to test operating hours. */
export function minutesSinceLocalMidnight(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type: string): number =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);

  return get('hour') * 60 + get('minute');
}

/** Local day of week, 0 = Sunday … 6 = Saturday. */
export function localDayOfWeek(timeZone: string, at: Date): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

/**
 * The zone's UTC offset, in minutes, **at that specific instant**.
 *
 * The domain's `SlotGrid` needs this rather than a fixed offset because a grid
 * is a *local* clock: 19:00 is on the half-hour every day of the year, but the
 * UTC instant that corresponds to it moves by an hour when the zone changes
 * offset. Passing a single offset for the year would put the grid out by an
 * hour for half of it — which for Hong Kong (no DST since 1979) is invisible in
 * testing and wrong the moment a merchant in another region opts in.
 *
 * Derived by formatting `at` in the zone and in UTC and diffing the two wall
 * clocks. `en-CA` is used for the `YYYY-MM-DD` ordering, and seconds are
 * dropped because no zone on earth has a sub-minute offset today.
 */
export function utcOffsetMinutesAt(timeZone: string, at: Date): number {
  const wallClock = (zone: string): number => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);

    const get = (type: string): number =>
      Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10);

    // `hour` can come back as `24` for midnight in some ICU builds; normalise
    // it to 0 so the difference is not off by a full day.
    const hour = get('hour') % 24;

    return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'));
  };

  return (wallClock(timeZone) - wallClock('UTC')) / 60_000;
}
