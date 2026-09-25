import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { toActor } from '../../../common/auth/actor';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { localDateString } from '../../../common/time/service-date';
import { MerchantClosureService } from '../application/merchant-closure.service';
import { MerchantService } from '../application/merchant.service';
import { PickupSlotService } from '../application/pickup-slots.service';
import {
  ClosureView,
  ClosureWriteResultView,
  CreateMerchantDto,
  IntakeSwitchDto,
  ReplaceOperatingHoursDto,
  SetClosureDto,
  UpdateMerchantDto,
} from './dto/merchant.dto';
import { OperatingHourView, OwnedMerchantView, PickupSlotsView } from './merchant.views';

/**
 * The merchant's own portal.
 *
 * `MerchantScopeGuard` sits at class level and is what makes the `:merchantId`
 * path parameter safe: an owner who guesses another merchant's id gets a 403
 * rather than a data leak, and an admin passes through. Routes without a
 * `:merchantId` (`apply`, `mine`) are unaffected — the guard returns early when
 * the parameter is absent.
 */
@Controller('merchant')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantController {
  constructor(
    private readonly merchants: MerchantService,
    private readonly pickupSlots: PickupSlotService,
    private readonly closures: MerchantClosureService,
  ) {}

  /**
   * 商戶申請入駐.
   *
   * Any authenticated customer may apply — that is the onboarding funnel. The
   * merchant lands in `PENDING_REVIEW`, so this grants access to the setup
   * screens, not the ability to take money.
   */
  @Post('apply')
  @HttpCode(HttpStatus.CREATED)
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMerchantDto,
  ): Promise<OwnedMerchantView> {
    return this.merchants.apply(user.userId, dto);
  }

  /** Every merchant this principal owns or works for. */
  @Get('mine')
  listMine(@CurrentUser() user: AuthenticatedUser): Promise<OwnedMerchantView[]> {
    return this.merchants.listMine(user.userId, user.role);
  }

  @Get(':merchantId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
  ): Promise<OwnedMerchantView> {
    return this.merchants.getOwned(merchantId, user.userId);
  }

  @Patch(':merchantId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: UpdateMerchantDto,
    @Req() request: Request,
  ): Promise<OwnedMerchantView> {
    return this.merchants.update(merchantId, dto, toActor(user, request));
  }

  /**
   * Replace the whole week in one call.
   *
   * A PUT rather than a per-day PATCH: the settings screen edits all seven rows
   * and saves once, and a partial write would leave the shop open on a day the
   * operator believed they had closed.
   */
  @Put(':merchantId/hours')
  replaceHours(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: ReplaceOperatingHoursDto,
    @Req() request: Request,
  ): Promise<OperatingHourView[]> {
    return this.merchants.replaceHours(merchantId, dto.hours, toActor(user, request));
  }

  /** 接單 / 停單 — the switch the `MERCHANT_ACCEPTING` guard reads. */
  @Post(':merchantId/intake')
  @HttpCode(HttpStatus.OK)
  setIntake(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: IntakeSwitchDto,
    @Req() request: Request,
  ): Promise<{ merchantId: string; accepting: boolean }> {
    return this.merchants.setIntake(merchantId, dto.accepting, toActor(user, request));
  }

  /** The owner's own view of bookable slots — same policy as the public one. */
  @Get(':merchantId/pickup-slots')
  async slots(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
  ): Promise<PickupSlotsView> {
    const view = await this.pickupSlots.forMerchantId(merchantId);
    if (!view) throw new NotFoundException('Merchant not found');
    return view;
  }

  // -------------------------------------------------------------------------
  //  特別休息日
  // -------------------------------------------------------------------------

  /**
   * The shop's dated rest days.
   *
   * `from` defaults to today in the shop's OWN timezone, not the server's —
   * a +08 shop at 17:30 UTC is already into tomorrow, and a `from` derived from
   * `new Date()` would hide the day it most plausibly wants to close. Reading
   * the timezone costs one extra query and removes a class of "my rest day
   * disappeared" bug report.
   */
  @Get(':merchantId/closures')
  async listClosures(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query('from') from?: string,
  ): Promise<ClosureView[]> {
    if (from) return this.closures.list(merchantId, from);

    const timezone = await this.closures.timezoneOf(merchantId);
    if (!timezone) throw new NotFoundException('Merchant not found');
    return this.closures.list(merchantId, localDateString(timezone, new Date()));
  }

  @Get(':merchantId/closures/:serviceDate')
  async getClosure(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('serviceDate') serviceDate: string,
  ): Promise<ClosureView> {
    const closure = await this.closures.findOne(merchantId, serviceDate);
    if (!closure) throw new NotFoundException('Closure not found');
    return closure;
  }

  /**
   * Close a day, and cancel the bookings already in it.
   *
   * PUT on a single date — a day either is a rest day or is not, and the
   * response says what the cascade did (`cancelledReservations`,
   * `remainingActive`) so the settings screen can show a real number rather
   * than a generic "saved".
   */
  @Put(':merchantId/closures/:serviceDate')
  setClosure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('serviceDate') serviceDate: string,
    @Body() dto: SetClosureDto,
    @Req() request: Request,
  ): Promise<ClosureWriteResultView> {
    return this.closures.upsert(merchantId, serviceDate, dto, toActor(user, request));
  }

  /**
   * Reopen a day.
   *
   * Does NOT re-book the parties the closure cancelled. That asymmetry is
   * deliberate — see `MerchantClosureService.remove`.
   */
  @Delete(':merchantId/closures/:serviceDate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteClosure(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('serviceDate') serviceDate: string,
    @Req() request: Request,
  ): Promise<void> {
    await this.closures.remove(merchantId, serviceDate, toActor(user, request));
  }
}
