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
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RefundQueryService } from '../application/refund-query.service';
import { TransitionRefundRequestUseCase } from '../application/transition-refund-request.use-case';
import { RefundQueueQueryDto, TransitionRefundRequestDto } from './dto/refund.dto';
import {
  MerchantRefundQueueView,
  MerchantRefundRequestView,
  RefundTransitionView,
  toMerchantRefundView,
} from './refund.view';

const PAGE_SIZE_CAP = 100;

/**
 * The shop's refund queue.
 *
 * Every status change funnels through `TransitionRefundRequestUseCase`, so these
 * endpoints cannot invent a transition the state machine would reject. The
 * response always carries `allowedNextTransitions` — the queue renders its
 * buttons from that list rather than hard-coding the lifecycle, which is what
 * stops a button appearing that the server will refuse.
 *
 * **Money does not pass through here.** `RESOLVED_OFFLINE` records what the shop
 * says it handed the customer; the platform does not verify it, does not process
 * it, and does not reflect it in `payments` or the payout ledger. A merchant
 * page that renders it as "refunded" is wrong — see `refund.view.ts`.
 */
@Controller('merchant/:merchantId/refund-requests')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantRefundController {
  constructor(
    private readonly transitionRequest: TransitionRefundRequestUseCase,
    private readonly queries: RefundQueryService,
  ) {}

  @Get()
  async list(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: RefundQueueQueryDto,
  ): Promise<MerchantRefundQueueView> {
    const limit = Math.min(query.limit ?? 50, PAGE_SIZE_CAP);
    const offset = Math.max(query.offset ?? 0, 0);

    const { page, counts } = await this.queries.listForMerchant(merchantId, {
      status: query.status ?? 'ACTIVE',
      limit,
      offset,
    });

    return {
      data: page.data.map((projection) =>
        toMerchantRefundView(projection.refundRequest, projection.allowedNextTransitions),
      ),
      total: page.total,
      counts,
    };
  }

  /**
   * One ticket.
   *
   * `MerchantScopeGuard` already proved the caller staffs `:merchantId`, but the
   * ticket carries its own `merchantId` — so it is checked again here. A guard
   * that protects the *path* cannot protect a *row*, and a ticket id from
   * another shop would otherwise be readable by editing the URL.
   */
  @Get(':refundRequestId')
  async get(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('refundRequestId', new ParseUUIDPipe()) refundRequestId: string,
  ): Promise<MerchantRefundRequestView> {
    const projection = await this.queries.findOneFor(
      refundRequestId,
      RefundRequestActor.MERCHANT,
    );
    if (projection.refundRequest.merchantId !== merchantId) {
      throw new NotFoundException('Refund request not found');
    }

    return toMerchantRefundView(
      projection.refundRequest,
      projection.allowedNextTransitions,
    );
  }

  /**
   * Move the ticket.
   *
   * One endpoint rather than four named ones (`/agree`, `/decline`, …) because
   * unlike the order and reservation flows, every move here carries the same
   * household of fields and the *machine* is what decides which combination is
   * legal. `RESOLVED_OFFLINE` without an amount or a reference is refused by the
   * state machine with `REFUND_SETTLEMENT_DETAILS_REQUIRED` (422) rather than
   * recorded as an empty claim.
   */
  @Post(':refundRequestId/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('refundRequestId', new ParseUUIDPipe()) refundRequestId: string,
    @Body() dto: TransitionRefundRequestDto,
  ): Promise<RefundTransitionView> {
    const projection = await this.queries.findOneFor(
      refundRequestId,
      RefundRequestActor.MERCHANT,
    );
    if (projection.refundRequest.merchantId !== merchantId) {
      throw new NotFoundException('Refund request not found');
    }

    const result = await this.transitionRequest.execute({
      refundRequestId,
      to: dto.to as RefundRequestStatus,
      actor: RefundRequestActor.MERCHANT,
      actorId: user.userId,
      ...(dto.merchantNote !== undefined ? { merchantNote: dto.merchantNote } : {}),
      ...(dto.settledAmountMinor !== undefined
        ? { settledAmountMinor: dto.settledAmountMinor }
        : {}),
      ...(dto.settlementReference !== undefined
        ? { settlementReference: dto.settlementReference }
        : {}),
    });

    return {
      ...result,
      refundRequest: toMerchantRefundView(
        result.refundRequest,
        result.allowedNextTransitions,
      ),
    };
  }
}
