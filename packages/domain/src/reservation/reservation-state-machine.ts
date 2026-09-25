import { Clock, SystemClock } from '../shared/index';
import {
  ReservationAlreadyTerminalError,
  ReservationNotPermittedError,
  ReservationOutsideTurnWindowError,
  ReservationsPausedError,
} from './reservation.errors';
import {
  ReservationActor,
  ReservationStatus,
  isTerminalReservationStatus,
} from './reservation-status';

/**
 * What a transition obliges the rest of the system to do.
 *
 * Same contract as the order machine: the domain says *what must happen*, the
 * application layer decides *how*.
 */
export enum ReservationSideEffect {
  /** Push the new status to the customer. */
  NOTIFY_CUSTOMER = 'NOTIFY_CUSTOMER',
  /** Tell the shop's board that the book moved. */
  NOTIFY_MERCHANT = 'NOTIFY_MERCHANT',
  /** Give the seats back to every start-slot the booking occupies. */
  RELEASE_TABLE_SLOT = 'RELEASE_TABLE_SLOT',
  /** Count the party as a no-show against the customer. */
  RECORD_NO_SHOW = 'RECORD_NO_SHOW',
}

export type ReservationGuard = 'RESERVATIONS_ACCEPTING' | 'WITHIN_TURN_WINDOW';

interface TransitionRule {
  readonly to: ReservationStatus;
  readonly actors: readonly ReservationActor[];
  readonly sideEffects: readonly ReservationSideEffect[];
  readonly guards?: readonly ReservationGuard[];
}

const STAFF = [ReservationActor.SYSTEM, ReservationActor.ADMIN];
const STAFF_ONLY = [ReservationActor.ADMIN];

/**
 * The reservation lifecycle.
 *
 * Two things are worth noticing, because both are the kind of rule that gets
 * lost when authorisation is scattered across services:
 *
 *   - `RELEASE_TABLE_SLOT` appears on EVERY path out of the active set and on
 *     none of the paths within it. A booking that is declined, cancelled, marked
 *     no-show or completed has stopped holding its seats; one that is merely
 *     confirmed has not. Getting this wrong in either direction is silent — one
 *     way leaks capacity until the book looks full, the other sells the same
 *     table twice.
 *   - A customer may cancel, but never confirm or seat. A shop may do all three.
 */
const TRANSITIONS: Readonly<Record<ReservationStatus, readonly TransitionRule[]>> = {
  [ReservationStatus.PENDING]: [
    {
      to: ReservationStatus.CONFIRMED,
      actors: [ReservationActor.MERCHANT, ...STAFF],
      guards: ['RESERVATIONS_ACCEPTING'],
      sideEffects: [ReservationSideEffect.NOTIFY_CUSTOMER],
    },
    {
      to: ReservationStatus.DECLINED,
      actors: [ReservationActor.MERCHANT, ...STAFF],
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.NOTIFY_CUSTOMER,
        ReservationSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      to: ReservationStatus.CANCELLED,
      actors: [ReservationActor.CUSTOMER, ReservationActor.MERCHANT, ...STAFF],
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.NOTIFY_CUSTOMER,
        ReservationSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      // A booking the shop never got to. The sweep marks it so the seats do not
      // stay committed to a party that has already walked past the door.
      to: ReservationStatus.NO_SHOW,
      actors: STAFF,
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.RECORD_NO_SHOW,
      ],
    },
  ],

  [ReservationStatus.CONFIRMED]: [
    {
      to: ReservationStatus.SEATED,
      actors: [ReservationActor.MERCHANT, ...STAFF],
      // Deliberately no guard: the party is standing at the desk. Refusing to
      // seat them because the intake switch is off would be the system arguing
      // with reality.
      sideEffects: [ReservationSideEffect.NOTIFY_MERCHANT],
    },
    {
      to: ReservationStatus.CANCELLED,
      actors: [ReservationActor.CUSTOMER, ReservationActor.MERCHANT, ...STAFF],
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.NOTIFY_CUSTOMER,
        ReservationSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      to: ReservationStatus.NO_SHOW,
      actors: [ReservationActor.MERCHANT, ...STAFF],
      guards: ['WITHIN_TURN_WINDOW'],
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.RECORD_NO_SHOW,
        ReservationSideEffect.NOTIFY_MERCHANT,
      ],
    },
  ],

  [ReservationStatus.SEATED]: [
    {
      to: ReservationStatus.COMPLETED,
      actors: [ReservationActor.MERCHANT, ...STAFF],
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.NOTIFY_MERCHANT,
      ],
    },
    {
      // Walked out, or the shop had to end the sitting. Still releases: the
      // table is free either way.
      to: ReservationStatus.CANCELLED,
      actors: [ReservationActor.MERCHANT, ...STAFF],
      sideEffects: [
        ReservationSideEffect.RELEASE_TABLE_SLOT,
        ReservationSideEffect.NOTIFY_MERCHANT,
      ],
    },
  ],

  [ReservationStatus.COMPLETED]: [],
  [ReservationStatus.DECLINED]: [],
  [ReservationStatus.CANCELLED]: [],
  [ReservationStatus.NO_SHOW]: [],
};

const GUARDS: Readonly<Record<ReservationGuard, (ctx: ReservationTransitionContext) => void>> = {
  RESERVATIONS_ACCEPTING: (ctx) => {
    // Support staff may force a confirmation the shop has paused on — the
    // customer is on the phone and the answer is yes.
    if (ctx.actor === ReservationActor.ADMIN) return;
    if (ctx.merchantAcceptingReservations === false) {
      throw new ReservationsPausedError(ctx.merchantId);
    }
  },
  WITHIN_TURN_WINDOW: (ctx) => {
    if (ctx.actor === ReservationActor.ADMIN) return;
    if (ctx.withinTurnWindow === false) {
      throw new ReservationOutsideTurnWindowError(ctx.reservationId);
    }
  },
};

export interface ReservationTransitionContext {
  readonly reservationId: string;
  readonly merchantId: string;
  readonly from: ReservationStatus;
  readonly to: ReservationStatus;
  readonly actor: ReservationActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly now?: Date;
  /** The shop's intake switch. `undefined` means "not evaluated". */
  readonly merchantAcceptingReservations?: boolean;
  /** Whether `now` is at or past the booked time. `undefined` = not evaluated. */
  readonly withinTurnWindow?: boolean;
}

export interface ReservationTransitionResult {
  readonly reservationId: string;
  readonly from: ReservationStatus;
  readonly to: ReservationStatus;
  readonly actor: ReservationActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly occurredAt: Date;
  readonly sideEffects: readonly ReservationSideEffect[];
}

/**
 * Pure reservation lifecycle machine.
 *
 * Mirrors `OrderStateMachine` deliberately — same table shape, same
 * `tryTransition` probe, same "no persistence, no clock reads except through the
 * injected Clock" discipline. Two machines that behave the same way are easier
 * to hold in the head than two that each invented their own contract.
 */
export class ReservationStateMachine {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  transitionsFrom(status: ReservationStatus): readonly TransitionRule[] {
    return TRANSITIONS[status] ?? [];
  }

  /** Statuses reachable from `from` **by this actor** — drives the board's buttons. */
  allowedTransitions(
    from: ReservationStatus,
    actor: ReservationActor,
  ): ReservationStatus[] {
    return this.transitionsFrom(from)
      .filter((rule) => rule.actors.includes(actor))
      .map((rule) => rule.to);
  }

  can(from: ReservationStatus, to: ReservationStatus, actor: ReservationActor): boolean {
    return this.transitionsFrom(from).some(
      (rule) => rule.to === to && rule.actors.includes(actor),
    );
  }

  isTerminal(status: ReservationStatus): boolean {
    return isTerminalReservationStatus(status);
  }

  transition(context: ReservationTransitionContext): ReservationTransitionResult {
    const { reservationId, from, to, actor } = context;

    if (isTerminalReservationStatus(from)) {
      throw new ReservationAlreadyTerminalError(from);
    }

    const rules = this.transitionsFrom(from);
    // Prefer the rule that admits this actor: one target can be reachable by
    // several actors under different guards, and taking the first rule that
    // merely matches `to` would apply the wrong one.
    const matching =
      rules.find((rule) => rule.to === to && rule.actors.includes(actor)) ??
      rules.find((rule) => rule.to === to);

    if (!matching) {
      throw new ReservationNotPermittedError(
        from,
        to,
        actor,
        rules.map((rule) => rule.to),
      );
    }

    if (!matching.actors.includes(actor)) {
      throw new ReservationNotPermittedError(
        from,
        to,
        actor,
        matching.actors,
      );
    }

    for (const guard of matching.guards ?? []) {
      GUARDS[guard](context);
    }

    return Object.freeze({
      reservationId,
      from,
      to,
      actor,
      actorId: context.actorId,
      reason: context.reason,
      occurredAt: context.now ?? this.clock.now(),
      sideEffects: matching.sideEffects,
    });
  }

  tryTransition(context: ReservationTransitionContext):
    | { ok: true; result: ReservationTransitionResult }
    | { ok: false; error: Error } {
    try {
      return { ok: true, result: this.transition(context) };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
}
