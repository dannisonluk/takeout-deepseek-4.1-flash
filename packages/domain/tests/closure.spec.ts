import { describe, expect, it } from 'vitest';
import {
  ClosureReason,
  DEFAULT_RESERVATION_POLICY,
  ReservationStatus,
  closureCancellationReason,
  closuresWithin,
  describeClosure,
  isActiveReservationStatus,
  isClosureCancellationReason,
  isClosedOn,
  planAvailability,
} from '../src/index';

/**
 * 特別休息日.
 *
 * The two halves of this feature are tested together on purpose: a closure is
 * only correct if the *policy* says the day is shut AND the *grid* stops
 * offering slots on it. Testing either alone would pass while the customer
 * still sees a bookable 19:00 on a day the shop is closed.
 */

/** 18:00 in Hong Kong. */
const AT = '2026-09-25T10:00:00.000Z';
const HK = { slotMinutes: 30, utcOffsetMinutes: 480 };

/** `HH:mm` Hong Kong on 2026-09-25, as a UTC instant (HK is UTC+8, no DST). */
const hkLocal = (hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 8, 25, hour - 8, minute));

const policy = (overrides: Partial<typeof DEFAULT_RESERVATION_POLICY> = {}) => ({
  ...DEFAULT_RESERVATION_POLICY,
  ...overrides,
});

// ---------------------------------------------------------------------------

describe('closure set', () => {
  const closures = [
    { serviceDate: '2026-09-24', reason: ClosureReason.PUBLIC_HOLIDAY },
    { serviceDate: '2026-09-25', reason: ClosureReason.STAFF_HOLIDAY, note: '全店員工旅行' },
    { serviceDate: '2026-10-01', reason: ClosureReason.PUBLIC_HOLIDAY },
  ];

  it('recognises a listed date', () => {
    expect(isClosedOn(closuresWithin(closures, '2026-09-01', '2026-09-30'), '2026-09-25')).toBe(
      true,
    );
  });

  it('does not treat an unlisted date as closed', () => {
    expect(isClosedOn(closuresWithin(closures, '2026-09-01', '2026-09-30'), '2026-09-26')).toBe(
      false,
    );
  });

  it('windows the set so a far-future closure is not returned', () => {
    // The point of the window: a 31-day booking horizon must not drag a
    // closure from next year into memory to answer "are we shut tomorrow".
    const within = closuresWithin(closures, '2026-09-01', '2026-09-30');
    expect(within.has('2026-10-01')).toBe(false);
    expect([...within].sort()).toEqual(['2026-09-24', '2026-09-25']);
  });

  it('is inclusive at both ends of the window', () => {
    const within = closuresWithin(closures, '2026-09-24', '2026-09-25');
    expect([...within].sort()).toEqual(['2026-09-24', '2026-09-25']);
  });

  it('returns an empty set when nothing falls inside the window', () => {
    expect(closuresWithin(closures, '2026-12-01', '2026-12-31').size).toBe(0);
  });
});

describe('closure prose', () => {
  it('prefers the shop’s own note over the generated sentence', () => {
    // The shop speaking in its own words is the one place it gets to, and it
    // must win — otherwise a merchant writes 「裝修，10 月重開」 and the app tells
    // the customer 「店家當日暫停營業進行維修。」
    expect(describeClosure(ClosureReason.MAINTENANCE, '裝修，10 月重開')).toBe('裝修，10 月重開');
  });

  it('ignores a whitespace-only note', () => {
    expect(describeClosure(ClosureReason.MAINTENANCE, '   ')).toBe(
      '店家當日暫停營業進行維修。',
    );
  });

  it('generates a distinct sentence per reason', () => {
    const sentences = new Set(
      Object.values(ClosureReason).map((reason) => describeClosure(reason, null)),
    );
    expect(sentences.size).toBe(Object.values(ClosureReason).length);
  });

  it('tags the cancellation with the date, and can be told apart from a manual cancel', () => {
    const reason = closureCancellationReason('2026-09-25');
    expect(reason).toBe('MERCHANT_CLOSED:2026-09-25');
    expect(isClosureCancellationReason(reason)).toBe(true);
    expect(isClosureCancellationReason('店家來電取消')).toBe(false);
    expect(isClosureCancellationReason(null)).toBe(false);
  });
});

describe('availability on a rest day', () => {
  const windowStart = hkLocal(11, 0);
  const windowEnd = hkLocal(23, 0);

  const plan = (closed: readonly string[]) =>
    planAvailability({
      windowStart,
      windowEnd,
      policy: policy({ enabled: true, leadTimeMinutes: 0, advanceDays: 7 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [],
      isDateOpen: (localDate) => !closed.includes(localDate),
      // The merchant is UTC+8 in this fixture; the real caller derives this
      // from `Intl`. A fixed conversion is honest here because the fixture's
      // zone has no DST.
      localDateOf: (at) => new Date(at.getTime() + 480 * 60_000).toISOString().slice(0, 10),
    });

  it('drops every slot when the window’s only day is closed', () => {
    expect(plan(['2026-09-25'])).toHaveLength(0);
  });

  it('offers slots when the same day is open', () => {
    expect(plan([]).length).toBeGreaterThan(0);
  });

  it('drops the slots rather than marking them un-bookable', () => {
    // `bookable: false` with a healthy `remaining` reads as "sold out", which
    // is a different and wrong answer for a rest day. The slot must not be
    // returned at all.
    const closed = plan(['2026-09-25']);
    expect(closed.filter((slot) => !slot.bookable)).toHaveLength(0);
    expect(closed).toHaveLength(0);
  });

  it('only removes the closed day from a two-day window', () => {
    const spanning = planAvailability({
      windowStart: hkLocal(11, 0),
      // 12:00 next day, HK time.
      windowEnd: new Date(hkLocal(12, 0).getTime() + 24 * 3_600_000),
      policy: policy({ enabled: true, leadTimeMinutes: 0, advanceDays: 7 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [],
      isDateOpen: (localDate) => localDate !== '2026-09-26',
      localDateOf: (at) => new Date(at.getTime() + 480 * 60_000).toISOString().slice(0, 10),
    });

    expect(spanning.length).toBeGreaterThan(0);
    for (const slot of spanning) {
      const localDate = new Date(slot.startsAt.getTime() + 480 * 60_000)
        .toISOString()
        .slice(0, 10);
      expect(localDate).not.toBe('2026-09-26');
    }
  });

  it('behaves exactly as before when no closure predicate is supplied', () => {
    // Every existing caller and test passes no predicate. If this changes, the
    // feature has broken the code it was added to.
    const withNoPredicate = planAvailability({
      windowStart,
      windowEnd,
      policy: policy({ enabled: true, leadTimeMinutes: 0, advanceDays: 7 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [],
    });
    const withEmptyClosures = plan(['nothing-is-closed']);
    expect(withNoPredicate).toHaveLength(withEmptyClosures.length);
  });
});

describe('ACTIVE set covers every status a closure sweep must cancel', () => {
  it('is exactly the pre-terminal statuses', () => {
    // The sweep reads this set to decide what to cancel. A status that is
    // active but missing here would leave its seats held forever; one that is
    // terminal but present would notify a customer about a booking that
    // already ended.
    const active = Object.values(ReservationStatus).filter(isActiveReservationStatus);
    expect(new Set(active)).toEqual(
      new Set([
        ReservationStatus.PENDING,
        ReservationStatus.CONFIRMED,
        ReservationStatus.SEATED,
      ]),
    );
  });
});
