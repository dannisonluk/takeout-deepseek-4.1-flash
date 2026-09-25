import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  IdGenerator,
  WaitlistActor,
  WaitlistEntryNotFoundError,
  WaitlistSideEffect,
  WaitlistStateMachine,
  WaitlistStatus,
  WaitlistTransitionResult,
} from '@takeout/domain';
import { ID_GENERATOR, WAITLIST_REPOSITORY, WAITLIST_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { ConcurrentWaitlistModificationError } from '../domain/waitlist.errors';
import {
  PersistedWaitlistEntry,
  WaitlistRepositoryPort,
  WaitlistStatusPatch,
} from '../domain/waitlist.repository.port';
import {
  QueueTransitionResultView,
  MerchantQueueEntryView,
} from '../interface/waitlist.views';
import { toMerchantEntry } from './waitlist.mapper';

export interface TransitionQueueCommand {
  readonly entryId: string;
  readonly to: WaitlistStatus;
  readonly actor: WaitlistActor;
  readonly actorId?: string;
  readonly reason?: string;
  /** The shop's policy, so the machine can set the call deadline. */
  readonly callTimeoutMinutes?: number;
  /** The queue position to embed in the response, for the board's re-render. */
  readonly position?: { position: number; ahead: number; estimatedWaitMinutes: number | null };
}

/**
 * The single write path for every queue status change.
 *
 * Same five steps as `TransitionReservationUseCase`, and the same reason for
 * each:
 *
 *   1. `SELECT ... FOR UPDATE` — serialise concurrent transitions on this row.
 *      Two hosts tapping "call" on the same ticket is the ordinary Friday case.
 *   2. `WaitlistStateMachine.transition` — authorise and derive obligations.
 *   3. conditional `UPDATE ... WHERE status = expected` — fail loudly if a
 *      writer slipped past the lock, rather than double-applying.
 *   4. **no slot release.** The waitlist machine's side-effect list has no
 *      `RELEASE_TABLE_SLOT`, because a queue ticket never held a table. This
 *      step does not exist here, and that absence is the design.
 *   5. outbox row, same transaction.
 *
 * Step 5 is what makes "the ticket moved but the guest's phone was never told"
 * structurally impossible, which matters more here than for a booking: a guest
 * who has wandered off to a nearby shop has no way to notice their number was
 * called, so the push is the only channel.
 */
@Injectable()
export class TransitionQueueUseCase {
  private readonly logger = new Logger(TransitionQueueUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WAITLIST_REPOSITORY) private readonly waitlist: WaitlistRepositoryPort,
    @Inject(WAITLIST_STATE_MACHINE) private readonly stateMachine: WaitlistStateMachine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
  ) {}

  async execute(command: TransitionQueueCommand): Promise<QueueTransitionResultView> {
    const now = new Date();

    const outcome = await this.prisma.runInTransaction(async (tx) => {
      const entry = await this.waitlist.findByIdForUpdate(tx, command.entryId);
      if (!entry) throw new WaitlistEntryNotFoundError(command.entryId);

      // Throws WaitlistAlreadyTerminalError / WaitlistNotPermittedError /
      // WaitlistActorNotPermittedError — all mapped by the exception filter.
      const transition = this.stateMachine.transition(
        {
          waitlistEntryId: entry.id,
          merchantId: entry.merchantId,
          from: entry.status,
          to: command.to,
          actor: command.actor,
          actorId: command.actorId,
          reason: command.reason,
          now,
        },
        {
          ...(command.callTimeoutMinutes !== undefined
            ? { callTimeoutMinutes: command.callTimeoutMinutes }
            : {}),
        },
      );

      const applied = await this.waitlist.updateStatus(
        tx,
        entry.id,
        transition.from,
        transition.to,
        buildPatch(transition, now),
      );
      if (!applied) {
        throw new ConcurrentWaitlistModificationError(entry.id, entry.status);
      }

      const updated = await this.waitlist.findByIdForUpdate(tx, entry.id);
      const finalRow = updated ?? { ...entry, status: transition.to, version: entry.version + 1 };

      // Every queue move notifies somebody — the guest's phone or the board.
      // Emitted from here rather than from a notification service so the two
      // cannot be separated by a crash between the status write and the push.
      await this.emit(tx, finalRow, transition, command.actor, now);

      return { entry: finalRow, transition };
    });

    const { transition } = outcome;
    this.logger.log(
      `Queue ticket ${outcome.entry.ticketNo}: ${transition.from} -> ${transition.to} by ${command.actor}`,
    );

    const position = command.position ?? {
      position: 0,
      ahead: 0,
      estimatedWaitMinutes: null,
    };

    return {
      entryId: outcome.entry.id,
      ticketNo: outcome.entry.ticketNo,
      fromStatus: transition.from,
      toStatus: transition.to,
      occurredAt: transition.occurredAt.toISOString(),
      sideEffects: transition.sideEffects,
      callDeadlineAt: transition.callDeadlineAt?.toISOString() ?? null,
      // What this actor may do next — drives the board's buttons, computed by
      // the same singleton that just authorised this move.
      allowedNextTransitions: this.stateMachine.allowedTransitions(
        transition.to,
        command.actor,
      ),
      entry: this.entryForResponse(outcome.entry, position, command),
    };
  }

  /**
   * The board's row for the response.
   *
   * The board re-renders the whole card from this, so it must carry the same
   * shape `listForMerchant` returns — a second, thinner projection here is how
   * a card loses a field the moment it is moved rather than merely listed.
   */
  private entryForResponse(
    entry: PersistedWaitlistEntry,
    position: { position: number; ahead: number; estimatedWaitMinutes: number | null },
    command: TransitionQueueCommand,
  ): MerchantQueueEntryView {
    return toMerchantEntry(
      entry,
      position,
      { callTimeoutMinutes: command.callTimeoutMinutes ?? 10 },
      this.stateMachine.allowedTransitions(entry.status, WaitlistActor.MERCHANT),
      new Date(),
    );
  }

  /**
   * Write the integration event.
   *
   * The outbox row is what the Socket.IO fan-out routes on, keyed by
   * `aggregateType: 'WaitlistEntry'`. Building it inside the same transaction as
   * the status change is the whole point of the pattern — the guest's phone and
   * the board can never disagree about what happened.
   *
   * `notifyCustomer` is carried on the payload rather than being decided by the
   * consumer: whether a move warrants a push is a fact the machine already
   * derived in `sideEffects`, and re-deriving it downstream is how a `SEATED`
   * ends up ringing a guest who is already at the table.
   */
  private async emit(
    tx: Prisma.TransactionClient,
    entry: PersistedWaitlistEntry,
    transition: WaitlistTransitionResult,
    actor: WaitlistActor,
    now: Date,
  ): Promise<void> {
    await this.outbox.enqueue(
      tx,
      this.outbox.buildWaitlistEvent({
        idGenerator: this.idGenerator,
        entry,
        actor,
        occurredAt: now,
        notifyCustomer: transition.sideEffects.includes(WaitlistSideEffect.NOTIFY_CUSTOMER),
        recordNoShow: transition.sideEffects.includes(WaitlistSideEffect.RECORD_NO_SHOW),
      }),
    );
  }
}

/**
 * Stamp the timestamp column that belongs to the status being entered.
 *
 * `calledAt` is the one that matters: it is what the call-timeout sweep
 * measures from, so a `CALLED` written without it is a ticket that can never be
 * timed out and will sit on the board as "being seated" forever.
 */
function buildPatch(transition: WaitlistTransitionResult, now: Date): WaitlistStatusPatch {
  const reason: WaitlistStatusPatch =
    transition.reason !== undefined ? { statusReason: transition.reason } : {};

  switch (transition.to) {
    case WaitlistStatus.CALLED:
      return { calledAt: now, ...reason };
    case WaitlistStatus.SEATED:
      return { seatedAt: now, ...reason };
    case WaitlistStatus.NO_SHOW:
    case WaitlistStatus.CANCELLED:
      return { cancelledAt: now, ...reason };
    default:
      return reason;
  }
}
