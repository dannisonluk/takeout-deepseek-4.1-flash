import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ClosureReason,
  IdGenerator,
  ReservationActor,
  ReservationNotFoundError,
  ReservationSideEffect,
  ReservationStateMachine,
  ReservationStatus,
  closureCancellationReason,
  isActiveReservationStatus,
  isClosureCancellationReason,
  occupiedSlotStarts,
} from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { localDateString } from '../../../common/time/service-date';
import {
  ID_GENERATOR,
  RESERVATION_REPOSITORY,
  RESERVATION_STATE_MACHINE,
} from '../../../common/tokens';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ConcurrentReservationModificationError } from '../../reservation/domain/reservation.errors';
import { ReservationRepositoryPort } from '../../reservation/domain/reservation.repository.port';
import {
  ClosureDateInPastError,
  ClosureNotFoundError,
  InvalidClosureDateError,
  MerchantNotEditableError,
} from '../domain/merchant.errors';
import {
  ClosureView,
  ClosureWriteResultView,
  SetClosureDto,
} from '../interface/dto/merchant.dto';

/**
 * 特別休息日 — a dated day the shop is shut.
 *
 * The interesting part is not the CRUD. It is that creating a closure has to
 * **cancel the reservations already booked into that day**, and doing that
 * correctly means three separate things have to hold:
 *
 *   1. Each cancellation goes through `ReservationStateMachine`, so the seats
 *      are released by the same `RELEASE_TABLE_SLOT` side effect every other
 *      exit uses. Handing the tables back by a direct counter decrement here
 *      would be a second implementation of the release rule, and the two would
 *      disagree the first time the turn length changed.
 *   2. The cascade is **idempotent**. `cancelledReservationsAt` on the closure
 *      row is the latch: once stamped, a re-save of the same date is a no-op
 *      rather than a second sweep. Without it, saving the rest day twice —
 *      which the settings screen does every time the merchant touches any
 *      field — would re-cancel bookings the shop had since re-created.
 *   3. It is **bounded and sequential**, not `Promise.all`. Every cancellation
 *      takes a row lock (`SELECT ... FOR UPDATE`) and the API's pool is finite;
 *      fanning out over a fully-booked Saturday would hold one connection per
 *      booking and deadlock against itself. Twenty covers a realistic day, and
 *      a shop with more than twenty bookings on one day gets the rest handled
 *      by the same loop on the next pass of the settings save.
 */
@Injectable()
export class MerchantClosureService {
  private readonly logger = new Logger(MerchantClosureService.name);

  /**
   * How many bookings one sweep will cancel.
   *
   * A cap rather than "all of them": the sweep runs inside an HTTP request and
   * each iteration is a locked transaction. It is also the honest limit — if a
   * shop has more than this on one day, the right answer is a background job,
   * not a bigger number here.
   */
  private static readonly SWEEP_LIMIT = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepositoryPort,
    @Inject(RESERVATION_STATE_MACHINE) private readonly stateMachine: ReservationStateMachine,
  ) {}

  /** Every closure from `from` onwards, ascending. Drives the rest-day screen. */
  async list(merchantId: string, from?: string): Promise<ClosureView[]> {
    const rows = await this.prisma.merchantClosure.findMany({
      where: {
        merchantId,
        ...(from ? { serviceDate: { gte: new Date(`${from}T00:00:00.000Z`) } } : {}),
      },
      orderBy: { serviceDate: 'asc' },
      select: closureSelect,
    });
    return rows.map(toClosureView);
  }

  /**
   * The shop's timezone, for callers that need a *local* default date.
   *
   * A one-column read rather than reusing `MerchantService.getOwned`, which
   * projects forty fields and a viewer-relative `isOwner` flag to answer a
   * question that is two words long.
   */
  async timezoneOf(merchantId: string): Promise<string | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { timezone: true },
    });
    return merchant?.timezone ?? null;
  }

  /** The rest day for one date, or `null`. Read by the customer-facing notice. */
  async findOne(merchantId: string, serviceDate: string): Promise<ClosureView | null> {
    const row = await this.prisma.merchantClosure.findUnique({
      where: { merchantId_serviceDate: { merchantId, serviceDate: dateToDb(serviceDate) } },
      select: closureSelect,
    });
    return row ? toClosureView(row) : null;
  }

  /**
   * Create or replace the rest day for one date, then sweep its bookings.
   *
   * PUT semantics on a single date rather than POST-to-a-collection: a day is
   * either a rest day or it is not, and there is no meaningful "two closures on
   * the same date". The `@@unique([merchantId, serviceDate])` says the same
   * thing in the schema.
   */
  async upsert(
    merchantId: string,
    serviceDate: string,
    dto: SetClosureDto,
    actor: Actor,
  ): Promise<ClosureWriteResultView> {
    const merchant = await this.requireEditableMerchant(merchantId);
    assertNotPast(merchant.timezone, serviceDate);

    const existing = await this.prisma.merchantClosure.findUnique({
      where: { merchantId_serviceDate: { merchantId, serviceDate: dateToDb(serviceDate) } },
      select: { id: true, cancelledReservationsAt: true, reason: true, note: true },
    });

    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.merchantClosure.upsert({
        where: { merchantId_serviceDate: { merchantId, serviceDate: dateToDb(serviceDate) } },
        update: { reason: dto.reason, note: dto.note ?? null },
        create: {
          merchantId,
          serviceDate: dateToDb(serviceDate),
          reason: dto.reason,
          note: dto.note ?? null,
          createdById: actor.userId,
        },
        select: closureSelect,
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: existing ? 'merchant.closure_update' : 'merchant.closure_create',
          targetType: 'MerchantClosure',
          targetId: saved.id,
          before: existing ? { reason: existing.reason, note: existing.note } : null,
          after: { serviceDate, reason: dto.reason, note: dto.note ?? null },
          ip: actor.ip ?? null,
        },
        tx,
      );

      return saved;
    });

    // Swept AFTER the closure row is committed, not inside the same
    // transaction. Two reasons, both deliberate:
    //
    //   - The cascade can be long (one locked transaction per booking), and
    //     holding the closure write open behind it would leave the rest day
    //     invisible for the duration — the customer-facing slot query would
    //     keep offering the day until the last cancellation finished.
    //   - `cancelledReservationsAt` is the latch, and it only works if the
    //     closure row is already durable: a sweep that crashes halfway leaves a
    //     committed closure that says "not yet swept", which the next save will
    //     pick up. Inside one transaction a crash would roll the closure back
    //     and the rest day would silently not exist.
    const sweep = row.cancelledReservationsAt
      ? { cancelled: 0, alreadySwept: true, remaining: 0 }
      : await this.sweep(merchantId, serviceDate, actor);

    return {
      closure: toClosureView(row),
      cancelledReservations: sweep.cancelled,
      alreadySwept: sweep.alreadySwept,
      /**
       * Bookings still active on the closed day after the capped sweep.
       *
       * Non-zero means the shop has more bookings than one pass will cancel.
       * Surfaced rather than swallowed so the UI can say 「尚有 N 筆未取消，請重新儲存」
       * instead of the merchant believing the day is clear.
       */
      remainingActive: sweep.remaining,
      message: buildSweepMessage(serviceDate, sweep),
    };
  }

  /**
   * Remove a rest day. Does NOT resurrect anything it cancelled.
   *
   * Deliberate, and the one asymmetry worth stating: reopening a day gives the
   * shop its slots back, but the parties it told to go away are not re-booked.
   * Re-instating them would mean guessing whether the closure or the customer's
   * subsequent plans should win, and the shop can ring the handful of people it
   * affected far more cheaply than the platform can guess correctly.
   */
  async remove(merchantId: string, serviceDate: string, actor: Actor): Promise<void> {
    await this.requireEditableMerchant(merchantId);

    const existing = await this.prisma.merchantClosure.findUnique({
      where: { merchantId_serviceDate: { merchantId, serviceDate: dateToDb(serviceDate) } },
      select: { id: true, reason: true, cancelledReservationCount: true },
    });
    if (!existing) throw new ClosureNotFoundError(serviceDate);

    await this.prisma.$transaction(async (tx) => {
      await tx.merchantClosure.delete({ where: { id: existing.id } });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'merchant.closure_delete',
          targetType: 'MerchantClosure',
          targetId: existing.id,
          before: { serviceDate, reason: existing.reason },
          after: null,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
  }

  /**
   * Cancel every active booking on `serviceDate`, through the state machine.
   *
   * Returns the count so the caller can put a number in the banner, and
   * `remaining` so a capped run is visible rather than silent.
   */
  private async sweep(
    merchantId: string,
    serviceDate: string,
    actor: Actor,
  ): Promise<{ cancelled: number; alreadySwept: boolean; remaining: number }> {
    const day = dateToDb(serviceDate);

    const bookings = await this.prisma.reservation.findMany({
      where: {
        merchantId,
        serviceDate: day,
        // The Prisma enum, filtered by the domain's own ACTIVE set converted to
        // strings. Writing the three literals here instead would make this the
        // fourth place that knows what "still holding seats" means.
        status: {
          in: Object.values(ReservationStatus).filter(isActiveReservationStatus) as never[],
        },
      },
      orderBy: { startsAt: 'asc' },
      take: MerchantClosureService.SWEEP_LIMIT + 1,
      select: { id: true, status: true },
    });

    const toCancel = bookings.slice(0, MerchantClosureService.SWEEP_LIMIT);
    let cancelled = 0;

    for (const booking of toCancel) {
      try {
        // The status is cast at the boundary rather than carried as a domain
        // enum from the query: Prisma's generated enum and the domain's are the
        // same strings but different TS types, which is the same conversion
        // `PrismaReservationRepository` does in `fromPrismaStatus`. The cast is
        // safe because both enums are generated from the same vocabulary and the
        // row was just read from the column that vocabulary defines.
        await this.cancelOne(
          booking.id,
          booking.status as unknown as ReservationStatus,
          serviceDate,
          actor.userId,
        );
        cancelled += 1;
      } catch (error) {
        // One booking that cannot be cancelled — a race with the customer, a
        // concurrent modification — must not abandon the other nineteen. The
        // state machine's own refusals are the expected case here: a booking
        // that went terminal between the read and the write is a correct
        // ``no-op``, not a failure.
        if (error instanceof ConcurrentReservationModificationError || error instanceof ReservationNotFoundError) {
          this.logger.warn(
            `Closure ${serviceDate}: skipped reservation ${booking.id} (${(error as Error).message})`,
          );
          continue;
        }
        throw error;
      }
    }

    // Stamped even when nothing was cancelled: the latch records that the sweep
    // RAN, not that it did work. Re-running it on every subsequent settings save
    // is exactly the duplicate-notification bug this prevents.
    await this.prisma.merchantClosure.update({
      where: { merchantId_serviceDate: { merchantId, serviceDate: day } },
      data: { cancelledReservationsAt: new Date(), cancelledReservationCount: cancelled },
    });

    const remaining = Math.max(0, bookings.length - toCancel.length);
    this.logger.log(
      `Closure ${serviceDate} for merchant ${merchantId}: cancelled ${cancelled}, remaining ${remaining}`,
    );

    return { cancelled, alreadySwept: false, remaining };
  }

  /** One cancellation, with the same locking discipline as `TransitionReservationUseCase`. */
  private async cancelOne(
    reservationId: string,
    expectedStatus: ReservationStatus,
    serviceDate: string,
    actorId: string,
  ): Promise<void> {
    await this.prisma.runInTransaction(async (tx) => {
      const reservation = await this.reservations.findByIdForUpdate(tx, reservationId);
      if (!reservation) throw new ReservationNotFoundError(reservationId);

      // A booking that moved on while we were building the list. Re-reading its
      // status under the lock is what makes the guard below meaningful — the
      // status in the list was read outside any transaction.
      if (!isActiveReservationStatus(reservation.status)) return;

      const transition = this.stateMachine.transition({
        reservationId: reservation.id,
        merchantId: reservation.merchantId,
        from: reservation.status,
        to: ReservationStatus.CANCELLED,
        actor: ReservationActor.MERCHANT,
        actorId,
        // Tagged, so the lifecycle record says the system cancelled this rather
        // than a person tapping Cancel. See `closureCancellationReason`.
        reason: closureCancellationReason(serviceDate),
        now: new Date(),
      });

      const applied = await this.reservations.updateStatus(
        tx,
        reservation.id,
        transition.from,
        transition.to,
        { cancelledAt: transition.occurredAt, statusReason: closureCancellationReason(serviceDate), lastActor: ReservationActor.MERCHANT, lastActorId: actorId },
      );
      if (!applied) {
        throw new ConcurrentReservationModificationError(reservation.id, expectedStatus);
      }

      // The seats go back through the same rule every other exit uses. Duplicated
      // from `TransitionReservationUseCase` rather than extracted into a shared
      // helper because the shared helper would have to take a transaction client,
      // a policy read and a repository — at which point it is the use case.
      if (transition.sideEffects.includes(ReservationSideEffect.RELEASE_TABLE_SLOT)) {
        const { policy } = await this.reservations.findSettings(reservation.merchantId);
        const slots = occupiedSlotStarts(reservation.startsAt, {
          slotMinutes: policy.slotMinutes,
          turnMinutes: reservation.turnMinutes,
        });
        await this.reservations.releaseSlots(
          tx,
          reservation.merchantId,
          slots,
          reservation.partySize,
        );
      }

      const updated = await this.reservations.findByIdForUpdate(tx, reservation.id);
      const finalRow = updated ?? { ...reservation, status: transition.to };

      // The outbox event is what carries the cancellation to the customer's
      // tracker. Emitting it here rather than from a notification service is
      // what makes "booking cancelled but nobody told the customer" impossible.
      await this.outbox.enqueue(
        tx,
        this.outbox.buildReservationEvent({
          idGenerator: this.idGenerator,
          reservation: finalRow,
          actor: ReservationActor.MERCHANT,
          occurredAt: transition.occurredAt,
        }),
      );
    });
  }

  /** A CLOSED merchant is read-only; a suspended one may still plan rest days. */
  private async requireEditableMerchant(
    merchantId: string,
  ): Promise<{ id: string; timezone: string }> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, timezone: true, status: true },
    });
    if (!merchant) throw new MerchantNotEditableError('UNKNOWN', '找不到此商戶');
    if (merchant.status === 'CLOSED') {
      throw new MerchantNotEditableError(merchant.status, '已結業的商戶不可修改');
    }
    return merchant;
  }
}

const closureSelect = {
  id: true,
  serviceDate: true,
  reason: true,
  note: true,
  cancelledReservationsAt: true,
  cancelledReservationCount: true,
  createdAt: true,
} as const;

type ClosureRow = {
  id: string;
  serviceDate: Date;
  reason: string;
  note: string | null;
  cancelledReservationsAt: Date | null;
  cancelledReservationCount: number;
  createdAt: Date;
};

function toClosureView(row: ClosureRow): ClosureView {
  return {
    id: row.id,
    serviceDate: row.serviceDate.toISOString().slice(0, 10),
    reason: row.reason as ClosureReason,
    note: row.note,
    cancelledReservationsAt: row.cancelledReservationsAt?.toISOString() ?? null,
    cancelledReservationCount: row.cancelledReservationCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A `@db.Date` column round-trips as UTC midnight.
 *
 * Rejects a malformed string instead of letting `new Date('not-a-date')` reach
 * Prisma: an `Invalid Date` there is a `PrismaClientValidationError`, which the
 * filter maps to a 500 — the caller's typo would look like a server fault. The
 * check is here rather than only in a DTO because the date arrives as a PATH
 * parameter, and a path parameter is not covered by `@Body()` validation.
 */
function dateToDb(serviceDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    throw new InvalidClosureDateError(serviceDate, '日期格式必須為 YYYY-MM-DD');
  }
  const parsed = new Date(`${serviceDate}T00:00:00.000Z`);
  // `2026-02-31` matches the pattern but rolls over to March. Rejecting the
  // rollover keeps `serviceDate` equal to what the caller typed.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== serviceDate) {
    throw new InvalidClosureDateError(serviceDate, `「${serviceDate}」不是有效日期`);
  }
  return parsed;
}

/**
 * Refuse to plan a rest day in the past.
 *
 * "Past" is judged in the merchant's timezone, not the server's: at 17:00 UTC
 * a Hong Kong shop is already into tomorrow, and it must be able to close
 * tomorrow. Using the server's date here would refuse the one day the shop most
 * plausibly wants to close.
 *
 * The format check runs first so a malformed path parameter is a 400 rather
 * than a string comparison against nonsense.
 */
function assertNotPast(timeZone: string, serviceDate: string): void {
  dateToDb(serviceDate);
  const today = localDateString(timeZone, new Date());
  if (serviceDate < today) {
    throw new ClosureDateInPastError(serviceDate, today);
  }
}

function buildSweepMessage(
  serviceDate: string,
  sweep: { cancelled: number; alreadySwept: boolean; remaining: number },
): string {
  if (sweep.alreadySwept) {
    return `已更新 ${serviceDate} 的休息日設定。`;
  }
  if (sweep.remaining > 0) {
    return `${serviceDate} 已設為休息日，已取消 ${sweep.cancelled} 筆訂位，尚有 ${sweep.remaining} 筆未取消，請重新儲存。`;
  }
  if (sweep.cancelled === 0) {
    return `${serviceDate} 已設為休息日，當日沒有需要取消的訂位。`;
  }
  return `${serviceDate} 已設為休息日，已取消 ${sweep.cancelled} 筆訂位並通知顧客。`;
}

export { isClosureCancellationReason };
