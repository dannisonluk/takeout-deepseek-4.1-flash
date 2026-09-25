import { CurrencyCode } from '../shared/index';
import { OrderStatus } from './order-status';

/**
 * Integration events published through the transactional outbox
 * (`OutboxEvent` table -> relay worker -> Redis Streams -> WebSocket fan-out).
 * Consumers are the merchant kitchen board, the customer tracker, the payout
 * ledger, and (phase 2) the dispatch engine.
 */
export enum OrderEventType {
  ORDER_PLACED = 'order.placed',
  ORDER_PAID = 'order.paid',
  ORDER_ACCEPTED = 'order.accepted',
  ORDER_REJECTED = 'order.rejected',
  ORDER_PREPARING = 'order.preparing',
  ORDER_READY_FOR_PICKUP = 'order.ready_for_pickup',
  ORDER_COMPLETED = 'order.completed',
  ORDER_CANCELLED = 'order.cancelled',
  ORDER_EXPIRED = 'order.expired',
  ORDER_REFUNDED = 'order.refunded',
}

/** Status -> event type. Keeps the mapping out of every consumer. */
export const ORDER_STATUS_EVENT: Readonly<Record<OrderStatus, OrderEventType>> = {
  [OrderStatus.PENDING_PAYMENT]: OrderEventType.ORDER_PLACED,
  [OrderStatus.PAID]: OrderEventType.ORDER_PAID,
  [OrderStatus.ACCEPTED]: OrderEventType.ORDER_ACCEPTED,
  [OrderStatus.PREPARING]: OrderEventType.ORDER_PREPARING,
  [OrderStatus.READY_FOR_PICKUP]: OrderEventType.ORDER_READY_FOR_PICKUP,
  [OrderStatus.COMPLETED]: OrderEventType.ORDER_COMPLETED,
  [OrderStatus.REJECTED]: OrderEventType.ORDER_REJECTED,
  [OrderStatus.CANCELLED]: OrderEventType.ORDER_CANCELLED,
  [OrderStatus.EXPIRED]: OrderEventType.ORDER_EXPIRED,
  [OrderStatus.REFUNDED]: OrderEventType.ORDER_REFUNDED,
};

export interface DomainEvent<TType extends string, TPayload> {
  readonly eventId: string;
  readonly type: TType;
  readonly aggregateType: 'Order';
  readonly aggregateId: string;
  /** Monotonic per aggregate — lets consumers detect out-of-order delivery. */
  readonly version: number;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Denormalised projection embedded in every order event. */
export interface OrderEventPayload {
  readonly orderId: string;
  readonly orderNo: string;
  readonly customerId: string;
  readonly merchantId: string;
  readonly status: OrderStatus;
  readonly currency: CurrencyCode;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly mainItemCount: number;
  /** ISO-8601; `null` for immediate orders. */
  readonly scheduledPickupAt: string | null;
  readonly itemSummary: readonly { menuItemId: string; name: string; quantity: number }[];
}

export type OrderDomainEvent = DomainEvent<OrderEventType, OrderEventPayload>;

/** Socket.IO room names — one room per order, one per merchant. */
export const orderRoom = (orderId: string): string => `order:${orderId}`;
export const merchantRoom = (merchantId: string): string => `merchant:${merchantId}`;
