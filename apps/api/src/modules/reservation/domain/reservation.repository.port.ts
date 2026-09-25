import { Prisma } from '@prisma/client';
import { ReservationActor, ReservationPolicy, ReservationStatus } from '@takeout/domain';

/**
 * The merchant, as the reservation flow needs to see it.
 *
 * `timezone` is load-bearing: every slot decision is made in the shop's local
 * time, so a client that forgot to send one would have the grid computed in
 * UTC and a 19:00 booking would be offered as 11:00.
 */
export interface BookableMerchant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly timezone: string;
  /** MerchantStatus — only `ACTIVE` merchants can be booked. */
  readonly status: string;
}

/** A merchant's reservation book, resolved through settings -> defaults. */
export interface ResolvedSettings {
  readonly policy: ReservationPolicy;
  /** Shown verbatim on the booking page. `null` when the shop wrote none. */
  readonly customerNotice: string | null;
  /**
   * The shop's intake switch, distinct from `policy.enabled`.
   *
   * `policy.enabled` says "this shop does reservations at all"; this says "we
   * have a book but we are not taking new bookings right now" — a full Saturday
   * that the shop has closed to new parties. Today it is derived from
   * `enabled`, but the two are kept separate in this shape so the pause path
   * already exists in the read model the day the shop needs it.
   */
  readonly acceptingNew: boolean;
}

/** Seats committed at one start time. */
export interface SlotOccupancyRow {
  readonly startsAt: Date;
  readonly booked: number;
}

/** A row of the reservation book, as the read models project it. */
export interface PersistedReservation {
  readonly id: string;
  readonly reservationNo: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly status: ReservationStatus;
  readonly partySize: number;
  readonly startsAt: Date;
  /** The turn length copied at booking time — what the seats were held for. */
  readonly turnMinutes: number;
  readonly serviceDate: Date;
  readonly customerName: string;
  readonly contactPhone: string;
  readonly customerNote: string | null;
  readonly merchantNote: string | null;
  readonly statusReason: string | null;
  readonly version: number;
  readonly confirmedAt: Date | null;
  readonly seatedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateReservationData {
  readonly reservationNo: string;
  readonly customerId: string;
  readonly merchantId: string;
  readonly partySize: number;
  readonly startsAt: Date;
  readonly turnMinutes: number;
  readonly serviceDate: Date;
  readonly customerName: string;
  readonly contactPhone: string;
  readonly customerNote: string | null;
  /**
   * The initial status.
   *
   * Either `PENDING` (the shop will confirm) or `CONFIRMED` (`autoConfirm`) —
   * decided by the use case, because "does this need a human" is policy and the
   * policy lives in the domain layer. The repository only persists the answer.
   */
  readonly status: ReservationStatus;
  /**
   * The caller's `Idempotency-Key`, when supplied.
   *
   * Not stored on the reservation row — there is no unique index for it, unlike
   * `orders.idempotency_key`. Booking double-taps are absorbed by the slot
   * counter instead: the second request finds the seats already taken and is
   * refused with `RESERVATION_SLOT_UNAVAILABLE`, which is a truthful answer.
   */
  readonly idempotencyKey?: string;
}

/** Fields a transition writes alongside the new status. */
export interface ReservationStatusPatch {
  readonly confirmedAt?: Date;
  readonly seatedAt?: Date;
  readonly completedAt?: Date;
  readonly cancelledAt?: Date;
  readonly statusReason?: string | null;
  readonly merchantNote?: string | null;
  readonly lastActor?: ReservationActor;
  readonly lastActorId?: string | null;
}

/**
 * Persistence port for the reservation aggregate.
 *
 * Same contract as `OrderRepositoryPort`: the application layer depends on this
 * interface and every mutating method takes the caller's
 * `Prisma.TransactionClient`, so a use case owns the transactional boundary and
 * the repository cannot open one of its own.
 *
 * NARROWER THAN THE ORDER PORT, ON PURPOSE — there is no
 * `reservation_status_events` table and no `RESERVATION_NOT_TERMINAL` audit
 * trail. The order aggregate needed one because a payout dispute turns on the
 * sequence of who moved it and when; a booking has no money leg, so the
 * lifecycle record is the `reservations` row itself plus the `outbox_events`
 * that every transition already writes. Its `version` column is bumped on the
 * same `UPDATE` as the status, which is what the event carries. Adding an audit
 * table here would be a second source of truth for a question only one party
 * ever asks.
 */
export interface ReservationRepositoryPort {
  /** `null` unless the merchant exists AND is ACTIVE. */
  findBookableMerchant(merchantId: string): Promise<BookableMerchant | null>;
  findBookableMerchantBySlug(slug: string): Promise<BookableMerchant | null>;

  /**
   * The shop's book settings, with defaults filled in.
   *
   * Never returns `null`: a merchant who has never opened the settings screen
   * still gets a working — but disabled — book, rather than a `null` every
   * caller has to invent a policy for.
   */
  findSettings(merchantId: string): Promise<ResolvedSettings>;

  /**
   * Seats already committed, grouped by start time, over a window.
   *
   * The window is inclusive of `windowStart` and exclusive of `windowEnd`, so
   * an availability query for a single day does not accidentally pull in the
   * first slot of the next.
   */
  findOccupancy(
    merchantId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<readonly SlotOccupancyRow[]>;

  /**
   * Take `seats` out of every start-slot the booking occupies.
   *
   * All-or-nothing: `false` means at least one of the slots did not have room,
   * and in that case NOTHING was held — the caller may safely retry or report
   * the slot as unavailable. Implemented as a conditional upsert per slot so
   * two simultaneous requests cannot both see the last table.
   */
  holdSlots(
    tx: Prisma.TransactionClient,
    merchantId: string,
    slotStarts: readonly Date[],
    seats: number,
    seatsPerSlot: number,
  ): Promise<boolean>;

  /**
   * Give `seats` back to every start-slot the booking occupied. Idempotent
   * enough to survive a retried transition: clamped at zero rather than able to
   * go negative.
   */
  releaseSlots(
    tx: Prisma.TransactionClient,
    merchantId: string,
    slotStarts: readonly Date[],
    seats: number,
  ): Promise<void>;

  /** Monotonic per-merchant-per-day counter behind `reservationNo`. */
  nextReservationSequence(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
  ): Promise<number>;

  insertReservation(
    tx: Prisma.TransactionClient,
    data: CreateReservationData,
  ): Promise<PersistedReservation>;

  findById(reservationId: string): Promise<PersistedReservation | null>;

  /** Locking read for the transition path. */
  findByIdForUpdate(
    tx: Prisma.TransactionClient,
    reservationId: string,
  ): Promise<PersistedReservation | null>;

  /**
   * Optimistic status change: `WHERE id = ? AND status = ?`.
   * Returns `false` when another writer got there first.
   *
   * Also bumps `version` — that counter is the outbox event version, and the
   * schema comment is explicit that the reservation row is the lifecycle
   * record, so the bump has to happen here rather than in a separate audit
   * write that a crash could skip.
   */
  updateStatus(
    tx: Prisma.TransactionClient,
    reservationId: string,
    expectedStatus: ReservationStatus,
    nextStatus: ReservationStatus,
    patch: ReservationStatusPatch,
  ): Promise<boolean>;

  /** Upsert the shop's book settings. Returns the stored policy. */
  saveSettings(
    merchantId: string,
    settings: Partial<PersistedSettingsInput> & { updatedById?: string },
  ): Promise<ResolvedSettings>;
}

/** Every field a merchant can set on their book. All optional — it is a patch. */
export interface PersistedSettingsInput {
  enabled: boolean;
  autoConfirm: boolean;
  slotMinutes: number;
  turnMinutes: number;
  seatsPerSlot: number;
  minPartySize: number;
  maxPartySize: number;
  leadTimeMinutes: number;
  advanceDays: number;
  customerNotice: string | null;
}
