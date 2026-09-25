import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OrderActor, OrderStatus, isActiveStatus } from '@takeout/domain';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { ConflictOnIdempotencyKey } from '../domain/ordering.errors';
import { PlaceOrderDto } from './dto/place-order.dto';
import { TransitionReasonDto } from './dto/transition-order.dto';
import { OrderCreatedView, CustomerOrderView } from './order.view';
import { PlaceOrderUseCase } from '../application/place-order.use-case';
import { TransitionOrderUseCase } from '../application/transition-order.use-case';
import { OrderQueryService, CancellationQuoteView } from '../application/order-query.service';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class CustomerOrderController {
  constructor(
    private readonly placeOrder: PlaceOrderUseCase,
    private readonly transitionOrder: TransitionOrderUseCase,
    private readonly queries: OrderQueryService,
    private readonly redis: RedisService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PlaceOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderCreatedView> {
    if (idempotencyKey) {
      // Two layers, and they are not the same kind of thing.
      //
      // Redis is the FAST PATH: it rejects a replay without touching the
      // database. `orders.idempotency_key` is the GUARANTEE: a UNIQUE index
      // that the insert itself cannot get past.
      //
      // So `null` (Redis could not answer) must fall through rather than
      // refuse. Treating "the lock is unavailable" as "the request is a
      // replay" turned a Redis outage into an outage of ordering itself —
      // every checkout returned 500 while the database was perfectly able to
      // tell the two requests apart.
      const acquired = await this.redis.tryAcquire(
        `idem:order:${user.userId}:${idempotencyKey}`,
        IDEMPOTENCY_TTL_SECONDS * 1000,
      );
      if (acquired === false) throw new ConflictOnIdempotencyKey(idempotencyKey);
    }

    const result = await this.placeOrder.execute({
      customerId: user.userId,
      merchantId: dto.merchantId,
      items: dto.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
      })),
      scheduledPickupAt: dto.scheduledPickupAt ? new Date(dto.scheduledPickupAt) : undefined,
      customerNote: dto.customerNote,
      contactPhone: dto.contactPhone,
      fulfilmentMode: dto.fulfilmentMode,
      paymentMode: dto.paymentMode,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    return {
      id: result.order.id,
      orderNo: result.order.orderNo,
      pickupCode: result.pickupCode,
      status: OrderStatus.PENDING_PAYMENT,
      paymentMode: result.paymentMode,
      scheduledPickupAt: result.order.scheduledPickupAt?.toISOString() ?? null,
      estimatedReadyAt: result.estimatedReadyAt.toISOString(),
      pickupNotice: result.pickupNotice,
      currency: result.pricing.currency,
      items: result.lines.map((line) => ({
        menuItemId: line.menuItemId,
        nameSnapshot: line.nameSnapshot,
        imageKeySnapshot: null,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        lineTotalMinor: line.lineTotalMinor,
        isMainItem: line.isMainItem,
      })),
      pricing: {
        mainItemCount: result.pricing.mainItemCount,
        subtotalMinor: result.pricing.subtotalMinor,
        platformFeeMinor: result.pricing.platformFeeMinor,
        paymentProcessingFeeMinor: result.pricing.paymentProcessingFeeMinor,
        customerServiceFeeMinor: result.pricing.customerServiceFeeMinor,
        totalMinor: result.pricing.totalMinor,
        merchantPayoutMinor: result.pricing.merchantPayoutMinor,
      },
    };
  }

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status: 'ACTIVE' | 'ALL' = 'ALL',
    @Query('limit') limit = '20',
    @Query('cursor') cursor?: string,
  ): Promise<{ data: CustomerOrderView[]; nextCursor: string | null; hasMore: boolean }> {
    const take = Math.min(Number.parseInt(limit, 10) || 20, 100);
    const statuses =
      status === 'ACTIVE'
        ? Object.values(OrderStatus).filter(isActiveStatus)
        : [];

    const rows = await this.queries.listForCustomer({
      customerId: user.userId,
      statuses,
      limit: take + 1,
      cursor,
    });

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    return {
      data,
      nextCursor: hasMore ? (data.at(-1)?.createdAt ?? null) : null,
      hasMore,
    };
  }

  @Get(':orderId')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<CustomerOrderView> {
    const order = await this.queries.getForCustomer(user.userId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * What the customer would get back if they cancelled right now.
   *
   * Separate from the cancel call on purpose: the UI needs the number *before*
   * the customer commits, and the write path must not be used as a dry run — a
   * `POST` that returns a figure without cancelling would be a lie waiting to
   * happen.
   */
  @Get(':orderId/cancellation-quote')
  async cancellationQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<CancellationQuoteView> {
    const quote = await this.queries.cancellationQuoteForCustomer(user.userId, orderId);
    if (!quote) throw new NotFoundException('Order not found');
    return quote;
  }

  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: TransitionReasonDto,
  ) {
    // The state machine rejects this with ACTOR_NOT_PERMITTED once the kitchen
    // has started — the controller does not duplicate that rule.
    return this.transitionOrder.execute({
      orderId,
      to: OrderStatus.CANCELLED,
      actor: OrderActor.CUSTOMER,
      actorId: user.userId,
      reason: dto.reason,
    });
  }
}
