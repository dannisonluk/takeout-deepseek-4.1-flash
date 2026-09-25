import {
  PartySizeNotAllowedError,
  ReservationSlotMisalignedError,
  ReservationTooFarAheadError,
  ReservationTooSoonError,
} from './reservation.errors';
import { ReservationPolicy } from './reservation-status';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * Where the merchant's slot grid sits.
 *
 * A reservation start time is a *local* time on a grid — 19:00, 19:30 — so
 * deciding whether a timestamp is on the grid needs the merchant's offset, not
 * the viewer's.
 *
 * `utcOffsetMinutes` is the offset **at the instant being checked**, supplied by
 * the caller. A fixed offset would be wrong twice a year in a DST zone; the
 * caller can ask `Intl` for the offset at that specific instant, which is
 * exactly right, and this package stays free of timezone data.
 */
export interface SlotGrid {
  readonly slotMinutes: number;
  readonly utcOffsetMinutes: number;
}

export function isAlignedToGrid(at: Date, grid: SlotGrid): boolean {
  const localMinutes = Math.floor(at.getTime() / MINUTE_MS) + grid.utcOffsetMinutes;
  // `%` on a negative number is negative in JS, so normalise before comparing.
  const remainder = ((localMinutes % grid.slotMinutes) + grid.slotMinutes) % grid.slotMinutes;
  return remainder === 0 && at.getTime() % MINUTE_MS === 0;
}

/** Floor onto the previous grid boundary. */
export function alignToGrid(at: Date, grid: SlotGrid): Date {
  const localMinutes = Math.floor(at.getTime() / MINUTE_MS) + grid.utcOffsetMinutes;
  const floored = Math.floor(localMinutes / grid.slotMinutes) * grid.slotMinutes;
  return new Date((floored - grid.utcOffsetMinutes) * MINUTE_MS);
}

/**
 * The two fields a booking's slot footprint depends on.
 *
 * Narrower than `ReservationPolicy` on purpose: the release path has
 * `turnMinutes` on the reservation row (copied at booking) but has to read
 * `slotMinutes` from live settings, and it must not be forced to fabricate the
 * other seven fields to satisfy a structural type check.
 */
export type SlotFootprint = Pick<ReservationPolicy, 'slotMinutes' | 'turnMinutes'>;

/**
 * Every start-slot a booking of this length sits in.
 *
 * A 90-minute turn on a 30-minute grid takes the 19:00, 19:30 AND 20:00 slots —
 * a party arriving at 19:00 is still at the table when the 20:00 sitting wants
 * it. Charging only the 19:00 slot is the mistake that lets a shop sell the same
 * table twice, and it is invisible until a Saturday night.
 */
export function occupiedSlotStarts(startsAt: Date, policy: SlotFootprint): Date[] {
  const count = Math.max(1, Math.ceil(policy.turnMinutes / policy.slotMinutes));
  return Array.from(
    { length: count },
    (_, index) => new Date(startsAt.getTime() + index * policy.slotMinutes * MINUTE_MS),
  );
}

/** How many seats a booking of `partySize` takes out of each slot it occupies. */
export function seatsTaken(partySize: number): number {
  return partySize;
}

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

export interface ReservationRequest {
  readonly partySize: number;
  readonly startsAt: Date;
}

export interface ValidationContext {
  readonly policy: ReservationPolicy;
  readonly grid: SlotGrid;
  readonly now: Date;
}

/**
 * Everything about a request that can be judged without looking at the book.
 *
 * Pure and total: it either returns or throws, so a caller cannot forget to
 * check the result. Availability — the part that needs the database — is
 * deliberately NOT here.
 */
export function assertReservationRequestBookable(
  request: ReservationRequest,
  context: ValidationContext,
): void {
  const { policy, grid, now } = context;

  if (request.partySize < policy.minPartySize || request.partySize > policy.maxPartySize) {
    throw new PartySizeNotAllowedError(
      request.partySize,
      policy.minPartySize,
      policy.maxPartySize,
    );
  }

  if (!isAlignedToGrid(request.startsAt, grid)) {
    throw new ReservationSlotMisalignedError(grid.slotMinutes, request.startsAt);
  }

  const earliestAt = new Date(now.getTime() + policy.leadTimeMinutes * MINUTE_MS);
  if (request.startsAt.getTime() < earliestAt.getTime()) {
    throw new ReservationTooSoonError(policy.leadTimeMinutes, earliestAt);
  }

  const latestAt = new Date(now.getTime() + policy.advanceDays * DAY_MS);
  if (request.startsAt.getTime() > latestAt.getTime()) {
    throw new ReservationTooFarAheadError(policy.advanceDays, latestAt);
  }
}

// ---------------------------------------------------------------------------
//  Availability
// ---------------------------------------------------------------------------

export interface SlotOccupancy {
  readonly startsAt: Date;
  /** Seats already committed at this start time. */
  readonly booked: number;
}

export interface AvailabilitySlot {
  readonly startsAt: Date;
  readonly remaining: number;
  /** True when a party of the requested size fits. */
  readonly bookable: boolean;
}

export interface AvailabilityQuery {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly policy: ReservationPolicy;
  readonly grid: SlotGrid;
  readonly now: Date;
  /** Seats booked per start time. Times with no row are empty. */
  readonly occupancy: readonly SlotOccupancy[];
  /** Drives `bookable`. Defaults to the policy minimum. */
  readonly partySize?: number;
  /**
   * 特別休息日, as `YYYY-MM-DD` local dates.
   *
   * A slot on a closed day is dropped exactly as an in-the-past slot is: the
   * customer cannot act on it, and offering it invites a tap that will be
   * refused. Kept as dates rather than instants because that is what a closure
   * *is* — the shop is shut for a trading day, not for a range of seconds, and
   * converting dates to instants here would need the merchant's timezone in a
   * package that is deliberately free of timezone data. The caller resolves
   * each slot's date; see `ReservationQueryService.availability`.
   */
  readonly slotDates?: readonly string[];
  /**
   * Called with the local date of each candidate slot, so the caller decides
   * "is this day closed" without this package knowing what a timezone is.
   *
   * Absent means "every day is open", which is what every existing caller and
   * test already got.
   */
  readonly isDateOpen?: (localDate: string) => boolean;
  /**
   * Resolves a slot instant to the merchant's local `YYYY-MM-DD`.
   *
   * Required only when `isDateOpen` is supplied; kept as an injected function
   * for the same reason `SlotGrid.utcOffsetMinutes` is injected — this package
   * stays free of `Intl` and timezone data.
   */
  readonly localDateOf?: (at: Date) => string;
}

/**
 * The bookable grid between two instants.
 *
 * Two deliberate omissions:
 *
 *   - A slot near closing is NOT dropped for lacking room to finish a turn.
 *     Shops routinely take a late booking and turn the table faster; hiding the
 *     slot makes the book look smaller than the shop believes it is.
 *   - Slots inside the lead time are dropped rather than returned as
 *     un-bookable, because the customer cannot act on them at all — showing
 *     them invites a tap that will only be refused.
 *   - Slots on a 特別休息日 are dropped for the same reason, and are checked
 *     before the occupancy arithmetic so a closed day never reports a
 *     `remaining` that a customer could screenshot and argue with.
 */
export function planAvailability(query: AvailabilityQuery): AvailabilitySlot[] {
  const { windowStart, windowEnd, policy, grid, now, occupancy } = query;
  const partySize = query.partySize ?? policy.minPartySize;

  const bookedByStart = new Map<number, number>();
  for (const row of occupancy) {
    bookedByStart.set(row.startsAt.getTime(), row.booked);
  }

  const earliest = new Date(
    Math.max(windowStart.getTime(), now.getTime() + policy.leadTimeMinutes * MINUTE_MS),
  );
  const latest = new Date(
    Math.min(windowEnd.getTime(), now.getTime() + policy.advanceDays * DAY_MS),
  );

  const slots: AvailabilitySlot[] = [];
  const step = policy.slotMinutes * MINUTE_MS;

  for (let at = alignToGrid(earliest, grid).getTime(); at <= latest.getTime(); at += step) {
    // `alignToGrid` floors, so the first candidate can land before the window
    // opened. Skipping is right: it is not a slot the customer may book.
    if (at < earliest.getTime()) continue;

    const startsAt = new Date(at);

    // A closed day drops the slot entirely rather than marking it un-bookable,
    // matching the lead-time treatment above: `bookable: false` with a healthy
    // `remaining` reads as "sold out", which is a different and wrong answer.
    if (query.isDateOpen && query.localDateOf && !query.isDateOpen(query.localDateOf(startsAt))) {
      continue;
    }

    const booked = bookedByStart.get(at) ?? 0;
    const remaining = Math.max(0, policy.seatsPerSlot - booked);
    slots.push({
      startsAt,
      remaining,
      bookable: remaining >= partySize,
    });
  }

  return slots;
}

/** The nearest open slots to `wanted`, for the "did you mean 19:30?" reply. */
export function nearestAvailable(
  slots: readonly AvailabilitySlot[],
  wanted: Date,
  limit = 3,
): Date[] {
  return slots
    .filter((slot) => slot.bookable)
    .sort(
      (a, b) =>
        Math.abs(a.startsAt.getTime() - wanted.getTime()) -
        Math.abs(b.startsAt.getTime() - wanted.getTime()),
    )
    .slice(0, limit)
    .map((slot) => slot.startsAt)
    .sort((a, b) => a.getTime() - b.getTime());
}
