import { Inject, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  OrderDomainEvent,
  RefundRequestDomainEvent,
  ReservationDomainEvent,
  merchantBookRoom,
  merchantRefundQueueRoom,
  merchantRoom,
  orderRoom,
  refundRequestRoom,
  reservationRoom,
} from '@takeout/domain';
import { Server, Socket } from 'socket.io';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { verifyAccessToken } from '../../common/auth/verify-access-token';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { OutboxRelayService } from '../../infrastructure/outbox/outbox-relay.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../infrastructure/redis/redis.service';

interface SocketWithUser extends Socket {
  data: { user?: AuthenticatedUser };
}

/**
 * Real-time fan-out.
 *
 * The gateway is a *subscriber*, not a producer: it consumes the Redis channel
 * the outbox relay publishes to. That means an event survives an API restart
 * (it is already in the outbox), and N API instances all deliver to their own
 * connected clients without coordinating.
 *
 * Rooms:
 *   `merchant:{id}`      — kitchen board + reservations board, joined
 *                          automatically for merchant staff
 *   `order:{id}`         — customer order tracker, joined after an ownership check
 *   `reservation:{id}`   — customer booking tracker, joined after an ownership check
 */
@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
})
export class OrderGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(OrderGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Deliberately NOT `async` and NOT awaited.
   *
   * `app.listen()` waits for every `onModuleInit` hook to settle, so awaiting a
   * SUBSCRIBE against an unreachable Redis would leave the HTTP server unbound
   * forever — the whole API would be down because a cache was missing. Realtime
   * fan-out is a capability, not a boot requirement: without it clients fall
   * back to polling `GET /v1/orders/:orderId`.
   */
  onModuleInit(): void {
    const subscriber = this.redis.subscriberClient;
    subscriber.on('message', (_channel: string, message: string) => this.fanOut(message));
    void this.subscribe(subscriber);

    // ioredis re-subscribes automatically after a reconnect, but only for
    // channels that were subscribed successfully at least once. Retrying on
    // `ready` covers a Redis that was down when the process started.
    subscriber.on('ready', () => void this.subscribe(subscriber));
  }

  private async subscribe(subscriber: RedisService['subscriberClient']): Promise<void> {
    try {
      await subscriber.subscribe(OutboxRelayService.CHANNEL);
      this.logger.log(`Subscribed to ${OutboxRelayService.CHANNEL}`);
    } catch (error) {
      this.logger.warn(
        `Realtime fan-out unavailable (${(error as Error).message}). Orders still work; ` +
          `clients fall back to polling GET /v1/orders/:orderId.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.subscriberClient.unsubscribe(OutboxRelayService.CHANNEL).catch(() => undefined);
  }

  handleConnection(client: SocketWithUser): void {
    const raw =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.query?.token as string | undefined);

    if (!raw) {
      client.disconnect(true);
      return;
    }

    try {
      const claims = verifyAccessToken(raw, this.config.jwt.secret);
      const user: AuthenticatedUser = {
        userId: claims.sub,
        role: claims.role,
        merchantIds: claims.merchantIds ?? [],
      };
      client.data.user = user;

      // Merchant staff get their board rooms immediately.
      for (const merchantId of user.merchantIds) {
        void client.join(merchantRoom(merchantId));
      }
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(client: SocketWithUser): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /**
   * Join an order room. Ownership is checked here rather than trusted from the
   * client — otherwise any authenticated user could track any order.
   */
  @SubscribeMessage('subscribe:order')
  async subscribeToOrder(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() body: { orderId?: string },
  ): Promise<{ ok: boolean; room?: string }> {
    const user = client.data.user;
    const orderId = body?.orderId;
    if (!user || !orderId) return { ok: false };

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { customerId: true, merchantId: true },
    });
    if (!order) return { ok: false };

    const isOwner = order.customerId === user.userId;
    const isMerchantStaff = user.merchantIds.includes(order.merchantId);
    if (!isOwner && !isMerchantStaff) return { ok: false };

    const room = orderRoom(orderId);
    await client.join(room);
    return { ok: true, room };
  }

  /**
   * Join a booking room. Same ownership check as `subscribe:order`, and for the
   * same reason — the client sends an id, so the server must decide whether that
   * id is theirs rather than trusting the join.
   *
   * Merchant staff are deliberately **not** admitted here: they already receive
   * every booking through `merchant:{id}` from `handleConnection`, and a
   * customer's `contactPhone` and note do not belong in a per-booking room a
   * staff account can enumerate.
   */
  @SubscribeMessage('subscribe:reservation')
  async subscribeToReservation(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() body: { reservationId?: string },
  ): Promise<{ ok: boolean; room?: string }> {
    const user = client.data.user;
    const reservationId = body?.reservationId;
    if (!user || !reservationId) return { ok: false };

    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { customerId: true },
    });
    if (!reservation || reservation.customerId !== user.userId) return { ok: false };

    const room = reservationRoom(reservationId);
    await client.join(room);
    return { ok: true, room };
  }

  /**
   * Join a refund ticket room. Same ownership check as the other two, and the
   * same reason: the client sends an id, so the server decides whether that id
   * is theirs rather than trusting the join.
   *
   * Only the customer who filed it. The shop already gets every ticket through
   * `merchant:{id}`, and a ticket's note can be a complaint about a specific
   * staff member or a person's circumstances — not something to put in a room a
   * staff account could enumerate.
   */
  @SubscribeMessage('subscribe:refund_request')
  async subscribeToRefundRequest(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() body: { refundRequestId?: string },
  ): Promise<{ ok: boolean; room?: string }> {
    const user = client.data.user;
    const refundRequestId = body?.refundRequestId;
    if (!user || !refundRequestId) return { ok: false };

    const ticket = await this.prisma.refundRequest.findUnique({
      where: { id: refundRequestId },
      select: { customerId: true },
    });
    if (!ticket || ticket.customerId !== user.userId) return { ok: false };

    const room = refundRequestRoom(refundRequestId);
    await client.join(room);
    return { ok: true, room };
  }

  private fanOut(message: string): void {
    let event: OrderDomainEvent | ReservationDomainEvent | RefundRequestDomainEvent;
    try {
      event = JSON.parse(message) as
        | OrderDomainEvent
        | ReservationDomainEvent
        | RefundRequestDomainEvent;
    } catch {
      this.logger.warn('Discarded malformed outbox message');
      return;
    }

    const room = aggregateRoom(event);
    if (!room) {
      // Loud, not silent. A new aggregate type that nobody routed is a bug in
      // the fan-out, and a warning in the log is the only place it can be seen —
      // the event itself was delivered to the outbox perfectly well.
      this.logger.warn(`No Socket.IO room for aggregateType="${event.aggregateType}"`);
      return;
    }
    this.server.to(room).emit(event.type, event);

    /**
     * Merchant staff join `merchant:{id}` on connect, so every event that
     * carries a merchant id reaches the shop's board — that is what drives the
     * reservations and refund pages' live lists.
     *
     * NOTE: per-aggregate rooms are genuinely separate (`reservation:{id}` vs
     * `order:{id}`), because an aggregate id is only meaningful inside its own
     * table. Routing everything through one room name was a real bug: the
     * booking events went to `order:<reservationId>` — a room no client can
     * join, since `subscribe:order` looks the id up in `orders`.
     */
    const merchantId = event.payload?.merchantId;
    if (merchantId) {
      this.server.to(merchantRoom(merchantId)).emit(event.type, event);
    }
  }
}

/**
 * Which room an event belongs in, by `aggregateType`.
 *
 * Returns `null` rather than defaulting to `orderRoom`. The old `=== 'Reservation'
 * ? ... : orderRoom(...)` shape is how a fourth aggregate type ends up quietly
 * announcing itself into `order:<someOtherId>`; an explicit `null` makes the
 * omission report itself in the log instead.
 */
function aggregateRoom(
  event: OrderDomainEvent | ReservationDomainEvent | RefundRequestDomainEvent,
): string | null {
  switch (event.aggregateType) {
    case 'Order':
      return orderRoom(event.aggregateId);
    case 'Reservation':
      return reservationRoom(event.aggregateId);
    case 'RefundRequest':
      return refundRequestRoom(event.aggregateId);
    default:
      return null;
  }
}
