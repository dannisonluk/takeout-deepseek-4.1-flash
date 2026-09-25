/**
 * 預約訂位 — the vocabulary.
 *
 * Kept in its own module rather than reusing the order's enums: a reservation
 * and an order are different aggregates that happen to share a merchant. Making
 * one import the other's vocabulary is how a "just one shared enum" becomes a
 * dependency between two bounded contexts.
 */

export enum ReservationStatus {
  /** Submitted, waiting for the shop to accept. */
  PENDING = 'PENDING',
  /** The shop accepted (or `autoConfirm` accepted on their behalf). */
  CONFIRMED = 'CONFIRMED',
  /** The party arrived and is at the table. */
  SEATED = 'SEATED',
  /** They ate and left. */
  COMPLETED = 'COMPLETED',
  /** The shop refused. */
  DECLINED = 'DECLINED',
  /** Either side called it off before the party sat down. */
  CANCELLED = 'CANCELLED',
  /** Confirmed, but nobody turned up. */
  NO_SHOW = 'NO_SHOW',
}

export enum ReservationActor {
  CUSTOMER = 'CUSTOMER',
  MERCHANT = 'MERCHANT',
  /** The clock — the no-show sweep. */
  SYSTEM = 'SYSTEM',
  ADMIN = 'ADMIN',
}

/** Nobody is going to seat this party. */
const TERMINAL: readonly ReservationStatus[] = [
  ReservationStatus.COMPLETED,
  ReservationStatus.DECLINED,
  ReservationStatus.CANCELLED,
  ReservationStatus.NO_SHOW,
];

/**
 * A reservation that is still holding a table.
 *
 * This is the set that the slot counters must agree with — every member occupies
 * capacity, every terminal status has released it.
 */
const ACTIVE: readonly ReservationStatus[] = [
  ReservationStatus.PENDING,
  ReservationStatus.CONFIRMED,
  ReservationStatus.SEATED,
];

export function isTerminalReservationStatus(status: ReservationStatus): boolean {
  return TERMINAL.includes(status);
}

export function isActiveReservationStatus(status: ReservationStatus): boolean {
  return ACTIVE.includes(status);
}

/**
 * The tunable shape of a merchant's reservation book.
 *
 * Everything a booking decision needs, in one value, so the pure policy
 * functions never reach for a second source. It is read from
 * `ReservationSettings`, which falls back to the defaults below the same way
 * pricing does — a merchant who has never opened the settings screen still gets
 * a working book rather than a `null` the caller has to invent a policy for.
 */
export interface ReservationPolicy {
  /** The book is off until the merchant turns it on. */
  readonly enabled: boolean;
  /** Accept bookings without asking. */
  readonly autoConfirm: boolean;
  /** Start times fall on this grid, in minutes from the hour. */
  readonly slotMinutes: number;
  /** How long a table is held for one party. */
  readonly turnMinutes: number;
  /**
   * SEATS available at each start time — not tables.
   *
   * Counting tables would let a shop with four tables take four bookings of
   * eight, which is a promise it cannot keep. Counting seats makes the party
   * size part of the arithmetic, which is what makes "a table for six" a real
   * question rather than a rounding detail.
   */
  readonly seatsPerSlot: number;
  readonly minPartySize: number;
  readonly maxPartySize: number;
  /** Cannot book sooner than this from now. */
  readonly leadTimeMinutes: number;
  /** Cannot book further ahead than this. */
  readonly advanceDays: number;
}

export const DEFAULT_RESERVATION_POLICY: ReservationPolicy = {
  // Off by default. A merchant who never configured reservations must not start
  // receiving them because the platform shipped a feature.
  enabled: false,
  autoConfirm: true,
  slotMinutes: 30,
  turnMinutes: 90,
  seatsPerSlot: 16,
  minPartySize: 1,
  maxPartySize: 8,
  leadTimeMinutes: 60,
  advanceDays: 14,
};
