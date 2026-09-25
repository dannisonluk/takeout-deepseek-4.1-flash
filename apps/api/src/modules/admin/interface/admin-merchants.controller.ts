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
import {
  IntakeSwitchDto,
  SetAnalyticsTierDto,
} from '../../merchants/interface/dto/merchant.dto';
import { AnalyticsTierWriteView } from '../../merchants/interface/merchant.views';
import { AdminMerchantsService } from '../application/admin-merchants.service';
import { AdminMerchantQueryDto, MerchantActionDto } from './dto/admin.dto';
import { AdminMerchantView } from './admin.views';

/**
 * The merchant approval queue and lifecycle console.
 *
 * Every response carries `allowedActions`, computed by the same
 * `applyMerchantAction` table that validates the write — so the console can
 * never offer a button the API would reject.
 */
@Controller('admin/merchants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminMerchantsController {
  constructor(private readonly merchants: AdminMerchantsService) {}

  @Get()
  list(
    @Query() query: AdminMerchantQueryDto,
  ): Promise<{ data: AdminMerchantView[]; total: number }> {
    return this.merchants.list(query);
  }

  @Get(':merchantId')
  get(@Param('merchantId', new ParseUUIDPipe()) merchantId: string): Promise<AdminMerchantView> {
    return this.merchants.get(merchantId);
  }

  /**
   * APPROVE / SUSPEND / REINSTATE / CLOSE.
   *
   * Returns 409 `MERCHANT_STATUS_TRANSITION` when the move is not legal from the
   * current status, with the legal set in `details.allowed`.
   */
  @Post(':merchantId/action')
  @HttpCode(HttpStatus.OK)
  act(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: MerchantActionDto,
    @Req() request: Request,
  ): Promise<AdminMerchantView> {
    return this.merchants.act(merchantId, dto, toActor(user, request));
  }

  /** Flip 接單/停單 on a merchant's behalf, for when they are unresponsive. */
  @Post(':merchantId/intake')
  @HttpCode(HttpStatus.OK)
  setIntake(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: IntakeSwitchDto,
    @Req() request: Request,
  ): Promise<AdminMerchantView> {
    return this.merchants.setIntake(merchantId, dto.accepting, toActor(user, request));
  }

  /**
   * 設定商戶報表權限.
   *
   * The only way a shop's `AnalyticsTier` changes — see
   * `AdminMerchantsService.setAnalyticsTier` for why this is not a merchant
   * setting. A downgrade answers with a `warning` naming what the shop loses,
   * so an operator confirms with the consequence in front of them rather than
   * discovering it in a support ticket a month later.
   */
  @Post(':merchantId/analytics-tier')
  @HttpCode(HttpStatus.OK)
  setAnalyticsTier(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: SetAnalyticsTierDto,
    @Req() request: Request,
  ): Promise<AnalyticsTierWriteView> {
    return this.merchants.setAnalyticsTier(merchantId, dto.tier, toActor(user, request));
  }
}
