import { describe, expect, it } from 'vitest';
import {
  ActorNotPermittedError,
  FixedClock,
  IllegalOrderTransitionError,
  ManualSettlementNotAllowedError,
  MerchantNotAcceptingOrdersError,
  OrderActor,
  OrderAlreadyTerminalError,
  OrderSideEffect,
  OrderStateMachine,
  OrderStatus,
  PaymentMode,
  RefundWithoutPaymentError,
  isActiveStatus,
  isTerminalStatus,
} from '../src/index';

const AT = '2026-09-24T05:00:00.000Z';

const makeMachine = () => new OrderStateMachine(new FixedClock(AT));

const base = {
  orderId: 'ord_1',
  actorId: 'usr_1',
} as const;

describe('OrderStateMachine — happy path', () => {
  it('walks the full self-pickup lifecycle', () => {
    const machine = makeMachine();

    const steps: Array<[OrderStatus, OrderStatus, OrderActor]> = [
      [OrderStatus.PENDING_PAYMENT, OrderStatus.PAID, OrderActor.SYSTEM],
      [OrderStatus.PAID, OrderStatus.ACCEPTED, OrderActor.MERCHANT],
      [OrderStatus.ACCEPTED, OrderStatus.PREPARING, OrderActor.MERCHANT],
      [OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP, OrderActor.MERCHANT],
      [OrderStatus.READY_FOR_PICKUP, OrderStatus.COMPLETED, OrderActor.MERCHANT],
    ];

    for (const [from, to, actor] of steps) {
      const result = machine.transition({ ...base, from, to, actor });
      expect(result.from).toBe(from);
      expect(result.to).toBe(to);
      expect(result.occurredAt.toISOString()).toBe(AT);
    }
  });

  it('declares the side effects each transition obliges', () => {
    const machine = makeMachine();

    const paid = machine.transition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.SYSTEM,
    });
    expect(paid.sideEffects).toContain(OrderSideEffect.NOTIFY_MERCHANT_NEW_ORDER);
    expect(paid.sideEffects).toContain(OrderSideEffect.SCHEDULE_MERCHANT_ACCEPT_TIMEOUT);

    const ready = machine.transition({
      ...base,
      from: OrderStatus.PREPARING,
      to: OrderStatus.READY_FOR_PICKUP,
      actor: OrderActor.MERCHANT,
    });
    expect(ready.sideEffects).toContain(OrderSideEffect.START_PICKUP_WINDOW_TIMER);

    const completed = machine.transition({
      ...base,
      from: OrderStatus.READY_FOR_PICKUP,
      to: OrderStatus.COMPLETED,
      actor: OrderActor.MERCHANT,
    });
    // Collection is what triggers the merchant's money.
    expect(completed.sideEffects).toContain(OrderSideEffect.RECORD_PAYOUT_LEDGER);
  });

  it('consumes quota once the kitchen has produced the food, and only then', () => {
    const machine = makeMachine();

    // Collected: the units are sold, not returned to the pool.
    const completed = machine.transition({
      ...base,
      from: OrderStatus.READY_FOR_PICKUP,
      to: OrderStatus.COMPLETED,
      actor: OrderActor.MERCHANT,
    });
    expect(completed.sideEffects).toContain(OrderSideEffect.CONVERT_HOLD_TO_SOLD);
    expect(completed.sideEffects).not.toContain(OrderSideEffect.RELEASE_DAILY_QUOTA);

    // No-show: still consumed. The food was made and the merchant was paid, so
    // putting the units back would let the same dish be sold twice.
    const noShow = machine.transition({
      ...base,
      from: OrderStatus.READY_FOR_PICKUP,
      to: OrderStatus.EXPIRED,
      actor: OrderActor.SYSTEM,
    });
    expect(noShow.sideEffects).toContain(OrderSideEffect.CONVERT_HOLD_TO_SOLD);
    expect(noShow.sideEffects).not.toContain(OrderSideEffect.RELEASE_DAILY_QUOTA);
  });

  it('returns quota to the pool when nothing was produced', () => {
    const machine = makeMachine();

    // Cancelled before the kitchen committed: sellable again.
    const cancelled = machine.transition({
      ...base,
      from: OrderStatus.PAID,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.CUSTOMER,
    });
    expect(cancelled.sideEffects).toContain(OrderSideEffect.RELEASE_DAILY_QUOTA);
    expect(cancelled.sideEffects).not.toContain(OrderSideEffect.CONVERT_HOLD_TO_SOLD);

    // Unpaid expiry: nothing was ever made.
    const unpaid = machine.transition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.EXPIRED,
      actor: OrderActor.SYSTEM,
    });
    expect(unpaid.sideEffects).toContain(OrderSideEffect.RELEASE_DAILY_QUOTA);
    expect(unpaid.sideEffects).not.toContain(OrderSideEffect.CONVERT_HOLD_TO_SOLD);

    // A merchant cancelling after PREPARING is refunding the customer, so the
    // units are released — `sold` is a sales figure and this was not a sale.
    const pulledLate = machine.transition({
      ...base,
      from: OrderStatus.PREPARING,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.MERCHANT,
    });
    expect(pulledLate.sideEffects).toContain(OrderSideEffect.RELEASE_DAILY_QUOTA);
    expect(pulledLate.sideEffects).not.toContain(OrderSideEffect.CONVERT_HOLD_TO_SOLD);
  });

  it('routes accepted orders through the dispatch port, which is a no-op today', () => {
    const machine = makeMachine();
    const accepted = machine.transition({
      ...base,
      from: OrderStatus.PAID,
      to: OrderStatus.ACCEPTED,
      actor: OrderActor.MERCHANT,
    });
    expect(accepted.sideEffects).toContain(OrderSideEffect.DISPATCH_RIDER);
  });
});

describe('OrderStateMachine — authorisation', () => {
  const machine = makeMachine();

  it('does not let a customer accept their own order', () => {
    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PAID,
        to: OrderStatus.ACCEPTED,
        actor: OrderActor.CUSTOMER,
      }),
    ).toThrow(ActorNotPermittedError);
  });

  it('does not let a customer cancel once the kitchen has started', () => {
    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PREPARING,
        to: OrderStatus.CANCELLED,
        actor: OrderActor.CUSTOMER,
      }),
    ).toThrow(ActorNotPermittedError);

    // ...but the merchant still can.
    expect(
      machine.can(OrderStatus.PREPARING, OrderStatus.CANCELLED, OrderActor.MERCHANT),
    ).toBe(true);
  });

  it('lets a customer cancel before cooking starts', () => {
    expect(machine.can(OrderStatus.PAID, OrderStatus.CANCELLED, OrderActor.CUSTOMER)).toBe(true);
    expect(machine.can(OrderStatus.ACCEPTED, OrderStatus.CANCELLED, OrderActor.CUSTOMER)).toBe(true);
  });

  it('rejects transitions that are not in the table', () => {
    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PAID,
        to: OrderStatus.COMPLETED,
        actor: OrderActor.MERCHANT,
      }),
    ).toThrow(IllegalOrderTransitionError);
  });

  it('reports the allowed targets for a given actor — drives merchant UI buttons', () => {
    expect(machine.allowedTransitions(OrderStatus.PAID, OrderActor.MERCHANT)).toEqual([
      OrderStatus.ACCEPTED,
      OrderStatus.REJECTED,
    ]);
    expect(machine.allowedTransitions(OrderStatus.READY_FOR_PICKUP, OrderActor.MERCHANT)).toEqual([
      OrderStatus.COMPLETED,
    ]);
  });

  it('treats terminal statuses as closed', () => {
    for (const status of [
      OrderStatus.COMPLETED,
      OrderStatus.EXPIRED,
      OrderStatus.REFUNDED,
    ]) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(machine.transitionsFrom(status)).toHaveLength(0);
      expect(() =>
        machine.transition({ ...base, from: status, to: OrderStatus.CANCELLED, actor: OrderActor.ADMIN }),
      ).toThrow(OrderAlreadyTerminalError);
    }
  });

  it('keeps REJECTED non-terminal so the refund leg must run', () => {
    expect(isTerminalStatus(OrderStatus.REJECTED)).toBe(false);
    expect(machine.can(OrderStatus.REJECTED, OrderStatus.REFUNDED, OrderActor.SYSTEM)).toBe(true);
  });

  it('marks kitchen-board statuses as active', () => {
    expect(isActiveStatus(OrderStatus.PREPARING)).toBe(true);
    expect(isActiveStatus(OrderStatus.PENDING_PAYMENT)).toBe(false);
    expect(isActiveStatus(OrderStatus.COMPLETED)).toBe(false);
  });
});

describe('OrderStateMachine — guards', () => {
  const machine = makeMachine();

  it('refuses to accept on behalf of a merchant who paused intake', () => {
    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PAID,
        to: OrderStatus.ACCEPTED,
        actor: OrderActor.MERCHANT,
        merchantAcceptingOrders: false,
      }),
    ).toThrow(MerchantNotAcceptingOrdersError);

    // An admin override is still allowed.
    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PAID,
        to: OrderStatus.ACCEPTED,
        actor: OrderActor.ADMIN,
        merchantAcceptingOrders: false,
      }),
    ).not.toThrow();
  });

  it('refuses to refund money that was never captured', () => {
    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PAID,
        to: OrderStatus.REFUNDED,
        actor: OrderActor.SYSTEM,
      }),
    ).toThrow(RefundWithoutPaymentError);

    expect(() =>
      machine.transition({
        ...base,
        from: OrderStatus.PAID,
        to: OrderStatus.REFUNDED,
        actor: OrderActor.SYSTEM,
        paidAmountMinor: 5800,
      }),
    ).not.toThrow();
  });
});

describe('OrderStateMachine — non-throwing probe', () => {
  const machine = makeMachine();

  it('returns a discriminated result instead of throwing', () => {
    const ok = machine.tryTransition({
      ...base,
      from: OrderStatus.PAID,
      to: OrderStatus.ACCEPTED,
      actor: OrderActor.MERCHANT,
    });
    expect(ok.ok).toBe(true);

    const bad = machine.tryTransition({
      ...base,
      from: OrderStatus.COMPLETED,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.ADMIN,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBeInstanceOf(OrderAlreadyTerminalError);
  });

  it('carries the actor, reason and timestamp for the audit trail', () => {
    const result = machine.transition({
      orderId: 'ord_9',
      from: OrderStatus.PAID,
      to: OrderStatus.REJECTED,
      actor: OrderActor.MERCHANT,
      actorId: 'usr_chef',
      reason: '食材售罄',
    });

    expect(result).toMatchObject({
      orderId: 'ord_9',
      actor: OrderActor.MERCHANT,
      actorId: 'usr_chef',
      reason: '食材售罄',
    });
    expect(Object.isFrozen(result)).toBe(true);
  });
});

/**
 * `PENDING_PAYMENT -> PAID` has two very different drivers: a signed webhook
 * (the online rail settled it) and the merchant at the counter (they took the
 * cash). The guard is what stops the second one from becoming a universal
 * "mark anything paid" button — an online order that a merchant settles by
 * hand would leave the platform with a payout obligation and no capture.
 */
describe('OrderStateMachine — manual settlement of a pay-at-store order', () => {
  it('lets the merchant settle a PAY_AT_STORE order and start the accept clock', () => {
    const machine = makeMachine();

    const paid = machine.transition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.MERCHANT,
      paymentMode: PaymentMode.PAY_AT_STORE,
    });

    expect(paid.to).toBe(OrderStatus.PAID);
    expect(paid.sideEffects).toContain(OrderSideEffect.NOTIFY_MERCHANT_NEW_ORDER);
    expect(paid.sideEffects).toContain(OrderSideEffect.SCHEDULE_MERCHANT_ACCEPT_TIMEOUT);
  });

  it('refuses a merchant settling an ONLINE order', () => {
    const machine = makeMachine();

    const attempt = machine.tryTransition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.MERCHANT,
      paymentMode: PaymentMode.ONLINE,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ManualSettlementNotAllowedError);
  });

  it('refuses a merchant settling an order whose payment mode was not supplied', () => {
    const machine = makeMachine();

    // `undefined` must not be treated as "allow" — the guard is a whitelist,
    // and a caller that forgot to pass the field is exactly the caller most
    // likely to be doing something wrong.
    const attempt = machine.tryTransition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.MERCHANT,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ManualSettlementNotAllowedError);
  });

  it('still lets the payment webhook advance an ONLINE order', () => {
    const machine = makeMachine();

    const paid = machine.transition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.SYSTEM,
      paymentMode: PaymentMode.ONLINE,
    });

    expect(paid.to).toBe(OrderStatus.PAID);
  });

  it('lets an operator correct a mis-keyed order, and records who did it', () => {
    const machine = makeMachine();

    const paid = machine.transition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.ADMIN,
      actorId: 'usr_support',
      reason: '顧客以 FPS 付款，但結帳時選了線上付款',
      paymentMode: PaymentMode.ONLINE,
    });

    expect(paid.to).toBe(OrderStatus.PAID);
    expect(paid.actorId).toBe('usr_support');
  });

  it('never lets the customer settle their own order', () => {
    const machine = makeMachine();

    const attempt = machine.tryTransition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.PAID,
      actor: OrderActor.CUSTOMER,
      paymentMode: PaymentMode.PAY_AT_STORE,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ActorNotPermittedError);
  });

  it('offers the merchant 確認收款 as an available move on an unpaid order', () => {
    const machine = makeMachine();
    expect(machine.allowedTransitions(OrderStatus.PENDING_PAYMENT, OrderActor.MERCHANT)).toContain(
      OrderStatus.PAID,
    );
    expect(
      machine.allowedTransitions(OrderStatus.PENDING_PAYMENT, OrderActor.CUSTOMER),
    ).not.toContain(OrderStatus.PAID);
  });
});

/**
 * The other half of manual settlement: turning the order away.
 *
 * Without this rule a pay-at-store order the kitchen cannot make had no exit at
 * all — the merchant could neither settle it nor decline it, so it sat on the
 * board until the payment timeout expired it.
 */
describe('OrderStateMachine — declining an unpaid pay-at-store order', () => {
  it('lets the merchant cancel an order whose cash they never took', () => {
    const machine = makeMachine();

    const cancelled = machine.transition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.MERCHANT,
      paymentMode: PaymentMode.PAY_AT_STORE,
      reason: '今日食材售罄',
    });

    expect(cancelled.to).toBe(OrderStatus.CANCELLED);
    expect(cancelled.sideEffects).toContain(OrderSideEffect.RELEASE_DAILY_QUOTA);
    // Nothing was ever captured, so a refund leg here would be asking the PSP
    // to return money it never received.
    expect(cancelled.sideEffects).not.toContain(OrderSideEffect.ISSUE_REFUND);
  });

  it('refuses the same move on an online order — the customer may be mid-payment', () => {
    const machine = makeMachine();

    const attempt = machine.tryTransition({
      ...base,
      from: OrderStatus.PENDING_PAYMENT,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.MERCHANT,
      paymentMode: PaymentMode.ONLINE,
    });

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error).toBeInstanceOf(ManualSettlementNotAllowedError);
  });

  it('still lets the customer cancel their own unpaid order under either mode', () => {
    const machine = makeMachine();

    for (const paymentMode of [PaymentMode.ONLINE, PaymentMode.PAY_AT_STORE]) {
      const cancelled = machine.transition({
        ...base,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.CANCELLED,
        actor: OrderActor.CUSTOMER,
        paymentMode,
      });
      expect(cancelled.to).toBe(OrderStatus.CANCELLED);
    }
  });

  it('advertises both 確認收款 and 無法接單 to the merchant on the unpaid board', () => {
    const machine = makeMachine();
    const moves = machine.allowedTransitions(OrderStatus.PENDING_PAYMENT, OrderActor.MERCHANT);

    expect(moves).toContain(OrderStatus.PAID);
    expect(moves).toContain(OrderStatus.CANCELLED);
    // Once only — two rules reach CANCELLED, and the board must not draw two
    // buttons for the same move.
    expect(moves.filter((status) => status === OrderStatus.CANCELLED)).toHaveLength(1);
  });
});
