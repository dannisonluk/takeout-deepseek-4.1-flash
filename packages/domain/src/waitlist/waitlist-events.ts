import { WaitlistActor, WaitlistStatus } from './waitlist-status';

/**
 * Integration events for queue tickets, published through the same
 * transactional outbox as orders, reservations and refund tickets.
 *
 * `aggregateType: 'WaitlistEntry'` is what the Socket.IO fan-out routes on.
 * The routing lesson from the reservation work applies here too: routing a
 * fan-out by "the id looks like a UUID" once put every reservation event into
 * `order:<reservationId>`, a room nobody can join. The aggregate type is the
 * only reliable key.
 */
export enum WaitlistEventType {
  WAITLIST_JOINED = 'waitlist.joined',
  WAITLIST_CALLED = 'waitlist.called',
  WAITLIST_SEATED = 'waitlist.seated',
  WAITLIST_NO_SHOW = 'waitlist.no_show',
  WAITLIST_CANCELLED = 'waitlist.cancelled',
}

/** Status -> event type. Keeps the mapping out of every consumer. */
export const WAITLIST_STATUS_EVENT: Readonly<Record<WaitlistStatus, WaitlistEventType>> = {
  [WaitlistStatus.WAITING]: WaitlistEventType.WAITLIST_JOINED,
  [WaitlistStatus.CALLED]: WaitlistEventType.WAITLIST_CALLED,
  [WaitlistStatus.SEATED]: WaitlistEventType.WAITLIST_SEATED,
  [WaitlistStatus.NO_SHOW]: WaitlistEventType.WAITLIST_NO_SHOW,
  [WaitlistStatus.CANCELLED]: WaitlistEventType.WAITLIST_CANCELLED,
};

/**
 * Denormalised projection embedded in every queue event.
 *
 * Carries the ticket number and the party size because the guest's phone
 * renders exactly those two things and the board renders them plus the name —
 * and a ticket event that cannot be rendered without re-querying the row is an
 * event that arrives before the row is visible to the reader.
 *
 * `notifyCustomer` and `recordNoShow` are carried because they are obligations
 * the state machine already derived in `sideEffects`. Re-deriving them in the
 * notification consumer is how a `SEATED` ends up ringing a guest who is
 * already sitting at the table.
 */
export interface WaitlistEventPayload {
  readonly waitlistEntryId: string;
  readonly merchantId: string;
  readonly ticketNo: string;
  /** Merchant-local `YYYY-MM-DD`. */
  readonly serviceDate: string;
  readonly status: WaitlistStatus;
  readonly partySize: number;
  readonly guestName: string;
  readonly contactPhone: string;
  /** The guest's phone should be pushed this move. */
  readonly notifyCustomer: boolean;
  /** This move counts against the guest's no-show record. */
  readonly recordNoShow: boolean;
  readonly reason?: string;
}

export interface WaitlistDomainEvent {
  readonly eventId: string;
  readonly type: WaitlistEventType;
  readonly aggregateType: 'WaitlistEntry';
  readonly aggregateId: string;
  readonly version: number;
  /** ISO-8601 UTC. */
  readonly occurredAt: string;
  readonly payload: WaitlistEventPayload;
}

/**
 * Socket.IO rooms.
 *
 * Three rooms per merchant, and the split is what keeps a busy Friday night
 * from fanning one shop's whole queue to every guest:
 *
 *   - `waitlist:<entryId>` — the one guest whose ticket this is.
 *   - `merchant-queue:<merchantId>` — the host board, which wants every move.
 *   - `merchant-queue-calls:<merchantId>` — a narrower room for call events
 *     only, so a page that shows nothing but "now serving" does not wake on
 *     every seating.
 */
export const waitlistEntryRoom = (waitlistEntryId: string): string =>
  `waitlist:${waitlistEntryId}`;
export const merchantQueueRoom = (merchantId: string): string =>
  `merchant-queue:${merchantId}`;
export const merchantQueueCallsRoom = (merchantId: string): string =>
  `merchant-queue-calls:${merchantId}`;

export type { WaitlistActor };
