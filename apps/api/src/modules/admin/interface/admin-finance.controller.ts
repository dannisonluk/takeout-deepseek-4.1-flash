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
import { AdminFinanceService } from '../application/admin-finance.service';
import {
  AdminPayoutQueryDto,
  FailPayoutDto,
  MarkPayoutDto,
  ReconciliationQueryDto,
} from './dto/admin.dto';
import { AdminPayoutView, ReconciliationView } from './admin.views';
import type { AdminPayoutDetailView } from '../application/admin-finance.service';

/**
 * Settlement and reconciliation.
 *
 * Nothing here computes money. The payout aggregates are written by the order
 * state machine's `RECORD_PAYOUT_LEDGER` side effect; this console only moves a
 * batch through `PENDING -> PAID/FAILED` and exposes the reconciliation view
 * that proves the ledger and the orders agree.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminFinanceController {
  constructor(private readonly finance: AdminFinanceService) {}

  @Get('payouts')
  listPayouts(@Query() query: AdminPayoutQueryDto): Promise<{
    data: AdminPayoutView[];
    total: number;
    totals: { pendingNetMinor: number; paidNetMinor: number };
  }> {
    return this.finance.listPayouts(query);
  }

  @Get('payouts/:payoutId')
  getPayout(
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
  ): Promise<AdminPayoutDetailView> {
    return this.finance.getPayout(payoutId);
  }

  @Post('payouts/:payoutId/mark-paid')
  @HttpCode(HttpStatus.OK)
  markPaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
    @Body() dto: MarkPayoutDto,
    @Req() request: Request,
  ): Promise<AdminPayoutDetailView> {
    return this.finance.markPaid(payoutId, dto, toActor(user, request));
  }

  @Post('payouts/:payoutId/mark-failed')
  @HttpCode(HttpStatus.OK)
  markFailed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
    @Body() dto: FailPayoutDto,
    @Req() request: Request,
  ): Promise<AdminPayoutDetailView> {
    return this.finance.markFailed(payoutId, dto, toActor(user, request));
  }

  /**
   * Merchant-day comparison of the platform fee on orders vs. on the payout
   * ledger. `totalDeltaMinor: 0` is the pass condition.
   */
  @Get('reconciliation')
  reconciliation(@Query() query: ReconciliationQueryDto): Promise<ReconciliationView> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 24 * 3_600_000);

    return this.finance.reconciliation({
      from,
      to,
      limit: query.limit,
      onlyMismatched: query.onlyMismatched,
    });
  }
}
