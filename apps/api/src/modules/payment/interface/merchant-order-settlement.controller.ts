import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ORDER_REPOSITORY } from '../../../common/tokens';
import { MerchantNotFoundError } from '../../ordering/domain/ordering.errors';
import { OrderRepositoryPort } from '../../ordering/domain/order.repository.port';
import { ConfirmOrderDto } from '../../ordering/interface/dto/transition-order.dto';
import { ConfirmOrderUseCase, ConfirmOrderResult } from '../application/confirm-order.use-case';

/**
 * `POST /merchant/:merchantId/orders/:orderId/confirm` — 確認訂單.
 *
 * It lives in the payment module rather than beside the other kitchen actions
 * for the same reason `OrderPaymentController` does: the dependency only runs
 * one way (`PaymentModule` imports `OrderingModule`), and this action has to
 * write a `payments` row. Registering it in `OrderingModule` would close a
 * cycle or force the ordering context to write another context's table.
 *
 * The path stays under `/merchant/:merchantId/orders` because that is the
 * resource the merchant is acting on — the front end should not have to know
 * which module a button happens to live in.
 */
@Controller('merchant/:merchantId/orders')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantOrderSettlementController {
  constructor(
    private readonly confirmOrder: ConfirmOrderUseCase,
    @Inject(ORDER_REPOSITORY) private readonly orders: OrderRepositoryPort,
  ) {}

  /**
   * Take the money (for a pay-at-store order), take the order, and say when it
   * will be ready — one call, because that is one motion in a real shop.
   *
   * Also the correct endpoint for an **online-paid** order that the merchant is
   * simply accepting with a time: the settle step is skipped when the order is
   * already `PAID`, so the kitchen board has one primary button instead of two
   * that differ only by how the customer paid.
   */
  @Post(':orderId/confirm')
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: ConfirmOrderDto,
  ): Promise<ConfirmOrderResult> {
    const merchant = await this.orders.findMerchantForOrdering(merchantId);
    if (!merchant) throw new MerchantNotFoundError(merchantId);

    return this.confirmOrder.execute({
      merchantId,
      orderId,
      actorId: user.userId,
      ...(dto.readyInMinutes !== undefined ? { readyInMinutes: dto.readyInMinutes } : {}),
      ...(dto.note !== undefined ? { note: dto.note } : {}),
      merchantAcceptingOrders: merchant.acceptsOrders,
    });
  }
}
