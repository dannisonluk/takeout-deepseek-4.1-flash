import { Clock, SystemClock } from '../shared/index';
import {
  WaitlistActorNotPermittedError,
  WaitlistAlreadyTerminalError,
  WaitlistNotPermittedError,
} from './waitlist.errors';
import {
  WaitlistActor,
  WaitlistStatus,
  isTerminalWaitlistStatus,
} from './waitlist-status';

/**
 * What a transition obliges the rest of the system to do.
 *
 * Same contract as the other three machines: the domain says *what must happen*,
 * the application layer decides *how*.
 *
 * Note what is absent. There is no `RELEASE_TABLE_SLOT` — a queue ticket never
 * held a table, so there is nothing to give back. That absence is why the
 * waitlist machine is genuinely smaller than the reservation one rather than a
 * copy of it with the nouns changed.
 */
export enum WaitlistSideEffect {
  /** Push the new status to the guest's phone. */
  NOTIFY_CUSTOMER = 'NOTIFY_CUSTOMER',
  /** Tell the host board the queue moved. */
  NOTIFY_MERCHANT = 'NOTIFY_MERCHANT',
  /** Start the clock a called guest has to appear. */
  START_CALL_TIMEOUT = 'START_CALL_TIMEOUT',
  /** Count it against the guest. */
  RECORD_NO_SHOW = 'RECORD_NO_SHOW',
}

interface TransitionRule {
  readonly to: WaitlistStatus;
  readonly actors: readonly WaitlistActor[];
  readonly sideEffects: readonly WaitlistSideEffect[];
}

const ALL_STAFF = [WaitlistActor.MERCHANT, WaitlistActor.ADMIN];

/**
 * The queue lifecycle.
 *
 *   WAITING ──┬── CALLED ──┬── SEATED    （terminal）
 *             │            ├── NO_SHOW   （terminal）
 *             │            └── CANCELLED （terminal）
 *             └── CANCELLED （terminal，顧客可自行取消）
 *
 * Three rules carry the weight:
 *
 *   - **A guest may always leave the queue**, but only from `WAITING`. Once
 *     called, the shop has committed a table and is holding it; walking away
 *     without telling anyone is a no-show, not a cancellation, and the two need
 *     different books.
 *   - **Only the shop seats.** A guest cannot walk in and mark themselves
 *     seated — a queue that the queue-jumper administers is not a queue.
 *   - **A no-show releases nothing.** Unlike a reservation there is no slot to
 *     return, which is exactly why this table has no release effect.
 */
const TRANSITIONS: Readonly<Record<WaitlistStatus, readonly TransitionRule[]>> = {
  [WaitlistStatus.WAITING]: [
    {
      to: WaitlistStatus.CALLED,
      actors: ALL_STAFF,
      sideEffects: [
        WaitlistSideEffect.NOTIFY_CUSTOMER,
        WaitlistSideEffect.NOTIFY_MERCHANT,
        WaitlistSideEffect.START_CALL_TIMEOUT,
      ],
    },
    {
      to: WaitlistStatus.SEATED,
      // The host may seat a waiting guest directly — they were already at the
      // door. Refusing this would make the host call a number and then seat
      // them, which is theatre.
      actors: ALL_STAFF,
      sideEffects: [WaitlistSideEffect.NOTIFY_MERCHANT],
    },
    {
      to: WaitlistStatus.CANCELLED,
      actors: [WaitlistActor.CUSTOMER, ...ALL_STAFF],
      sideEffects: [WaitlistSideEffect.NOTIFY_MERCHANT],
    },
    {
      to: WaitlistStatus.NO_SHOW,
      // A guest who never answered the call in the first place. Only the shop
      // can decide they are gone — the guest is not present to say so.
      actors: ALL_STAFF,
      sideEffects: [WaitlistSideEffect.NOTIFY_MERCHANT, WaitlistSideEffect.RECORD_NO_SHOW],
    },
  ],

  [WaitlistStatus.CALLED]: [
    {
      to: WaitlistStatus.SEATED,
      actors: ALL_STAFF,
      sideEffects: [WaitlistSideEffect.NOTIFY_MERCHANT],
    },
    {
      to: WaitlistStatus.NO_SHOW,
      actors: [...ALL_STAFF, WaitlistActor.SYSTEM],
      sideEffects: [WaitlistSideEffect.NOTIFY_MERCHANT, WaitlistSideEffect.RECORD_NO_SHOW],
    },
    {
      to: WaitlistStatus.CANCELLED,
      // Deliberately NOT the customer. After being called they can either turn
      // up or not; letting them "cancel" would let a guest erase a call the
      // shop is holding a table for.
      actors: ALL_STAFF,
      sideEffects: [WaitlistSideEffect.NOTIFY_MERCHANT],
    },
  ],

  [WaitlistStatus.SEATED]: [],
  [WaitlistStatus.NO_SHOW]: [],
  [WaitlistStatus.CANCELLED]: [],
};

export interface WaitlistTransitionContext {
  readonly waitlistEntryId: string;
  readonly merchantId: string;
  readonly from: WaitlistStatus;
  readonly to: WaitlistStatus;
  readonly actor: WaitlistActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly now?: Date;
}

export interface WaitlistTransitionResult {
  readonly waitlistEntryId: string;
  readonly from: WaitlistStatus;
  readonly to: WaitlistStatus;
  readonly actor: WaitlistActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly occurredAt: Date;
  readonly sideEffects: readonly WaitlistSideEffect[];
  /** Set when the move starts a call timer. */
  readonly callDeadlineAt?: Date;
}

/**
 * The waitlist machine.
 *
 * The third of four machines in this codebase, and deliberately the same shape
 * as the other three: one `TRANSITIONS` table, one `tryTransition` probe, no
 * persistence, and the clock read only through the injected `Clock`.
 */
export class WaitlistStateMachine {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  transitionsFrom(status: WaitlistStatus) {
    return TRANSITIONS[status] ?? [];
  }

  /** Statuses reachable from `from` **by this actor** — drives the board's buttons. */
  allowedTransitions(from: WaitlistStatus, actor: WaitlistActor): WaitlistStatus[] {
    return this.transitionsFrom(from)
      .filter((rule) => rule.actors.includes(actor))
      .map((rule) => rule.to);
  }

  can(from: WaitlistStatus, to: WaitlistStatus, actor: WaitlistActor): boolean {
    return this.transitionsFrom(from).some(
      (rule) => rule.to === to && rule.actors.includes(actor),
    );
  }

  isTerminal(status: WaitlistStatus): boolean {
    return isTerminalWaitlistStatus(status);
  }

  transition(
    context: WaitlistTransitionContext,
    options: { readonly callTimeoutMinutes?: number } = {},
  ): WaitlistTransitionResult {
    const { waitlistEntryId, from, to, actor } = context;

    if (isTerminalWaitlistStatus(from)) {
      throw new WaitlistAlreadyTerminalError(from);
    }

    const rules = this.transitionsFrom(from);
    // Prefer the rule that admits this actor — a target reachable by several
    // actors must apply the right one, not merely the first one that matches.
    const matching =
      rules.find((rule) => rule.to === to && rule.actors.includes(actor)) ??
      rules.find((rule) => rule.to === to);

    if (!matching) {
      throw new WaitlistNotPermittedError(
        from,
        to,
        actor,
        rules.map((rule) => rule.to),
      );
    }

    if (!matching.actors.includes(actor)) {
      // Reachable, but not by you. Reported separately so the board can say
      // "the host does that" rather than "that is not a move".
      throw new WaitlistActorNotPermittedError(from, to, actor, matching.actors);
    }

    const occurredAt = context.now ?? this.clock.now();

    const result: WaitlistTransitionResult = {
      waitlistEntryId,
      from,
      to,
      actor,
      actorId: context.actorId,
      reason: context.reason,
      occurredAt,
      sideEffects: matching.sideEffects,
      ...(matching.sideEffects.includes(WaitlistSideEffect.START_CALL_TIMEOUT)
        ? {
            callDeadlineAt: new Date(
              occurredAt.getTime() + (options.callTimeoutMinutes ?? 10) * 60_000,
            ),
          }
        : {}),
    };

    return Object.freeze(result);
  }

  tryTransition(
    context: WaitlistTransitionContext,
    options?: { readonly callTimeoutMinutes?: number },
  ):
    | { ok: true; result: WaitlistTransitionResult }
    | { ok: false; error: Error } {
    try {
      return { ok: true, result: this.transition(context, options) };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
}
