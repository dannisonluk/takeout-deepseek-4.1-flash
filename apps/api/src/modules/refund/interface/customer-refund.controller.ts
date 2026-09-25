import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RefundRequestActor, RefundRequestStatus } from '@takeout/domain';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { FileRefundRequestUseCase } from '../application/file-refund-request.use-case';
import { RefundQueryService } from '../application/refund-query.service';
import { TransitionRefundRequestUseCase } from '../application/transition-refund-request.use-case';
import { CancelRefundRequestDto, FileRefundRequestDto } from './dto/refund.dto';
import {
  CustomerRefundPageView,
  CustomerRefundRequestView,
  CustomerRefundTransitionView,
  toCustomerRefundView,
} from './refund.view';

const PAGE_SIZE_CAP = 100;

/**
 * The customer's side of 退款申請.
 *
 * **What this controller deliberately does not do:** it never contacts a
 * payment provider, never writes `payments`, and never changes an order's
 * status. The platform is booking-only; a refund is a conversation the customer
 * opens here and the shop finishes with them directly.
 *
 * Filing is `POST /orders/:orderId/refund-request` rather than
 * `POST /refund-requests`, because the order is the thing being complained
 * about — and because the ownership check has an obvious home in the path.
 */
@Controller()
export class CustomerRefundController {
  constructor(
    private readonly fileRequest: FileRefundRequestUseCase,
    private readonly transitionRequest: TransitionRefundRequestUseCase,
    private readonly queries: RefundQueryService,
  ) {}

  @Post('orders/:orderId/refund-request')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  async file(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: FileRefundRequestDto,
  ): Promise<CustomerRefundRequestView> {
    const { refundRequest } = await this.fileRequest.execute({
      orderId,
      customerId: user.userId,
      reasonCode: dto.reasonCode,
      requestedAmountMinor: dto.requestedAmountMinor ?? null,
      note: dto.note ?? null,
    });

    return toCustomerRefundView(
      refundRequest,
      // A freshly-filed ticket is always OPEN, so the only move the customer
      // has is withdrawing it. Asking the machine rather than hardcoding keeps
      // the response honest if the table ever changes.
      [...this.queries.allowedFor(refundRequest.status, RefundRequestActor.CUSTOMER)],
    );
  }

  /** The customer's own tickets, newest first. */
  @Get('refund-requests')
  @UseGuards(JwtAuthGuard)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit = '20',
    @Query('offset') offset = '0',
  ): Promise<CustomerRefundPageView> {
    const take = Math.min(Number.parseInt(limit, 10) || 20, PAGE_SIZE_CAP);
    const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);

    const page = await this.queries.listForCustomer(user.userId, {
      limit: take,
      offset: skip,
    });

    return {
      data: page.data.map((projection) =>
        toCustomerRefundView(projection.refundRequest, projection.allowedNextTransitions),
      ),
      total: page.total,
    };
  }

  /**
   * One ticket.
   *
   * Somebody else's id answers **404**, not 403 — the same choice the order and
   * reservation endpoints make. A 403 confirms the id exists.
   */
  @Get('refund-requests/:refundRequestId')
  @UseGuards(JwtAuthGuard)
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('refundRequestId', new ParseUUIDPipe()) refundRequestId: string,
  ): Promise<CustomerRefundRequestView> {
    const projection = await this.queries.findOneFor(
      refundRequestId,
      RefundRequestActor.CUSTOMER,
    );

    if (projection.refundRequest.customerId !== user.userId) {
      throw new NotFoundException('Refund request not found');
    }

    return toCustomerRefundView(
      projection.refundRequest,
      projection.allowedNextTransitions,
    );
  }

  /**
   * The customer withdraws their own ticket.
   *
   * A dedicated endpoint rather than a generic `PATCH { status }`, and
   * deliberately not asking for a reason: withdrawing is not a negotiation, and
   * requiring an explanation would make people not do it. The DTO's note is
   * accepted so a client that sends one is not 400'd by
   * `forbidNonWhitelisted`.
   */
  @Post('refund-requests/:refundRequestId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('refundRequestId', new ParseUUIDPipe()) refundRequestId: string,
    @Body() _dto: CancelRefundRequestDto,
  ): Promise<CustomerRefundTransitionView> {
    const existing = await this.queries.findOneFor(
      refundRequestId,
      RefundRequestActor.CUSTOMER,
    );
    if (existing.refundRequest.customerId !== user.userId) {
      throw new NotFoundException('Refund request not found');
    }

    const result = await this.transitionRequest.execute({
      refundRequestId,
      to: RefundRequestStatus.CANCELLED,
      actor: RefundRequestActor.CUSTOMER,
      actorId: user.userId,
    });

    return {
      ...result,
      refundRequest: toCustomerRefundView(
        result.refundRequest,
        result.allowedNextTransitions,
      ),
    };
  }
}
