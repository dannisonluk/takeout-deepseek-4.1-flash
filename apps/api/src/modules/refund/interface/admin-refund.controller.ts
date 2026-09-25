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
  UseGuards,
} from '@nestjs/common';
import { RefundRequestActor, RefundRequestStatus } from '@takeout/domain';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../../../common/auth/roles.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { RefundQueryService } from '../application/refund-query.service';
import { TransitionRefundRequestUseCase } from '../application/transition-refund-request.use-case';
import { AdminRefundQueryDto, TransitionRefundRequestDto } from './dto/refund.dto';
import { AdminRefundPageView, RefundTransitionView, toMerchantRefundView } from './refund.view';

const PAGE_SIZE_CAP = 100;

/**
 * The platform's view of refund tickets.
 *
 * Read-only by default and by intent: the platform is not a party to this
 * conversation, so its console exists to let support answer "what happened with
 * order X" without logging into a shop's account.
 *
 * The one write it does offer is `transition`, and only for the cases support
 * genuinely has to unblock — a shop that has closed, gone silent, or is plainly
 * not going to answer. It is the *same* state machine and the *same* use case as
 * the shop's endpoint, so an admin cannot reach a state a shop could not, and
 * the audit trail records `ADMIN` as the actor.
 */
@Controller('admin/refund-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminRefundController {
  constructor(
    private readonly transitionRequest: TransitionRefundRequestUseCase,
    private readonly queries: RefundQueryService,
  ) {}

  @Get()
  async list(@Query() query: AdminRefundQueryDto): Promise<AdminRefundPageView> {
    const limit = Math.min(query.limit ?? 50, PAGE_SIZE_CAP);
    const offset = Math.max(query.offset ?? 0, 0);

    const page = await this.queries.listAll({
      status: query.status ?? 'ACTIVE',
      ...(query.merchantId ? { merchantId: query.merchantId } : {}),
      limit,
      offset,
    });

    return {
      data: page.data.map((projection) =>
        toMerchantRefundView(projection.refundRequest, projection.allowedNextTransitions),
      ),
      total: page.total,
    };
  }

  @Get(':refundRequestId')
  async get(
    @Param('refundRequestId', new ParseUUIDPipe()) refundRequestId: string,
  ): Promise<RefundTransitionView['refundRequest']> {
    const projection = await this.queries.findOneFor(
      refundRequestId,
      RefundRequestActor.ADMIN,
    );
    return toMerchantRefundView(
      projection.refundRequest,
      projection.allowedNextTransitions,
    );
  }

  @Post(':refundRequestId/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('refundRequestId', new ParseUUIDPipe()) refundRequestId: string,
    @Body() dto: TransitionRefundRequestDto,
  ): Promise<RefundTransitionView> {
    const result = await this.transitionRequest.execute({
      refundRequestId,
      to: dto.to as RefundRequestStatus,
      actor: RefundRequestActor.ADMIN,
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
