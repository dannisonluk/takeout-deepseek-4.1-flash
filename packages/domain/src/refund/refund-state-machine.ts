import { Clock, SystemClock } from '../shared/index';
import {
  RefundRequestAlreadyTerminalError,
  RefundRequestNotPermittedError,
  RefundSettlementDetailsRequiredError,
} from './refund.errors';
import {
  RefundRequestActor,
  RefundRequestStatus,
  isTerminalRefundRequestStatus,
} from './refund-status';

/**
 * What a transition obliges the rest of the system to do.
 *
 * Same contract as the order and reservation machines: the domain says *what
 * must happen*, the application layer decides *how*.
 *
 * Note what is **not** here. There is no `REFUND_PAYMENT` and no
 * `MOVE_MONEY`. This ticket flow has no money side effect by design — the
 * absence is the design, so adding one later has to be a deliberate act rather
 * than a side effect of extending an enum.
 */
export enum RefundRequestSideEffect {
  /** Push the new status to the customer. */
  NOTIFY_CUSTOMER = 'NOTIFY_CUSTOMER',
  /** Tell the shop's queue that an item moved. */
  NOTIFY_MERCHANT = 'NOTIFY_MERCHANT',
}

/**
 * The refund ticket lifecycle.
 *
 *   OPEN ──┬── IN_DISCUSSION ──┬── RESOLVED_OFFLINE   （terminal）
 *          │                    ├── DECLINED           （terminal）
 *          │                    └── CANCELLED          （terminal, customer only）
 *          ├── RESOLVED_OFFLINE （terminal）
 *          ├── DECLINED         （terminal）
 *          └── CANCELLED        （terminal, customer only）
 *
 * Two rules are worth spelling out, because both are the kind that gets lost
 * when authorisation is spread across services:
 *
 *   - **A customer may always withdraw their own ticket**, from either active
 *     status. Anything else would trap somebody in a conversation they want out
 *     of, which is exactly the situation a complaint channel must not create.
 *   - **A customer may never resolve or decline.** Only the shop decides what
 *     it hands over, and only the shop can say "we are not refunding".
 */
const TRANSITIONS: Readonly<
  Record<RefundRequestStatus, readonly {
    readonly to: RefundRequestStatus;
    readonly actors: readonly RefundRequestActor[];
    readonly sideEffects: readonly RefundRequestSideEffect[];
    readonly requiresSettlementDetails?: boolean;
  }[]>
> = {
  [RefundRequestStatus.OPEN]: [
    {
      to: RefundRequestStatus.IN_DISCUSSION,
      actors: [RefundRequestActor.MERCHANT, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      to: RefundRequestStatus.RESOLVED_OFFLINE,
      actors: [RefundRequestActor.MERCHANT, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
      requiresSettlementDetails: true,
    },
    {
      to: RefundRequestStatus.DECLINED,
      actors: [RefundRequestActor.MERCHANT, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      to: RefundRequestStatus.CANCELLED,
      actors: [RefundRequestActor.CUSTOMER, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
    },
  ],

  [RefundRequestStatus.IN_DISCUSSION]: [
    {
      to: RefundRequestStatus.RESOLVED_OFFLINE,
      actors: [RefundRequestActor.MERCHANT, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
      requiresSettlementDetails: true,
    },
    {
      to: RefundRequestStatus.DECLINED,
      actors: [RefundRequestActor.MERCHANT, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      to: RefundRequestStatus.CANCELLED,
      actors: [RefundRequestActor.CUSTOMER, RefundRequestActor.ADMIN],
      sideEffects: [
        RefundRequestSideEffect.NOTIFY_CUSTOMER,
        RefundRequestSideEffect.NOTIFY_MERCHANT,
      ],
    },
  ],

  [RefundRequestStatus.RESOLVED_OFFLINE]: [],
  [RefundRequestStatus.DECLINED]: [],
  [RefundRequestStatus.CANCELLED]: [],
};

export interface RefundTransitionContext {
  readonly refundRequestId: string;
  readonly orderId: string;
  readonly merchantId: string;
  readonly from: RefundRequestStatus;
  readonly to: RefundRequestStatus;
  readonly actor: RefundRequestActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly now?: Date;
  /** What the shop says it handed back, in minor units. */
  readonly settledAmountMinor?: number | null;
  /** Any reference the customer can quote. */
  readonly settlementReference?: string | null;
}

export interface RefundTransitionResult {
  readonly refundRequestId: string;
  readonly from: RefundRequestStatus;
  readonly to: RefundRequestStatus;
  readonly actor: RefundRequestActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly occurredAt: Date;
  readonly sideEffects: readonly RefundRequestSideEffect[];
}

/**
 * Pure refund-ticket lifecycle machine.
 *
 * Mirrors `ReservationStateMachine` deliberately — same table shape, same
 * `tryTransition` probe, same "no persistence, no clock reads except through the
 * injected Clock" discipline. Three machines that behave the same way are
 * easier to hold in the head than three that each invented their own contract.
 */
export class RefundRequestStateMachine {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  transitionsFrom(status: RefundRequestStatus) {
    return TRANSITIONS[status] ?? [];
  }

  /** Statuses reachable from `from` **by this actor** — drives the queue's buttons. */
  allowedTransitions(
    from: RefundRequestStatus,
    actor: RefundRequestActor,
  ): RefundRequestStatus[] {
    return this.transitionsFrom(from)
      .filter((rule) => rule.actors.includes(actor))
      .map((rule) => rule.to);
  }

  can(from: RefundRequestStatus, to: RefundRequestStatus, actor: RefundRequestActor): boolean {
    return this.transitionsFrom(from).some(
      (rule) => rule.to === to && rule.actors.includes(actor),
    );
  }

  isTerminal(status: RefundRequestStatus): boolean {
    return isTerminalRefundRequestStatus(status);
  }

  transition(context: RefundTransitionContext): RefundTransitionResult {
    const { refundRequestId, from, to, actor } = context;

    if (isTerminalRefundRequestStatus(from)) {
      throw new RefundRequestAlreadyTerminalError(from);
    }

    const rules = this.transitionsFrom(from);
    // Prefer the rule that admits this actor: one target can be reachable by
    // several actors, and taking the first rule that merely matches `to` would
    // apply the wrong one.
    const matching =
      rules.find((rule) => rule.to === to && rule.actors.includes(actor)) ??
      rules.find((rule) => rule.to === to);

    if (!matching) {
      throw new RefundRequestNotPermittedError(
        from,
        to,
        actor,
        rules.map((rule) => rule.to),
      );
    }

    if (!matching.actors.includes(actor)) {
      throw new RefundRequestNotPermittedError(from, to, actor, matching.actors);
    }

    // `RESOLVED_OFFLINE` is a claim, and a claim with no content is worse than
    // no claim at all: it closes the queue item while the customer is still
    // waiting. Require at least one of amount / reference.
    if (matching.requiresSettlementDetails) {
      const hasAmount =
        typeof context.settledAmountMinor === 'number' && context.settledAmountMinor > 0;
      const hasReference = Boolean(context.settlementReference?.trim());
      if (!hasAmount && !hasReference) {
        throw new RefundSettlementDetailsRequiredError(refundRequestId);
      }
    }

    return Object.freeze({
      refundRequestId,
      from,
      to,
      actor,
      actorId: context.actorId,
      reason: context.reason,
      occurredAt: context.now ?? this.clock.now(),
      sideEffects: matching.sideEffects,
    });
  }

  tryTransition(context: RefundTransitionContext):
    | { ok: true; result: RefundTransitionResult }
    | { ok: false; error: Error } {
    try {
      return { ok: true, result: this.transition(context) };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
}
