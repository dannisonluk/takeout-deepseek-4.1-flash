import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IdGenerator,
  RefundRequestActor,
  RefundRequestNotFoundError,
  RefundRequestSideEffect,
  RefundRequestStateMachine,
  RefundRequestStatus,
} from '@takeout/domain';
import { ID_GENERATOR, REFUND_REPOSITORY, REFUND_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { ConcurrentRefundModificationError } from '../domain/refund.errors';
import {
  PersistedRefundRequest,
  RefundRepositoryPort,
  RefundRequestStatusPatch,
} from '../domain/refund.repository.port';

export interface TransitionRefundRequestCommand {
  readonly refundRequestId: string;
  readonly to: RefundRequestStatus;
  readonly actor: RefundRequestActor;
  readonly actorId?: string;
  /** The shop's reply, shown verbatim to the customer. */
  readonly merchantNote?: string | null;
  /** What the shop says it handed back. Advisory — the platform cannot verify it. */
  readonly settledAmountMinor?: number | null;
  /** Anything the customer can quote, for cash or a bank transfer. */
  readonly settlementReference?: string | null;
}

export interface TransitionRefundRequestResult {
  readonly refundRequestId: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly fromStatus: RefundRequestStatus;
  readonly toStatus: RefundRequestStatus;
  readonly occurredAt: Date;
  /** Obligations the caller must discharge (notify). Never a money move. */
  readonly sideEffects: readonly RefundRequestSideEffect[];
  /** What this actor may do next — drives the queue's buttons. */
  readonly allowedNextTransitions: readonly RefundRequestStatus[];
  /** The ticket after the change, for the response body. */
  readonly refundRequest: PersistedRefundRequest;
}

/**
 * The single write path for every refund-ticket status change.
 *
 * Same shape as `TransitionReservationUseCase`:
 *
 *   1. locking read inside the transaction;
 *   2. `RefundRequestStateMachine.transition` — authorise and derive obligations;
 *   3. conditional `UPDATE ... WHERE status = expected` — fail loudly if a
 *      writer slipped past, rather than double-applying;
 *   4. outbox row, same transaction.
 *
 * There is deliberately **no step 5**. The reservation path releases seats after
 * the state change; this path has nothing to release, because a ticket holds no
 * capacity and moves no money. The `RESOLVED_OFFLINE` amount and reference are
 * recorded as **claims** — the platform is not in the money path and cannot
 * verify either, so they are stored next to the note that says so rather than
 * being treated as settlement.
 */
@Injectable()
export class TransitionRefundRequestUseCase {
  private readonly logger = new Logger(TransitionRefundRequestUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REFUND_REPOSITORY) private readonly refunds: RefundRepositoryPort,
    @Inject(REFUND_STATE_MACHINE) private readonly stateMachine: RefundRequestStateMachine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
  ) {}

  async execute(
    command: TransitionRefundRequestCommand,
  ): Promise<TransitionRefundRequestResult> {
    const now = new Date();

    const outcome = await this.prisma.runInTransaction(async (tx) => {
      const current = await this.refunds.findByIdForUpdate(tx, command.refundRequestId);
      if (!current) throw new RefundRequestNotFoundError(command.refundRequestId);

      // Throws RefundRequestAlreadyTerminalError / RefundRequestNotPermittedError
      // / RefundSettlementDetailsRequiredError.
      const transition = this.stateMachine.transition({
        refundRequestId: current.id,
        orderId: current.orderId,
        merchantId: current.merchantId,
        from: current.status,
        to: command.to,
        actor: command.actor,
        actorId: command.actorId,
        now,
        settledAmountMinor: command.settledAmountMinor,
        settlementReference: command.settlementReference,
      });

      const applied = await this.refunds.updateStatus(
        tx,
        current.id,
        transition.from,
        transition.to,
        buildPatch(transition.to, command, now),
      );
      if (!applied) {
        throw new ConcurrentRefundModificationError(current.id, current.status);
      }

      const updated = await this.refunds.findByIdForUpdate(tx, current.id);
      const finalRow = updated ?? { ...current, status: transition.to };

      await this.outbox.enqueue(
        tx,
        this.outbox.buildRefundRequestEvent({
          idGenerator: this.idGenerator,
          refundRequest: finalRow,
          occurredAt: now,
        }),
      );

      return { refundRequest: finalRow, transition };
    });

    const { transition } = outcome;
    this.logger.log(
      `Refund request ${outcome.refundRequest.id}: ${transition.from} -> ${transition.to} by ${command.actor}`,
    );

    return {
      refundRequestId: outcome.refundRequest.id,
      orderId: outcome.refundRequest.orderId,
      orderNo: outcome.refundRequest.orderNo,
      fromStatus: transition.from,
      toStatus: transition.to,
      occurredAt: transition.occurredAt,
      sideEffects: transition.sideEffects,
      allowedNextTransitions: this.stateMachine.allowedTransitions(
        transition.to,
        command.actor,
      ),
      refundRequest: outcome.refundRequest,
    };
  }
}

/** Stamp the column that belongs to the status being entered. */
function buildPatch(
  status: RefundRequestStatus,
  command: TransitionRefundRequestCommand,
  now: Date,
): RefundRequestStatusPatch {
  // `!== undefined`, not truthiness — `null` means "clear the shop's note" and a
  // truthy check would silently keep the old one.
  const withNote: RefundRequestStatusPatch =
    command.merchantNote !== undefined ? { merchantNote: command.merchantNote } : {};

  switch (status) {
    case RefundRequestStatus.RESOLVED_OFFLINE:
      return {
        ...withNote,
        ...(command.settledAmountMinor !== undefined
          ? { settledAmountMinor: command.settledAmountMinor }
          : {}),
        ...(command.settlementReference !== undefined
          ? { settlementReference: normalizeReference(command.settlementReference) }
          : {}),
        resolvedById: command.actorId ?? null,
        resolvedAt: now,
      };
    case RefundRequestStatus.DECLINED:
      return { ...withNote, resolvedById: command.actorId ?? null, resolvedAt: now };
    case RefundRequestStatus.CANCELLED:
      return { ...withNote, cancelledAt: now };
    default:
      // OPEN -> IN_DISCUSSION: the note is the whole point of the move.
      return withNote;
  }
}

/** A blank string would satisfy "has a reference" in a UI while recording nothing. */
function normalizeReference(reference: string | null | undefined): string | null {
  const trimmed = reference?.trim();
  return trimmed ? trimmed : null;
}
