import {
  Body,
  Controller,
  Get,
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
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ORDER_REPOSITORY } from '../../../common/tokens';
import { MerchantNotFoundError } from '../domain/ordering.errors';
import { OrderRepositoryPort } from '../domain/order.repository.port';
import { OrderQueryService } from '../application/order-query.service';
import { TransitionOrderUseCase } from '../application/transition-order.use-case';
import { ConfirmOrderDto, TransitionReasonDto } from './dto/transition-order.dto';
import { MerchantOrderView } from './order.view';

/**
 * Kitchen board.
 *
 * Every status change funnels through `TransitionOrderUseCase`, so the merchant
 * endpoints cannot invent a transition the state machine would reject. The
 * response always includes `allowedNextTransitions` — the front end renders
 * buttons from that list rather than hard-coding the lifecycle.
 */
@Controller('merchant/:merchantId/orders')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantOrderController {
  constructor(
    private readonly transitionOrder: TransitionOrderUseCase,
    private readonly queries: OrderQueryService,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
  ) {}

  @Get()
  async list(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query('status') status: 'ACTIVE' | 'ALL' = 'ACTIVE',
    @Query('limit') limit = '50',
    @Query('cursor') cursor?: string,
  ): Promise<{ data: MerchantOrderView[]; nextCursor: string | null; hasMore: boolean }> {
    const take = Math.min(Number.parseInt(limit, 10) || 50, 200);
    const statuses =
      status === 'ACTIVE' ? Object.values(OrderStatus).filter(isActiveStatus) : [];

    const rows = await this.queries.listForMerchant({
      merchantId,
      statuses,
      limit: take + 1,
      cursor,
      // A pay-at-store order sitting in `PENDING_PAYMENT` is not "active" by
      // the lifecycle's definition but is unambiguously work for the shop:
      // somebody is at the counter and the money has to be confirmed. It only
      // joins the *active* board — `ALL` already means "everything".
      includeAwaitingSettlement: status === 'ACTIVE',
    });

    const hasMore = rows.length > take;
    const data = hasMore ? rows.slice(0, take) : rows;
    return { data, nextCursor: null, hasMore };
  }

  @Get(':orderId')
  async get(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<MerchantOrderView> {
    const order = await this.queries.getForMerchant(merchantId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * PAID -> ACCEPTED. Blocked when the merchant has paused intake.
   *
   * Kept alongside `POST /confirm` because it is the *online* path — the money
   * is already captured, so there is nothing to settle and no payment row to
   * write. It now accepts the same optional pickup promise, so a merchant who
   * only wants to say "ready in 20 minutes" does not have to reach for the
   * endpoint that also touches payments.
   */
  @Post(':orderId/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: ConfirmOrderDto,
  ) {
    return this.transition(merchantId, orderId, OrderStatus.ACCEPTED, user, undefined, dto);
  }

  /** PAID -> REJECTED. The state machine's side effects trigger the refund. */
  @Post(':orderId/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: TransitionReasonDto,
  ) {
    return this.transition(merchantId, orderId, OrderStatus.REJECTED, user, dto.reason);
  }

  /**
   * ACCEPTED / PREPARING -> CANCELLED — the merchant stops an order they had
   * already taken.
   *
   * Distinct from `reject`, which only exists from `PAID`. Without this the
   * state machine permitted `ACCEPTED -> CANCELLED` for a merchant and no
   * endpoint exposed it, so a shop that ran out of an ingredient after
   * accepting had no way to release the order — the customer's money stayed
   * captured until an operator intervened.
   *
   * Always priced as a merchant fault, so the customer gets everything back
   * regardless of how long the order had been running.
   */
  @Post(':orderId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: TransitionReasonDto,
  ) {
    return this.transition(merchantId, orderId, OrderStatus.CANCELLED, user, dto.reason);
  }

  @Post(':orderId/start-preparing')
  @HttpCode(HttpStatus.OK)
  startPreparing(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.transition(merchantId, orderId, OrderStatus.PREPARING, user);
  }

  @Post(':orderId/mark-ready')
  @HttpCode(HttpStatus.OK)
  markReady(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.transition(merchantId, orderId, OrderStatus.READY_FOR_PICKUP, user);
  }

  /** Collection. Writes the payout ledger entry via the state machine. */
  @Post(':orderId/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ) {
    return this.transition(merchantId, orderId, OrderStatus.COMPLETED, user);
  }

  /**
   * Reads the merchant's intake switch so the `MERCHANT_ACCEPTING` guard has
   * something to check. `findMerchantForOrdering` returns `null` for a merchant
   * that is not ACTIVE, which is the correct answer here too.
   */
  private async transition(
    merchantId: string,
    orderId: string,
    to: OrderStatus,
    user: AuthenticatedUser,
    reason?: string,
    promise?: ConfirmOrderDto,
  ) {
    const merchant = await this.orders.findMerchantForOrdering(merchantId);
    if (!merchant) throw new MerchantNotFoundError(merchantId);

    return this.transitionOrder.execute({
      orderId,
      to,
      actor: OrderActor.MERCHANT,
      actorId: user.userId,
      reason,
      merchantAcceptingOrders: merchant.acceptsOrders,
      ...(promise?.readyInMinutes !== undefined
        ? { readyInMinutes: promise.readyInMinutes }
        : {}),
      ...(promise?.note !== undefined ? { merchantNote: promise.note } : {}),
    });
  }
}
