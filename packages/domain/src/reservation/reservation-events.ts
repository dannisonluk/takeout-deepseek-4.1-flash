import { ReservationActor, ReservationStatus } from './reservation-status';

/**
 * Integration events for the reservation book, published through the same
 * transactional outbox as orders.
 *
 * Kept in its own file rather than folded into `order-events.ts`: a consumer
 * that handles `order.*` should not have to know that `reservation.*` exists,
 * and the two `aggregateType` values are what the relay partitions on.
 */
export enum ReservationEventType {
  RESERVATION_PLACED = 'reservation.placed',
  RESERVATION_CONFIRMED = 'reservation.confirmed',
  RESERVATION_SEATED = 'reservation.seated',
  RESERVATION_COMPLETED = 'reservation.completed',
  RESERVATION_DECLINED = 'reservation.declined',
  RESERVATION_CANCELLED = 'reservation.cancelled',
  RESERVATION_NO_SHOW = 'reservation.no_show',
}

/** Status -> event type. Keeps the mapping out of every consumer. */
export const RESERVATION_STATUS_EVENT: Readonly<Record<ReservationStatus, ReservationEventType>> = {
  [ReservationStatus.PENDING]: ReservationEventType.RESERVATION_PLACED,
  [ReservationStatus.CONFIRMED]: ReservationEventType.RESERVATION_CONFIRMED,
  [ReservationStatus.SEATED]: ReservationEventType.RESERVATION_SEATED,
  [ReservationStatus.COMPLETED]: ReservationEventType.RESERVATION_COMPLETED,
  [ReservationStatus.DECLINED]: ReservationEventType.RESERVATION_DECLINED,
  [ReservationStatus.CANCELLED]: ReservationEventType.RESERVATION_CANCELLED,
  [ReservationStatus.NO_SHOW]: ReservationEventType.RESERVATION_NO_SHOW,
};

/**
 * Denormalised projection embedded in every reservation event.
 *
 * Carries the name and the time the party is expected, because every consumer
 * that matters — the shop's board, the customer's notification — renders those
 * two strings and nothing else. Making them re-query the row for it would mean
 * a booking event that cannot be rendered on its own.
 */
export interface ReservationEventPayload {
  readonly reservationId: string;
  readonly reservationNo: string;
  readonly merchantId: string;
  readonly customerId: string;
  readonly status: ReservationStatus;
  readonly partySize: number;
  /** ISO-8601. */
  readonly startsAt: string;
  readonly serviceDate: string;
  readonly customerName: string;
  readonly contactPhone: string;
}

export interface ReservationDomainEvent {
  readonly eventId: string;
  readonly type: ReservationEventType;
  readonly aggregateType: 'Reservation';
  readonly aggregateId: string;
  readonly version: number;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  readonly payload: ReservationEventPayload;
}

/** Socket.IO room names — one room per reservation, one per merchant book. */
export const reservationRoom = (reservationId: string): string => `reservation:${reservationId}`;
export const merchantBookRoom = (merchantId: string): string => `merchant-book:${merchantId}`;

/** Re-exported so the API's event builder can name the actor without a deep import. */
export type { ReservationActor };
