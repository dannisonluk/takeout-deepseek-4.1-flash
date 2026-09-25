import { DomainError } from '../shared/index';
import { OrderActor, OrderStatus } from './order-status';

export class IllegalOrderTransitionError extends DomainError {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly actor: OrderActor,
    readonly allowed: readonly OrderStatus[],
  ) {
    super(
      'ILLEGAL_ORDER_TRANSITION',
      `Cannot move order from ${from} to ${to}. Allowed from ${from}: ${
        allowed.length ? allowed.join(', ') : '(terminal state)'
      }`,
      { from, to, actor, allowed: [...allowed] },
    );
  }
}

export class ActorNotPermittedError extends DomainError {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
    readonly actor: OrderActor,
    readonly permittedActors: readonly OrderActor[],
  ) {
    super(
      'ACTOR_NOT_PERMITTED',
      `${actor} is not allowed to move an order from ${from} to ${to}`,
      { from, to, actor, permittedActors: [...permittedActors] },
    );
  }
}

export class OrderAlreadyTerminalError extends DomainError {
  constructor(readonly status: OrderStatus) {
    super('ORDER_ALREADY_TERMINAL', `Order is in terminal status ${status} and cannot change`, {
      status,
    });
  }
}

export class MerchantNotAcceptingOrdersError extends DomainError {
  constructor(readonly orderId: string) {
    super(
      'MERCHANT_NOT_ACCEPTING_ORDERS',
      'Merchant has paused intake and cannot accept this order',
      { orderId },
    );
  }
}

export class RefundWithoutPaymentError extends DomainError {
  constructor(readonly orderId: string, readonly status: OrderStatus) {
    super('REFUND_WITHOUT_PAYMENT', 'Cannot refund an order with no captured payment', {
      orderId,
      status,
    });
  }
}

/**
 * A merchant tried to settle an order that was placed to be paid online.
 *
 * Without this guard, "mark as paid" would be a way for a merchant to take an
 * order off the online rail's hands — the platform would never see a capture
 * for it, so the payout ledger would carry a payment that does not exist.
 * An admin is exempt: an operator fixing a mis-typed order has to be able to.
 */
export class ManualSettlementNotAllowedError extends DomainError {
  constructor(readonly orderId: string, readonly paymentMode: string) {
    super(
      'MANUAL_SETTLEMENT_NOT_ALLOWED',
      `Order was placed with paymentMode=${paymentMode}; only PAY_AT_STORE orders may be settled by hand`,
      { orderId, paymentMode },
    );
  }
}
