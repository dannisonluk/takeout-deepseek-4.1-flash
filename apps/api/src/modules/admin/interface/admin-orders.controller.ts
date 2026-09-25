import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { toActor } from '../../../common/auth/actor';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../../../common/auth/roles.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AdminOrdersService } from '../application/admin-orders.service';
import { AdminOrderQueryDto, AdminRefundDto, ForceTransitionDto } from './dto/admin.dto';
import { AdminOrderSummaryView, AdminOrderView } from './admin.views';
import type { ForceTransitionOutcome, RefundOutcome } from '../application/admin-orders.service';

/**
 * Order oversight.
 *
 * The write endpoints here are the platform's break-glass: they exist for the
 * support call where a merchant's phone is dead and a customer is standing at
 * the counter. Both require a reason, and both are audited.
 */
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  list(
    @Query() query: AdminOrderQueryDto,
  ): Promise<{ data: AdminOrderSummaryView[]; total: number }> {
    return this.orders.list(query);
  }

  @Get(':orderId')
  get(@Param('orderId', new ParseUUIDPipe()) orderId: string): Promise<AdminOrderView> {
    return this.orders.get(orderId);
  }

  /**
   * Move an order on someone else's behalf.
   *
   * 409 `ILLEGAL_ORDER_TRANSITION` when the state machine does not permit the
   * move — "force" means "as an admin", not "outside the rules".
   */
  @Post(':orderId/transition')
  @HttpCode(HttpStatus.OK)
  forceTransition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: ForceTransitionDto,
    @Req() request: Request,
  ): Promise<ForceTransitionOutcome> {
    return this.orders.forceTransition(orderId, dto, toActor(user, request));
  }

  /**
   * Refund a captured payment.
   *
   * The response carries `providerStatus` and a `notice`. When
   * `PAYMENT_LIVE_MODE=false` the refund is recorded as `PENDING` and the
   * provider is never called — the notice says so explicitly, because a console
   * that renders `PENDING` as "refunded" would be lying to an operator.
   */
  @Post(':orderId/refund')
  @HttpCode(HttpStatus.OK)
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: AdminRefundDto,
    @Req() request: Request,
  ): Promise<RefundOutcome> {
    return this.orders.refund(orderId, dto, toActor(user, request));
  }
}
