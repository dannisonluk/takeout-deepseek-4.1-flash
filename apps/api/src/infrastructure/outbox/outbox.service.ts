import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  OrderDomainEvent,
  OrderEventPayload,
  OrderEventType,
  OrderStatus,
  ORDER_STATUS_EVENT,
  IdGenerator,
  RefundReasonCode,
  RefundRequestDomainEvent,
  RefundRequestEventPayload,
  RefundRequestEventType,
  RefundRequestStatus,
  REFUND_STATUS_EVENT,
  ReservationActor,
  ReservationDomainEvent,
  ReservationEventPayload,
  ReservationEventType,
  ReservationStatus,
  RESERVATION_STATUS_EVENT,
  WaitlistActor,
  WaitlistDomainEvent,
  WaitlistEventPayload,
  WaitlistEventType,
  WaitlistStatus,
  WAITLIST_STATUS_EVENT,
} from '@takeout/domain';

/**
 * Transactional outbox writer.
 *
 * Every call MUST pass the same `Prisma.TransactionClient` as the state change
 * it describes. That is what makes "order updated but the notification was
 * lost" structurally impossible: either both rows commit or neither does.
 */
@Injectable()
export class OutboxService {
  /**
   * Build the integration event for a status change.
   *
   * The payload is denormalised on purpose — consumers (kitchen board, tracker,
   * payout ledger) should not have to re-query the order to render a card.
   */
  buildOrderEvent(params: {
    idGenerator: IdGenerator;
    order: {
      id: string;
      orderNo: string;
      customerId: string;
      merchantId: string;
      status: OrderStatus;
      currency: string;
      totalMinor: number;
      merchantPayoutMinor: number;
      mainItemCount: number;
      scheduledPickupAt: Date | null;
    };
    items: readonly { menuItemId: string | null; nameSnapshot: string; quantity: number }[];
    version: number;
    occurredAt: Date;
  }): OrderDomainEvent {
    const { order, items, version, occurredAt } = params;

    const payload: OrderEventPayload = {
      orderId: order.id,
      orderNo: order.orderNo,
      customerId: order.customerId,
      merchantId: order.merchantId,
      status: order.status,
      currency: order.currency as OrderEventPayload['currency'],
      totalMinor: order.totalMinor,
      merchantPayoutMinor: order.merchantPayoutMinor,
      mainItemCount: order.mainItemCount,
      scheduledPickupAt: order.scheduledPickupAt?.toISOString() ?? null,
      itemSummary: items.map((item) => ({
        menuItemId: item.menuItemId ?? '',
        name: item.nameSnapshot,
        quantity: item.quantity,
      })),
    };

    return {
      eventId: params.idGenerator.next(),
      type: ORDER_STATUS_EVENT[order.status] as OrderEventType,
      aggregateType: 'Order',
      aggregateId: order.id,
      version,
      occurredAt: occurredAt.toISOString(),
      payload,
    };
  }

  /**
   * Build the integration event for a reservation status change.
   *
   * `version` is the reservation's own `version` column (bumped on every
   * transition) rather than a count of audit rows: a booking's audit table is
   * append-only per transition too, but the reservation row already carries the
   * counter and it is written on the same `UPDATE` as the status, so the two
   * can never disagree.
   */
  buildReservationEvent(params: {
    idGenerator: IdGenerator;
    reservation: {
      id: string;
      reservationNo: string;
      merchantId: string;
      customerId: string;
      status: ReservationStatus;
      partySize: number;
      startsAt: Date;
      serviceDate: Date;
      customerName: string;
      contactPhone: string;
      version: number;
    };
    actor: ReservationActor;
    occurredAt: Date;
  }): ReservationDomainEvent {
    const { reservation } = params;

    const payload: ReservationEventPayload = {
      reservationId: reservation.id,
      reservationNo: reservation.reservationNo,
      merchantId: reservation.merchantId,
      customerId: reservation.customerId,
      status: reservation.status,
      partySize: reservation.partySize,
      startsAt: reservation.startsAt.toISOString(),
      serviceDate: reservation.serviceDate.toISOString().slice(0, 10),
      customerName: reservation.customerName,
      contactPhone: reservation.contactPhone,
    };

    return {
      eventId: params.idGenerator.next(),
      type: RESERVATION_STATUS_EVENT[reservation.status] as ReservationEventType,
      aggregateType: 'Reservation',
      aggregateId: reservation.id,
      version: reservation.version,
      occurredAt: params.occurredAt.toISOString(),
      payload,
    };
  }

  /**
   * Build the integration event for a refund ticket status change.
   *
   * `aggregateType` is `'RefundRequest'`, which is what the Socket.IO fan-out
   * routes on. That matters here for the same reason it did for reservations:
   * routing by "the id looks like a UUID" once put every reservation event into
   * `order:<reservationId>`, a room nobody can join.
   */
  buildRefundRequestEvent(params: {
    idGenerator: IdGenerator;
    refundRequest: {
      id: string;
      orderId: string;
      orderNo: string;
      merchantId: string;
      customerId: string;
      status: RefundRequestStatus;
      reasonCode: RefundReasonCode;
      requestedAmountMinor: number | null;
      version: number;
    };
    occurredAt: Date;
  }): RefundRequestDomainEvent {
    const { refundRequest } = params;

    const payload: RefundRequestEventPayload = {
      refundRequestId: refundRequest.id,
      orderId: refundRequest.orderId,
      orderNo: refundRequest.orderNo,
      merchantId: refundRequest.merchantId,
      customerId: refundRequest.customerId,
      status: refundRequest.status,
      reasonCode: refundRequest.reasonCode,
      requestedAmountMinor: refundRequest.requestedAmountMinor,
    };

    return {
      eventId: params.idGenerator.next(),
      type: REFUND_STATUS_EVENT[refundRequest.status] as RefundRequestEventType,
      aggregateType: 'RefundRequest',
      aggregateId: refundRequest.id,
      version: refundRequest.version,
      occurredAt: params.occurredAt.toISOString(),
      payload,
    };
  }

  /**
   * Build the integration event for a queue ticket change.
   *
   * The two boolean obligation flags are carried on the payload rather than
   * re-derived by the consumer. `notifyCustomer` decides whether the guest's
   * phone wakes for this move, and `recordNoShow` whether it counts against
   * them — both were already decided by the state machine in `sideEffects`, and
   * a consumer that recomputes them is a second implementation of the rule.
   */
  buildWaitlistEvent(params: {
    idGenerator: IdGenerator;
    entry: {
      id: string;
      merchantId: string;
      ticketNo: string;
      serviceDate: Date;
      status: WaitlistStatus;
      partySize: number;
      guestName: string;
      contactPhone: string;
      statusReason: string | null;
      version: number;
    };
    actor: WaitlistActor;
    occurredAt: Date;
    /** From `WaitlistSideEffect.NOTIFY_CUSTOMER`. */
    notifyCustomer: boolean;
    /** From `WaitlistSideEffect.RECORD_NO_SHOW`. */
    recordNoShow: boolean;
  }): WaitlistDomainEvent {
    const { entry } = params;

    const payload: WaitlistEventPayload = {
      waitlistEntryId: entry.id,
      merchantId: entry.merchantId,
      ticketNo: entry.ticketNo,
      serviceDate: entry.serviceDate.toISOString().slice(0, 10),
      status: entry.status,
      partySize: entry.partySize,
      guestName: entry.guestName,
      contactPhone: entry.contactPhone,
      notifyCustomer: params.notifyCustomer,
      recordNoShow: params.recordNoShow,
      ...(entry.statusReason ? { reason: entry.statusReason } : {}),
    };

    return {
      eventId: params.idGenerator.next(),
      type: WAITLIST_STATUS_EVENT[entry.status] as WaitlistEventType,
      aggregateType: 'WaitlistEntry',
      aggregateId: entry.id,
      version: entry.version,
      occurredAt: params.occurredAt.toISOString(),
      payload,
    };
  }

  /** Append to the outbox. Must be called inside the caller's transaction. */
  async enqueue(
    tx: Prisma.TransactionClient,
    event:
      | OrderDomainEvent
      | ReservationDomainEvent
      | RefundRequestDomainEvent
      | WaitlistDomainEvent,
  ): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.type,
        payload: event.payload as unknown as Prisma.InputJsonValue,
        version: event.version,
      },
    });
  }
}
