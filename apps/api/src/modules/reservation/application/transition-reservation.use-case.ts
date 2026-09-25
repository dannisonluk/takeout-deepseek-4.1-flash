import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IdGenerator,
  ReservationActor,
  ReservationNotFoundError,
  ReservationSideEffect,
  ReservationStateMachine,
  ReservationStatus,
  occupiedSlotStarts,
} from '@takeout/domain';
import { ID_GENERATOR, RESERVATION_REPOSITORY, RESERVATION_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { ConcurrentReservationModificationError } from '../domain/reservation.errors';
import {
  PersistedReservation,
  ReservationRepositoryPort,
  ReservationStatusPatch,
} from '../domain/reservation.repository.port';

export interface TransitionReservationCommand {
  readonly reservationId: string;
  readonly to: ReservationStatus;
  readonly actor: ReservationActor;
  readonly actorId?: string;
  readonly reason?: string;
  /**
   * The shop's intake switch, passed in by the caller so the
   * `RESERVATIONS_ACCEPTING` guard has something to read.
   */
  readonly merchantAcceptingReservations?: boolean;
  /** The shop's reply, shown verbatim to the customer. */
  readonly merchantNote?: string | null;
}

export interface TransitionReservationResult {
  readonly reservationId: string;
  readonly reservationNo: string;
  readonly fromStatus: ReservationStatus;
  readonly toStatus: ReservationStatus;
  readonly occurredAt: Date;
  /** Obligations the caller must discharge (notify, release). */
  readonly sideEffects: readonly ReservationSideEffect[];
  /** What this actor may do next — drives the board's buttons. */
  readonly allowedNextTransitions: readonly ReservationStatus[];
  /** The reservation after the change, for the response body. */
  readonly reservation: PersistedReservation;
}

/**
 * The single write path for every reservation status change.
 *
 * Same discipline as `TransitionOrderUseCase`, and the same reason:
 *
 *   1. `SELECT ... FOR UPDATE` — serialise concurrent transitions on this row.
 *   2. `ReservationStateMachine.transition` — authorise and derive obligations.
 *   3. conditional `UPDATE ... WHERE status = expected` — fail loudly if a
 *      writer slipped past the row lock, rather than double-applying.
 *   4. slot release, when the machine says the seats stopped being held.
 *   5. outbox row, same transaction.
 *
 * The one place this DIVERGES from the order path is the slot release. The
 * order's quota release reads `findReleaseContext` because the lines live in a
 * child table; here the booking *is* the context — `startsAt` and
 * `turnMinutes` are on the row, so the slots to give back are recomputed from
 * the reservation itself rather than looked up. `turnMinutes` is the value
 * copied at booking time, which is what makes the release exactly symmetric
 * with the hold even after the shop changes its settings.
 */
@Injectable()
export class TransitionReservationUseCase {
  private readonly logger = new Logger(TransitionReservationUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepositoryPort,
    @Inject(RESERVATION_STATE_MACHINE) private readonly stateMachine: ReservationStateMachine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
  ) {}

  async execute(command: TransitionReservationCommand): Promise<TransitionReservationResult> {
    const now = new Date();

    const outcome = await this.prisma.runInTransaction(async (tx) => {
      const reservation = await this.reservations.findByIdForUpdate(tx, command.reservationId);
      if (!reservation) throw new ReservationNotFoundError(command.reservationId);

      // Throws ReservationAlreadyTerminalError / ReservationNotPermittedError /
      // ReservationsPausedError / ReservationOutsideTurnWindowError.
      const transition = this.stateMachine.transition({
        reservationId: reservation.id,
        merchantId: reservation.merchantId,
        from: reservation.status,
        to: command.to,
        actor: command.actor,
        actorId: command.actorId,
        reason: command.reason,
        now,
        merchantAcceptingReservations: command.merchantAcceptingReservations,
        // A no-show may only be declared once the party is actually late. The
        // machine owns the rule; this supplies the fact it needs.
        withinTurnWindow: now.getTime() >= reservation.startsAt.getTime(),
      });

      const applied = await this.reservations.updateStatus(
        tx,
        reservation.id,
        transition.from,
        transition.to,
        buildPatch(transition.to, command, now),
      );
      if (!applied) {
        throw new ConcurrentReservationModificationError(reservation.id, reservation.status);
      }

      // Seats go back on exactly the paths out of the active set — the domain
      // table decides which, not this use case. Getting it wrong in either
      // direction is silent: one way leaks capacity until the book looks full,
      // the other sells the same table twice.
      if (transition.sideEffects.includes(ReservationSideEffect.RELEASE_TABLE_SLOT)) {
        // `turnMinutes` comes from the ROW (copied at booking), `slotMinutes`
        // from the live settings. That split is deliberate and is the one thing
        // worth understanding about this release:
        //
        //   - `turnMinutes` decides how MANY start-slots the booking occupies,
        //     so it must be the value the hold used. Reading the live setting
        //     would strand seats: a shop that shortened its turn from 90 to 60
        //     minutes would release only two of the three slots it took, and
        //     the third would stay booked forever.
        //   - `slotMinutes` only sets the grid SIZE, and `occupiedSlotStarts`
        //     walks forward from `startsAt` — which was already snapshotted on
        //     the grid this merchant used at booking time. So any divisor that
        //     yields the same slot count releases exactly the right rows. Using
        //     the live value is therefore safe, and using a stale one would not
        //     be worse.
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

      await this.outbox.enqueue(
        tx,
        this.outbox.buildReservationEvent({
          idGenerator: this.idGenerator,
          reservation: finalRow,
          actor: command.actor,
          occurredAt: now,
        }),
      );

      return { reservation: finalRow, transition };
    });

    const { transition } = outcome;
    this.logger.log(
      `Reservation ${outcome.reservation.reservationNo}: ${transition.from} -> ${transition.to} by ${command.actor}`,
    );

    return {
      reservationId: outcome.reservation.id,
      reservationNo: outcome.reservation.reservationNo,
      fromStatus: transition.from,
      toStatus: transition.to,
      occurredAt: transition.occurredAt,
      sideEffects: transition.sideEffects,
      allowedNextTransitions: this.stateMachine.allowedTransitions(transition.to, command.actor),
      reservation: outcome.reservation,
    };
  }
}

/** Stamp the timestamp column that belongs to the status being entered. */
function buildPatch(
  status: ReservationStatus,
  command: TransitionReservationCommand,
  now: Date,
): ReservationStatusPatch {
  const withReason: ReservationStatusPatch =
    command.reason !== undefined ? { statusReason: command.reason } : {};
  const withNote: ReservationStatusPatch =
    command.merchantNote !== undefined ? { merchantNote: command.merchantNote } : {};
  const actor: ReservationStatusPatch = {
    lastActor: command.actor,
    lastActorId: command.actorId ?? null,
  };
  const common = { ...withReason, ...withNote, ...actor };

  switch (status) {
    case ReservationStatus.CONFIRMED:
      return { confirmedAt: now, ...common };
    case ReservationStatus.SEATED:
      return { seatedAt: now, ...common };
    case ReservationStatus.COMPLETED:
      return { completedAt: now, ...common };
    case ReservationStatus.DECLINED:
    case ReservationStatus.CANCELLED:
    case ReservationStatus.NO_SHOW:
      return { cancelledAt: now, ...common };
    default:
      return common;
  }
}
