import { Clock, SystemClock } from '../shared/index';
import {
  ActorNotPermittedError,
  IllegalOrderTransitionError,
  ManualSettlementNotAllowedError,
  MerchantNotAcceptingOrdersError,
  OrderAlreadyTerminalError,
  RefundWithoutPaymentError,
} from './order.errors';
import { isTerminalStatus, OrderActor, OrderStatus, PaymentMode } from './order-status';

/**
 * Declarative description of what a transition obliges the rest of the system to
 * do. The domain decides *what must happen*; the application layer decides *how*
 * (publish to the outbox, enqueue a timer, call the PSP).
 */
export enum OrderSideEffect {
  /** Notify the kitchen board over WebSocket. */
  NOTIFY_MERCHANT_NEW_ORDER = 'NOTIFY_MERCHANT_NEW_ORDER',
  /** Push a status change to the customer. */
  NOTIFY_CUSTOMER_STATUS = 'NOTIFY_CUSTOMER_STATUS',
  /** Start the "merchant must accept within N minutes" timer. */
  SCHEDULE_MERCHANT_ACCEPT_TIMEOUT = 'SCHEDULE_MERCHANT_ACCEPT_TIMEOUT',
  /** Stop that timer — no longer relevant. */
  CANCEL_MERCHANT_ACCEPT_TIMEOUT = 'CANCEL_MERCHANT_ACCEPT_TIMEOUT',
  /** Return soft-held daily-quota units to `MenuItemDailyStock`. */
  RELEASE_DAILY_QUOTA = 'RELEASE_DAILY_QUOTA',
  /**
   * Move soft-held units into `sold` instead of returning them to the pool.
   *
   * `held` alone cannot express "the kitchen actually made this", which is why
   * `sold` stayed at 0 and could not back a sales report: every path that
   * closed an order either decremented `held` or left it untouched. The
   * distinction is *physical* — units that were produced are gone whether or
   * not the customer turned up, so they must not go back into the pool and
   * become sellable again.
   *
   * Fires on `-> COMPLETED` and on the `READY_FOR_PICKUP -> EXPIRED` no-show.
   * Deliberately NOT on a merchant cancelling after `PREPARING`: the customer
   * is refunded, so it is not a sale and `sold` must not claim it was.
   */
  CONVERT_HOLD_TO_SOLD = 'CONVERT_HOLD_TO_SOLD',
  /** Ask the payment provider for a refund. */
  ISSUE_REFUND = 'ISSUE_REFUND',
  /** Start the "customer must collect within N minutes" timer. */
  START_PICKUP_WINDOW_TIMER = 'START_PICKUP_WINDOW_TIMER',
  /** Ask the active `IDispatchService` to assign a rider (no-op for self-pickup). */
  DISPATCH_RIDER = 'DISPATCH_RIDER',
  /** Write the immutable payout ledger row for this order. */
  RECORD_PAYOUT_LEDGER = 'RECORD_PAYOUT_LEDGER',
}

export type OrderGuard = 'MERCHANT_ACCEPTING' | 'PAYMENT_CAPTURED' | 'MANUAL_SETTLEMENT_ALLOWED';

interface TransitionRule {
  readonly to: OrderStatus;
  readonly actors: readonly OrderActor[];
  readonly sideEffects: readonly OrderSideEffect[];
  readonly guards?: readonly OrderGuard[];
}

const ALL = [OrderActor.CUSTOMER, OrderActor.MERCHANT, OrderActor.SYSTEM, OrderActor.ADMIN];
const STAFF = [OrderActor.SYSTEM, OrderActor.ADMIN];
const STAFF_ONLY = [OrderActor.ADMIN];

/**
 * Single source of truth for the order lifecycle.
 *
 * Adding a status means editing exactly this table — nothing else in the
 * codebase is allowed to branch on order status for authorisation purposes.
 */
const TRANSITIONS: Readonly<Record<OrderStatus, readonly TransitionRule[]>> = {
  [OrderStatus.PENDING_PAYMENT]: [
    {
      // A shop that has not taken the cash yet may turn the order away without
      // waiting out the payment timeout — otherwise a pay-at-store order the
      // kitchen cannot make sits on the board until it expires, with no way for
      // the merchant to clear it.
      //
      // Guarded to `PAY_AT_STORE`, which is what makes this safe for the online
      // rail: a customer midway through 3-D Secure must not have the order
      // cancelled under them, because the capture webhook would then arrive at
      // a terminal order.
      //
      // Deliberately listed BEFORE the customer/staff rule below: `transition()`
      // takes the first rule that both matches `to` and admits the actor, and
      // only this rule admits a merchant.
      to: OrderStatus.CANCELLED,
      actors: [OrderActor.MERCHANT],
      guards: ['MANUAL_SETTLEMENT_ALLOWED'],
      sideEffects: [
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.PAID,
      // `SYSTEM` is the online rail's webhook. `MERCHANT` is the shop that just
      // took the cash — the guard below is what keeps that from becoming a
      // universal "mark any order paid" button.
      actors: [OrderActor.MERCHANT, ...STAFF],
      guards: ['MANUAL_SETTLEMENT_ALLOWED'],
      sideEffects: [
        OrderSideEffect.NOTIFY_MERCHANT_NEW_ORDER,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
        OrderSideEffect.SCHEDULE_MERCHANT_ACCEPT_TIMEOUT,
      ],
    },
    {
      to: OrderStatus.CANCELLED,
      actors: [OrderActor.CUSTOMER, ...STAFF],
      sideEffects: [
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.EXPIRED,
      actors: STAFF,
      sideEffects: [
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
      ],
    },
  ],

  [OrderStatus.PAID]: [
    {
      to: OrderStatus.ACCEPTED,
      actors: [OrderActor.MERCHANT, ...STAFF],
      guards: ['MERCHANT_ACCEPTING'],
      sideEffects: [
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
        OrderSideEffect.DISPATCH_RIDER,
      ],
    },
    {
      to: OrderStatus.REJECTED,
      actors: [OrderActor.MERCHANT, OrderActor.ADMIN],
      sideEffects: [
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
        OrderSideEffect.ISSUE_REFUND,
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.CANCELLED,
      actors: [OrderActor.CUSTOMER, ...STAFF],
      sideEffects: [
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
        OrderSideEffect.ISSUE_REFUND,
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.EXPIRED,
      actors: STAFF,
      guards: ['PAYMENT_CAPTURED'],
      sideEffects: [
        OrderSideEffect.CANCEL_MERCHANT_ACCEPT_TIMEOUT,
        OrderSideEffect.ISSUE_REFUND,
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.REFUNDED,
      actors: STAFF,
      guards: ['PAYMENT_CAPTURED'],
      sideEffects: [OrderSideEffect.RELEASE_DAILY_QUOTA, OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
  ],

  [OrderStatus.ACCEPTED]: [
    {
      to: OrderStatus.PREPARING,
      actors: [OrderActor.MERCHANT, OrderActor.ADMIN],
      sideEffects: [OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
    {
      to: OrderStatus.CANCELLED,
      actors: [OrderActor.CUSTOMER, OrderActor.MERCHANT, OrderActor.ADMIN],
      sideEffects: [
        OrderSideEffect.ISSUE_REFUND,
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.REFUNDED,
      actors: STAFF,
      guards: ['PAYMENT_CAPTURED'],
      sideEffects: [OrderSideEffect.RELEASE_DAILY_QUOTA, OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
  ],

  [OrderStatus.PREPARING]: [
    {
      to: OrderStatus.READY_FOR_PICKUP,
      actors: [OrderActor.MERCHANT, ...STAFF],
      sideEffects: [
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
        OrderSideEffect.START_PICKUP_WINDOW_TIMER,
      ],
    },
    {
      // The customer may no longer walk away: the kitchen has already committed
      // ingredients. Only the merchant or an admin can stop it now.
      to: OrderStatus.CANCELLED,
      actors: [OrderActor.MERCHANT, OrderActor.ADMIN],
      sideEffects: [
        OrderSideEffect.ISSUE_REFUND,
        OrderSideEffect.RELEASE_DAILY_QUOTA,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.REFUNDED,
      actors: STAFF,
      guards: ['PAYMENT_CAPTURED'],
      sideEffects: [OrderSideEffect.RELEASE_DAILY_QUOTA, OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
  ],

  [OrderStatus.READY_FOR_PICKUP]: [
    {
      to: OrderStatus.COMPLETED,
      actors: [OrderActor.MERCHANT, ...STAFF],
      sideEffects: [
        OrderSideEffect.RECORD_PAYOUT_LEDGER,
        OrderSideEffect.CONVERT_HOLD_TO_SOLD,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      // No-show. The merchant cooked it, so they still get paid — and the units
      // were consumed, so they convert rather than going back into the pool.
      to: OrderStatus.EXPIRED,
      actors: STAFF,
      sideEffects: [
        OrderSideEffect.RECORD_PAYOUT_LEDGER,
        OrderSideEffect.CONVERT_HOLD_TO_SOLD,
        OrderSideEffect.NOTIFY_CUSTOMER_STATUS,
      ],
    },
    {
      to: OrderStatus.REFUNDED,
      actors: STAFF_ONLY,
      guards: ['PAYMENT_CAPTURED'],
      sideEffects: [OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
  ],

  [OrderStatus.REJECTED]: [
    {
      to: OrderStatus.REFUNDED,
      actors: STAFF,
      sideEffects: [OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
  ],

  [OrderStatus.CANCELLED]: [
    {
      to: OrderStatus.REFUNDED,
      actors: STAFF,
      guards: ['PAYMENT_CAPTURED'],
      sideEffects: [OrderSideEffect.NOTIFY_CUSTOMER_STATUS],
    },
  ],

  [OrderStatus.COMPLETED]: [],
  [OrderStatus.EXPIRED]: [],
  [OrderStatus.REFUNDED]: [],
};

const GUARDS: Readonly<Record<OrderGuard, (ctx: OrderTransitionContext) => void>> = {
  MERCHANT_ACCEPTING: (ctx) => {
    // Support staff may force an acceptance while the merchant is paused —
    // e.g. they already took the order by phone.
    if (ctx.actor === OrderActor.ADMIN) return;
    if (ctx.merchantAcceptingOrders === false) {
      throw new MerchantNotAcceptingOrdersError(ctx.orderId);
    }
  },
  PAYMENT_CAPTURED: (ctx) => {
    // No actor may refund money that was never captured.
    if (!ctx.paidAmountMinor || ctx.paidAmountMinor <= 0) {
      throw new RefundWithoutPaymentError(ctx.orderId, ctx.from);
    }
  },
  MANUAL_SETTLEMENT_ALLOWED: (ctx) => {
    // A signed webhook IS the online rail settling the order. Gating it on the
    // payment mode would make every normal card payment un-advanceable.
    if (ctx.actor === OrderActor.SYSTEM) return;
    // An operator fixing an order that was keyed wrong is the escape hatch —
    // the same exemption `MERCHANT_ACCEPTING` grants, and it is recorded in
    // the audit trail with a mandatory reason.
    if (ctx.actor === OrderActor.ADMIN) return;
    if (ctx.paymentMode !== PaymentMode.PAY_AT_STORE) {
      throw new ManualSettlementNotAllowedError(ctx.orderId, String(ctx.paymentMode));
    }
  },
};

export interface OrderTransitionContext {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly actor: OrderActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly now?: Date;
  /** Merchant's current intake switch. `undefined` means "not evaluated". */
  readonly merchantAcceptingOrders?: boolean;
  /** Captured amount in minor units — required by refund guards. */
  readonly paidAmountMinor?: number;
  /**
   * How this order is meant to be paid. Required by
   * `MANUAL_SETTLEMENT_ALLOWED`; `undefined` is treated as "not evaluated",
   * which only the `SYSTEM` actor is allowed to get away with.
   */
  readonly paymentMode?: PaymentMode;
}

export interface OrderTransitionResult {
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly actor: OrderActor;
  readonly actorId?: string;
  readonly reason?: string;
  readonly occurredAt: Date;
  /** Ordered list of obligations the caller must discharge. */
  readonly sideEffects: readonly OrderSideEffect[];
}

/**
 * Pure order lifecycle machine. No persistence, no clock reads except through
 * the injected `Clock`, so every rule is deterministic under test.
 */
export class OrderStateMachine {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  /** Rules available from `status` (empty when terminal). */
  transitionsFrom(status: OrderStatus): readonly TransitionRule[] {
    return TRANSITIONS[status] ?? [];
  }

  /** Statuses reachable from `from` **by this actor** — drives merchant UI buttons. */
  allowedTransitions(from: OrderStatus, actor: OrderActor): OrderStatus[] {
    return this.transitionsFrom(from)
      .filter((rule) => rule.actors.includes(actor))
      .map((rule) => rule.to);
  }

  can(from: OrderStatus, to: OrderStatus, actor: OrderActor): boolean {
    return this.transitionsFrom(from).some(
      (rule) => rule.to === to && rule.actors.includes(actor),
    );
  }

  isTerminal(status: OrderStatus): boolean {
    return isTerminalStatus(status);
  }

  /**
   * Validate a transition and return the obligations it creates.
   * Throws a `DomainError` subclass on any violation — it never returns a
   * "not allowed" sentinel, so a caller cannot forget to check.
   */
  transition(context: OrderTransitionContext): OrderTransitionResult {
    const { orderId, from, to, actor } = context;

    if (isTerminalStatus(from)) {
      throw new OrderAlreadyTerminalError(from);
    }

    const rules = this.transitionsFrom(from);
    // Prefer the rule that actually admits this actor. One target status can be
    // reachable by different actors under different guards — a merchant may
    // cancel a pay-at-store order the customer never paid for, while the
    // customer may cancel their own unpaid order. Taking the first rule that
    // merely matched `to` would hand the caller the wrong guard, or refuse them
    // outright for a move the table does allow.
    const matching =
      rules.find((rule) => rule.to === to && rule.actors.includes(actor)) ??
      rules.find((rule) => rule.to === to);

    if (!matching) {
      throw new IllegalOrderTransitionError(
        from,
        to,
        actor,
        rules.map((rule) => rule.to),
      );
    }

    if (!matching.actors.includes(actor)) {
      throw new ActorNotPermittedError(from, to, actor, matching.actors);
    }

    for (const guard of matching.guards ?? []) {
      GUARDS[guard](context);
    }

    const result: OrderTransitionResult = {
      orderId,
      from,
      to,
      actor,
      actorId: context.actorId,
      reason: context.reason,
      occurredAt: context.now ?? this.clock.now(),
      sideEffects: matching.sideEffects,
    };
    return Object.freeze(result);
  }

  /** Non-throwing variant for optimistic checks in the UI layer. */
  tryTransition(context: OrderTransitionContext):
    | { ok: true; result: OrderTransitionResult }
    | { ok: false; error: Error } {
    try {
      return { ok: true, result: this.transition(context) };
    } catch (error) {
      return { ok: false, error: error as Error };
    }
  }
}
