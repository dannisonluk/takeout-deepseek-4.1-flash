import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DomainError,
  IdGenerator,
  ReservationActor,
  ReservationSlotUnavailableError,
  ReservationStatus,
  ReservationsDisabledError,
  occupiedSlotStarts,
  seatsTaken,
  assertReservationRequestBookable,
  type SlotGrid,
} from '@takeout/domain';
import { ID_GENERATOR, RESERVATION_REPOSITORY } from '../../../common/tokens';
import { localDateString, serviceDateIn, utcOffsetMinutesAt } from '../../../common/time/service-date';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  BookableMerchant,
  PersistedReservation,
  ReservationRepositoryPort,
  ResolvedSettings,
} from '../domain/reservation.repository.port';

export interface PlaceReservationCommand {
  readonly customerId: string;
  readonly merchantId: string;
  readonly partySize: number;
  readonly startsAt: Date;
  readonly customerName: string;
  readonly contactPhone: string;
  readonly customerNote?: string;
  readonly idempotencyKey?: string;
}

export interface PlaceReservationResult {
  readonly reservation: PersistedReservation;
  readonly settings: ResolvedSettings;
  /** Echoed so the response body can name the shop without a second read. */
  readonly merchant: BookableMerchant;
}

/**
 * Take a booking.
 *
 * Order of operations, and why:
 *
 *   1. Resolve the merchant + settings, then run the PURE validation
 *      (`assertReservationRequestBookable`). Party size, grid alignment, lead
 *      time and the advance window are all decidable without the database, so
 *      they are checked before a transaction is opened — a misaligned time
 *      should not cost a connection.
 *   2. Enter the transaction and hold every start-slot the turn occupies. The
 *      hold is the concurrency gate: `held === false` means another request won
 *      the seat between the check and the write, and the whole transaction
 *      rolls back, releasing any slots held earlier in this same call.
 *   3. Insert the reservation. Status is `CONFIRMED` when `autoConfirm`, else
 *      `PENDING` — "does this need a human" is policy, and policy is the
 *      domain's job, not the repository's.
 *   4. Outbox row, same transaction.
 */
@Injectable()
export class PlaceReservationUseCase {
  private readonly logger = new Logger(PlaceReservationUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
  ) {}

  async execute(command: PlaceReservationCommand): Promise<PlaceReservationResult> {
    const now = new Date();

    const merchant = await this.reservations.findBookableMerchant(command.merchantId);
    if (!merchant) {
      // `ReservationNotFoundError` would be a lie — the merchant is what is
      // missing. Reuse the ordering module's code so the filter's existing 404
      // mapping covers it without a new entry.
      throw new MerchantNotBookableError(command.merchantId);
    }

    const settings = await this.reservations.findSettings(merchant.id);
    const policy = settings.policy;

    if (!policy.enabled) throw new ReservationsDisabledError(merchant.id);

    // The grid is anchored on the *requested instant*, so a DST boundary
    // between now and the booking is accounted for on the day it matters.
    const grid: SlotGrid = {
      slotMinutes: policy.slotMinutes,
      utcOffsetMinutes: utcOffsetMinutesAt(merchant.timezone, command.startsAt),
    };

    assertReservationRequestBookable(
      { partySize: command.partySize, startsAt: command.startsAt },
      { policy, grid, now },
    );

    const slots = occupiedSlotStarts(command.startsAt, policy);
    const seats = seatsTaken(command.partySize);
    // `serviceDate` is the LOCAL date of the booking, not of `now` — a party
    // booked for 00:30 tomorrow belongs to tomorrow's book.
    const serviceDate = serviceDateIn(merchant.timezone, command.startsAt);
    const serviceDateString = localDateString(merchant.timezone, command.startsAt);

    // 特別休息日. Checked HERE, in the write path, and not only in the grid that
    // built the booking page: the grid is a courtesy, this is the rule. Without
    // it a client that posts a start time directly — a retried request, a
    // hand-rolled integration, a stale tab left open across the closure — books
    // a table in a shop that is shut, and the shop finds out on the day.
    //
    // Only the booking's OWN day is read. A closure on another day is not this
    // request's business, and querying a range would make a shop with a long
    // rest-day plan pay for every booking.
    const closure = await this.prisma.merchantClosure.findUnique({
      where: {
        merchantId_serviceDate: { merchantId: merchant.id, serviceDate },
      },
      select: { reason: true, note: true },
    });
    if (closure) {
      throw new MerchantClosedForReservationError(serviceDateString, closure.reason, closure.note);
    }

    const initialStatus = policy.autoConfirm
      ? ReservationStatus.CONFIRMED
      : ReservationStatus.PENDING;

    const created = await this.prisma.runInTransaction(async (tx) => {
      const held = await this.reservations.holdSlots(
        tx,
        merchant.id,
        slots,
        seats,
        policy.seatsPerSlot,
      );
      if (!held) {
        // The transaction is abandoned, so every slot this call already
        // incremented goes back with it. Returning `false` rather than throwing
        // here keeps the rollback reason in the domain error below, where the
        // filter can map it.
        throw new ReservationSlotUnavailableError(command.startsAt, []);
      }

      const sequence = await this.reservations.nextReservationSequence(
        tx,
        merchant.id,
        serviceDate,
      );

      const reservation = await this.reservations.insertReservation(tx, {
        reservationNo: buildReservationNo(
          localDateString(merchant.timezone, command.startsAt),
          sequence,
        ),
        customerId: command.customerId,
        merchantId: merchant.id,
        partySize: command.partySize,
        startsAt: command.startsAt,
        // Copied, not referenced: a shop that later shortens its turn time must
        // still give back exactly the seats this booking took.
        turnMinutes: policy.turnMinutes,
        serviceDate,
        customerName: command.customerName,
        contactPhone: command.contactPhone,
        customerNote: command.customerNote ?? null,
        status: initialStatus,
        ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
      });

      await this.outbox.enqueue(
        tx,
        this.outbox.buildReservationEvent({
          idGenerator: this.idGenerator,
          reservation,
          actor: policy.autoConfirm ? ReservationActor.SYSTEM : ReservationActor.CUSTOMER,
          occurredAt: now,
        }),
      );

      return reservation;
    });

    this.logger.log(
      `Reservation ${created.reservationNo}: ${created.partySize}p @ ${created.startsAt.toISOString()} (${created.status})`,
    );

    return { reservation: created, settings, merchant };
  }
}

/**
 * `R-YYYYMMDD-NNNN`, matching the `reservationNo` VarChar(24) width.
 *
 * The day prefix is the merchant's LOCAL date, so a booking taken at 09:00 HKT
 * on the 26th and one taken at 23:00 HKT on the 25th do not share a prefix just
 * because they share a UTC day.
 */
function buildReservationNo(localDate: string, sequence: number): string {
  const compact = localDate.replace(/-/g, '');
  return `R-${compact}-${String(sequence).padStart(4, '0')}`;
}

/** The merchant does not exist, or is not `ACTIVE`. Mapped to 404. */
export class MerchantNotBookableError extends DomainError {
  constructor(merchantId: string) {
    super('MERCHANT_NOT_FOUND', '店家不存在或暫不開放訂位', { merchantId });
  }
}

/**
 * The shop has marked this day a 特別休息日. Mapped to 422.
 *
 * A DISTINCT code from `RESERVATION_SLOT_UNAVAILABLE`, which is what the caller
 * would otherwise get: a closed day has no slots, so the counter refuses too.
 * The two are different answers and the customer acts on them differently —
 * "that time just went" invites a retry on another slot, "the shop is shut that
 * day" does not.
 */
export class MerchantClosedForReservationError extends DomainError {
  constructor(serviceDate: string, reason: string, note?: string | null) {
    super(
      'MERCHANT_CLOSED',
      note?.trim() || `店家當日（${serviceDate}）休息，暫停接受訂位`,
      { serviceDate, reason, note: note ?? null },
    );
  }
}
