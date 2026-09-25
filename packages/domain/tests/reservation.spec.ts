import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESERVATION_POLICY,
  FixedClock,
  PartySizeNotAllowedError,
  ReservationActor,
  ReservationAlreadyTerminalError,
  ReservationNotPermittedError,
  ReservationOutsideTurnWindowError,
  ReservationSideEffect,
  ReservationSlotMisalignedError,
  ReservationStateMachine,
  ReservationStatus,
  ReservationTooFarAheadError,
  ReservationTooSoonError,
  ReservationsPausedError,
  alignToGrid,
  assertReservationRequestBookable,
  isAlignedToGrid,
  isActiveReservationStatus,
  isTerminalReservationStatus,
  nearestAvailable,
  occupiedSlotStarts,
  planAvailability,
} from '../src/index';

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

const context = (overrides: Record<string, unknown> = {}) => ({
  policy: policy(),
  grid: HK,
  now: new Date(AT),
  ...overrides,
});

const makeMachine = () => new ReservationStateMachine(new FixedClock(AT));

const base = { reservationId: 'res_1', merchantId: 'mer_1', actorId: 'usr_1' } as const;

// ---------------------------------------------------------------------------

describe('slot grid', () => {
  it('accepts a start time on the half hour in the merchant timezone', () => {
    expect(isAlignedToGrid(hkLocal(19, 0), HK)).toBe(true);
    expect(isAlignedToGrid(hkLocal(19, 30), HK)).toBe(true);
  });

  it('rejects a start time that is not on the grid', () => {
    expect(isAlignedToGrid(hkLocal(19, 7), HK)).toBe(false);
  });

  it('floors onto the previous boundary', () => {
    expect(alignToGrid(hkLocal(19, 47), HK).toISOString()).toBe(
      hkLocal(19, 30).toISOString(),
    );
  });

  it('aligns on the merchant clock, not UTC', () => {
    // 19:00 Hong Kong is 11:00 UTC. A grid aligned to UTC would accept it too,
    // so the discriminating case is a half-hour offset: 19:30 HK = 11:30 UTC is
    // on the grid, while 19:00 UTC (= 03:00 HK) is only on the grid for a
    // UTC-aligned merchant.
    const kathmandu = { slotMinutes: 30, utcOffsetMinutes: 345 }; // UTC+5:45
    expect(isAlignedToGrid(new Date('2026-09-25T13:15:00.000Z'), kathmandu)).toBe(true);
    expect(isAlignedToGrid(new Date('2026-09-25T13:00:00.000Z'), kathmandu)).toBe(false);
  });
});

describe('occupied slots', () => {
  it('charges every start-slot the turn covers, not just the first', () => {
    // A 90-minute turn on a 30-minute grid runs 19:00–20:30, so it takes the
    // 19:00, 19:30 and 20:00 sittings. Charging only 19:00 is what sells the
    // same table twice.
    const slots = occupiedSlotStarts(hkLocal(19), policy());
    expect(slots.map((slot) => slot.toISOString())).toEqual([
      hkLocal(19).toISOString(),
      hkLocal(19, 30).toISOString(),
      hkLocal(20).toISOString(),
    ]);
  });

  it('never returns an empty list, even for a turn shorter than a slot', () => {
    expect(occupiedSlotStarts(hkLocal(19), policy({ turnMinutes: 10 }))).toHaveLength(1);
  });
});

describe('request validation', () => {
  const bookable = (partySize: number, at: Date, overrides: Record<string, unknown> = {}) =>
    () =>
      assertReservationRequestBookable(
        { partySize, startsAt: at },
        context(overrides) as Parameters<typeof assertReservationRequestBookable>[1],
      );

  it('accepts a well-formed request', () => {
    expect(bookable(4, hkLocal(20))).not.toThrow();
  });

  it('refuses a party larger than the shop takes', () => {
    expect(bookable(12, hkLocal(20))).toThrow(PartySizeNotAllowedError);
  });

  it('refuses a party below the minimum', () => {
    expect(bookable(0, hkLocal(20))).toThrow(PartySizeNotAllowedError);
  });

  it('refuses a booking inside the lead time', () => {
    // Now is 18:00; the lead time is 60 minutes, so 18:30 is too soon.
    expect(bookable(2, hkLocal(18, 30))).toThrow(ReservationTooSoonError);
  });

  it('accepts the first slot exactly at the lead time boundary', () => {
    expect(bookable(2, hkLocal(19))).not.toThrow();
  });

  it('refuses a booking beyond the advance window', () => {
    const far = new Date(Date.UTC(2026, 9, 20, 12, 0)); // 20 Oct, ~25 days out
    expect(bookable(2, far)).toThrow(ReservationTooFarAheadError);
  });

  it('refuses a start time off the grid', () => {
    expect(bookable(2, hkLocal(19, 7))).toThrow(ReservationSlotMisalignedError);
  });
});

describe('availability planning', () => {
  const window = { windowStart: hkLocal(18), windowEnd: hkLocal(22) };

  it('drops everything inside the lead time', () => {
    const slots = planAvailability({
      ...window,
      policy: policy(),
      grid: HK,
      now: new Date(AT),
      occupancy: [],
    });
    // Now 18:00 + 60 min lead = 19:00, and the window closes at 22:00.
    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      hkLocal(19).toISOString(),
      hkLocal(19, 30).toISOString(),
      hkLocal(20).toISOString(),
      hkLocal(20, 30).toISOString(),
      hkLocal(21).toISOString(),
      hkLocal(21, 30).toISOString(),
      hkLocal(22).toISOString(),
    ]);
  });

  it('subtracts seats already committed at a slot', () => {
    const slots = planAvailability({
      ...window,
      policy: policy({ seatsPerSlot: 16 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [{ startsAt: hkLocal(19, 30), booked: 10 }],
    });
    const at = (hour: number, minute = 0) =>
      slots.find((slot) => slot.startsAt.getTime() === hkLocal(hour, minute).getTime());
    expect(at(19)?.remaining).toBe(16);
    expect(at(19, 30)?.remaining).toBe(6);
  });

  it('marks a slot unbookable when the party does not fit', () => {
    const args = {
      ...window,
      policy: policy({ seatsPerSlot: 16 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [{ startsAt: hkLocal(19, 30), booked: 10 }],
    };
    const six = planAvailability({ ...args, partySize: 6 }).find(
      (slot) => slot.startsAt.getTime() === hkLocal(19, 30).getTime(),
    );
    const eight = planAvailability({ ...args, partySize: 8 }).find(
      (slot) => slot.startsAt.getTime() === hkLocal(19, 30).getTime(),
    );
    expect(six?.bookable).toBe(true);
    expect(eight?.bookable).toBe(false);
  });

  it('never reports a negative remainder when a slot is oversubscribed', () => {
    const slots = planAvailability({
      ...window,
      policy: policy({ seatsPerSlot: 4 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [{ startsAt: hkLocal(19), booked: 9 }],
    });
    expect(slots[0]?.remaining).toBe(0);
    expect(slots[0]?.bookable).toBe(false);
  });

  it('offers the nearest open slots when the wanted one is full', () => {
    const slots = planAvailability({
      ...window,
      policy: policy({ seatsPerSlot: 4 }),
      grid: HK,
      now: new Date(AT),
      occupancy: [{ startsAt: hkLocal(20), booked: 4 }],
    });
    // 20:00 is full. 19:30 and 20:30 are both 30 minutes away; 19:00 is an hour
    // away and takes the third place. The result is returned in chronological
    // order, because that is how a customer reads a list of times.
    expect(nearestAvailable(slots, hkLocal(20)).map((slot) => slot.toISOString())).toEqual([
      hkLocal(19).toISOString(),
      hkLocal(19, 30).toISOString(),
      hkLocal(20, 30).toISOString(),
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('ReservationStateMachine — happy path', () => {
  it('walks a walk-in lifecycle', () => {
    const machine = makeMachine();
    const steps: Array<[ReservationStatus, ReservationStatus, ReservationActor]> = [
      [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationActor.MERCHANT],
      [ReservationStatus.CONFIRMED, ReservationStatus.SEATED, ReservationActor.MERCHANT],
      [ReservationStatus.SEATED, ReservationStatus.COMPLETED, ReservationActor.MERCHANT],
    ];
    for (const [from, to, actor] of steps) {
      expect(machine.transition({ ...base, from, to, actor }).to).toBe(to);
    }
  });

  it('releases the seats on every path out of the active set', () => {
    const machine = makeMachine();
    const releases = (from: ReservationStatus, to: ReservationStatus) =>
      machine.transition({ ...base, from, to, actor: ReservationActor.MERCHANT }).sideEffects
        .includes(ReservationSideEffect.RELEASE_TABLE_SLOT);

    expect(releases(ReservationStatus.PENDING, ReservationStatus.DECLINED)).toBe(true);
    expect(releases(ReservationStatus.PENDING, ReservationStatus.CANCELLED)).toBe(true);
    expect(releases(ReservationStatus.CONFIRMED, ReservationStatus.CANCELLED)).toBe(true);
    expect(releases(ReservationStatus.SEATED, ReservationStatus.COMPLETED)).toBe(true);
  });

  it('does NOT release the seats when it merely confirms', () => {
    const machine = makeMachine();
    const result = machine.transition({
      ...base,
      from: ReservationStatus.PENDING,
      to: ReservationStatus.CONFIRMED,
      actor: ReservationActor.MERCHANT,
    });
    // Releasing here would hand the table to somebody else while this party is
    // still holding it — the leak runs the other way from a stuck counter.
    expect(result.sideEffects).not.toContain(ReservationSideEffect.RELEASE_TABLE_SLOT);
  });
});

describe('ReservationStateMachine — authorisation', () => {
  it('does not let a customer confirm their own booking', () => {
    const machine = makeMachine();
    const attempt = machine.tryTransition({
      ...base,
      from: ReservationStatus.PENDING,
      to: ReservationStatus.CONFIRMED,
      actor: ReservationActor.CUSTOMER,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ReservationNotPermittedError);
  });

  it('does not let a customer seat themselves', () => {
    const machine = makeMachine();
    expect(
      machine.can(
        ReservationStatus.CONFIRMED,
        ReservationStatus.SEATED,
        ReservationActor.CUSTOMER,
      ),
    ).toBe(false);
  });

  it('lets a customer cancel before they are seated', () => {
    const machine = makeMachine();
    for (const from of [ReservationStatus.PENDING, ReservationStatus.CONFIRMED]) {
      const result = machine.transition({
        ...base,
        from,
        to: ReservationStatus.CANCELLED,
        actor: ReservationActor.CUSTOMER,
      });
      expect(result.to).toBe(ReservationStatus.CANCELLED);
    }
  });

  it('does not let a customer cancel once they are at the table', () => {
    const machine = makeMachine();
    expect(
      machine.can(
        ReservationStatus.SEATED,
        ReservationStatus.CANCELLED,
        ReservationActor.CUSTOMER,
      ),
    ).toBe(false);
  });

  it('treats the four closing statuses as terminal', () => {
    const machine = makeMachine();
    for (const status of [
      ReservationStatus.COMPLETED,
      ReservationStatus.DECLINED,
      ReservationStatus.CANCELLED,
      ReservationStatus.NO_SHOW,
    ]) {
      expect(machine.isTerminal(status)).toBe(true);
      expect(machine.transitionsFrom(status)).toHaveLength(0);
    }
    expect(isTerminalReservationStatus(ReservationStatus.SEATED)).toBe(false);
    expect(isActiveReservationStatus(ReservationStatus.SEATED)).toBe(true);
  });

  it('refuses any transition out of a terminal status', () => {
    const machine = makeMachine();
    const attempt = machine.tryTransition({
      ...base,
      from: ReservationStatus.CANCELLED,
      to: ReservationStatus.CONFIRMED,
      actor: ReservationActor.ADMIN,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ReservationAlreadyTerminalError);
  });
});

describe('ReservationStateMachine — guards', () => {
  it('refuses to confirm while the book is paused', () => {
    const machine = makeMachine();
    const attempt = machine.tryTransition({
      ...base,
      from: ReservationStatus.PENDING,
      to: ReservationStatus.CONFIRMED,
      actor: ReservationActor.MERCHANT,
      merchantAcceptingReservations: false,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ReservationsPausedError);
  });

  it('still lets an operator confirm a paused shop', () => {
    const machine = makeMachine();
    const result = machine.transition({
      ...base,
      from: ReservationStatus.PENDING,
      to: ReservationStatus.CONFIRMED,
      actor: ReservationActor.ADMIN,
      merchantAcceptingReservations: false,
    });
    expect(result.to).toBe(ReservationStatus.CONFIRMED);
  });

  it('refuses a no-show declared before the party is late', () => {
    const machine = makeMachine();
    const attempt = machine.tryTransition({
      ...base,
      from: ReservationStatus.CONFIRMED,
      to: ReservationStatus.NO_SHOW,
      actor: ReservationActor.MERCHANT,
      withinTurnWindow: false,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.error).toBeInstanceOf(ReservationOutsideTurnWindowError);
    }
  });

  it('allows a no-show once the booked time has passed', () => {
    const machine = makeMachine();
    const result = machine.transition({
      ...base,
      from: ReservationStatus.CONFIRMED,
      to: ReservationStatus.NO_SHOW,
      actor: ReservationActor.MERCHANT,
      withinTurnWindow: true,
    });
    expect(result.sideEffects).toContain(ReservationSideEffect.RECORD_NO_SHOW);
    expect(result.sideEffects).toContain(ReservationSideEffect.RELEASE_TABLE_SLOT);
  });

  it('seats a party even when the book is paused — they are standing there', () => {
    const machine = makeMachine();
    const result = machine.transition({
      ...base,
      from: ReservationStatus.CONFIRMED,
      to: ReservationStatus.SEATED,
      actor: ReservationActor.MERCHANT,
      merchantAcceptingReservations: false,
    });
    expect(result.to).toBe(ReservationStatus.SEATED);
  });
});

describe('ReservationStateMachine — board buttons', () => {
  it('offers the shop confirm and decline on a pending booking', () => {
    const machine = makeMachine();
    const moves = machine.allowedTransitions(
      ReservationStatus.PENDING,
      ReservationActor.MERCHANT,
    );
    expect(moves).toContain(ReservationStatus.CONFIRMED);
    expect(moves).toContain(ReservationStatus.DECLINED);
    expect(moves).toContain(ReservationStatus.CANCELLED);
  });

  it('offers the customer only cancel', () => {
    const machine = makeMachine();
    expect(
      machine.allowedTransitions(ReservationStatus.PENDING, ReservationActor.CUSTOMER),
    ).toEqual([ReservationStatus.CANCELLED]);
  });

  it('records who moved the booking, for the audit trail', () => {
    const machine = makeMachine();
    const result = machine.transition({
      ...base,
      from: ReservationStatus.PENDING,
      to: ReservationStatus.DECLINED,
      actor: ReservationActor.MERCHANT,
      actorId: 'usr_manager',
      reason: '全場包場',
    });
    expect(result.actorId).toBe('usr_manager');
    expect(result.reason).toBe('全場包場');
    expect(result.occurredAt.toISOString()).toBe(AT);
  });
});
