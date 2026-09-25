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
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  DomainError,
  ReservationActor,
  ReservationStatus,
  ReservationsPausedError,
} from '@takeout/domain';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { serviceDateIn } from '../../../common/time/service-date';
import { RESERVATION_REPOSITORY } from '../../../common/tokens';
import { MerchantNotBookableError } from '../application/place-reservation.use-case';
import { ReservationQueryService } from '../application/reservation-query.service';
import { TransitionReservationUseCase } from '../application/transition-reservation.use-case';
import { ReservationRepositoryPort } from '../domain/reservation.repository.port';
import { ReservationReasonDto, UpdateReservationSettingsDto } from './dto/reservation.dto';
import { MerchantReservationView, ReservationSettingsView } from './reservation.view';

const PAGE_SIZE_CAP = 200;

/**
 * The shop's reservation book.
 *
 * Every status change funnels through `TransitionReservationUseCase`, so the
 * merchant endpoints cannot invent a transition the state machine would reject.
 * The response always carries `allowedNextTransitions` — the board renders its
 * buttons from that list rather than hard-coding the lifecycle, which is what
 * stops a button appearing that the server will refuse.
 */
@Controller('merchant/:merchantId/reservations')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantReservationController {
  constructor(
    private readonly transitionReservation: TransitionReservationUseCase,
    private readonly queries: ReservationQueryService,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepositoryPort,
  ) {}

  @Get()
  async list(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query('date') date?: string,
    @Query('status') status: 'ACTIVE' | 'ALL' = 'ACTIVE',
    @Query('limit') limit = '100',
  ): Promise<{ data: MerchantReservationView[]; hasMore: boolean }> {
    const take = Math.min(Number.parseInt(limit, 10) || 100, PAGE_SIZE_CAP);

    // A bare `YYYY-MM-DD` is a local calendar date for this shop, so it is
    // converted through the merchant's timezone rather than parsed as UTC —
    // otherwise "today's book" for a +8 shop shifts a day either side of
    // midnight.
    const merchant = await this.reservations.findBookableMerchant(merchantId);
    const serviceDate = date
      ? (merchant
          ? serviceDateIn(merchant.timezone, new Date(`${date}T12:00:00.000Z`))
          : new Date(`${date}T00:00:00.000Z`))
      : undefined;

    const rows = await this.queries.listForMerchant({
      merchantId,
      ...(serviceDate ? { serviceDate } : {}),
      ...(status === 'ACTIVE'
        ? { statuses: [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.SEATED] }
        : {}),
      limit: take + 1,
    });

    const hasMore = rows.length > take;
    return { data: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  @Get('settings')
  async getSettings(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
  ): Promise<ReservationSettingsView> {
    return this.queries.settingsForMerchant(merchantId);
  }

  /**
   * Replace the book's settings.
   *
   * PUT rather than PATCH: the settings form always submits the whole object,
   * and a partial write is how a merchant ends up with a `maxPartySize` they
   * thought they had changed. Cross-field rules are checked here because they
   * need both the stored and the incoming value.
   */
  @Put('settings')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: UpdateReservationSettingsDto,
  ): Promise<ReservationSettingsView> {
    const current = await this.reservations.findSettings(merchantId);
    const merged = {
      ...current.policy,
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.autoConfirm !== undefined ? { autoConfirm: dto.autoConfirm } : {}),
      ...(dto.slotMinutes !== undefined ? { slotMinutes: dto.slotMinutes } : {}),
      ...(dto.turnMinutes !== undefined ? { turnMinutes: dto.turnMinutes } : {}),
      ...(dto.seatsPerSlot !== undefined ? { seatsPerSlot: dto.seatsPerSlot } : {}),
      ...(dto.minPartySize !== undefined ? { minPartySize: dto.minPartySize } : {}),
      ...(dto.maxPartySize !== undefined ? { maxPartySize: dto.maxPartySize } : {}),
      ...(dto.leadTimeMinutes !== undefined ? { leadTimeMinutes: dto.leadTimeMinutes } : {}),
      ...(dto.advanceDays !== undefined ? { advanceDays: dto.advanceDays } : {}),
    };

    assertSettingsCoherent(merged);

    await this.reservations.saveSettings(merchantId, {
      ...merged,
      ...(dto.customerNotice !== undefined ? { customerNotice: dto.customerNotice } : {}),
      updatedById: user.userId,
    });

    return this.queries.settingsForMerchant(merchantId);
  }

  @Get(':reservationId')
  async get(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
  ): Promise<MerchantReservationView> {
    const reservation = await this.queries.getForMerchant(merchantId, reservationId);
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }

  /** PENDING -> CONFIRMED. Blocked when the shop has paused intake. */
  @Post(':reservationId/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    return this.transition(merchantId, reservationId, ReservationStatus.CONFIRMED, user, dto);
  }

  /** PENDING -> DECLINED. The shop refuses. */
  @Post(':reservationId/decline')
  @HttpCode(HttpStatus.OK)
  decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    return this.transition(merchantId, reservationId, ReservationStatus.DECLINED, user, dto);
  }

  /** CONFIRMED -> SEATED. The party is at the table. */
  @Post(':reservationId/seat')
  @HttpCode(HttpStatus.OK)
  seat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    return this.transition(merchantId, reservationId, ReservationStatus.SEATED, user, dto);
  }

  /** SEATED -> COMPLETED. They ate and left; the table comes back. */
  @Post(':reservationId/complete')
  @HttpCode(HttpStatus.OK)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    return this.transition(merchantId, reservationId, ReservationStatus.COMPLETED, user, dto);
  }

  /**
   * -> NO_SHOW.
   *
   * Only legal from `CONFIRMED` and only once the booked time has passed — the
   * `WITHIN_TURN_WINDOW` guard enforces the second half. Without it a shop could
   * clear tonight's book at lunchtime and hand the tables to somebody else while
   * the original party is still planning to turn up.
   */
  @Post(':reservationId/no-show')
  @HttpCode(HttpStatus.OK)
  noShow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    return this.transition(merchantId, reservationId, ReservationStatus.NO_SHOW, user, dto);
  }

  /** Either active status -> CANCELLED. The shop ends it. */
  @Post(':reservationId/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    return this.transition(merchantId, reservationId, ReservationStatus.CANCELLED, user, dto);
  }

  /**
   * Reads the shop's book so the `RESERVATIONS_ACCEPTING` guard has something to
   * check. A merchant that is not `ACTIVE` is not bookable, which is the correct
   * answer here too.
   */
  private async transition(
    merchantId: string,
    reservationId: string,
    to: ReservationStatus,
    user: AuthenticatedUser,
    dto: ReservationReasonDto,
  ) {
    const merchant = await this.reservations.findBookableMerchant(merchantId);
    if (!merchant) throw new MerchantNotBookableError(merchantId);

    const settings = await this.reservations.findSettings(merchantId);
    if (!settings.policy.enabled) throw new ReservationsPausedError(merchantId);

    const result = await this.transitionReservation.execute({
      reservationId,
      to,
      actor: ReservationActor.MERCHANT,
      actorId: user.userId,
      merchantAcceptingReservations: settings.acceptingNew,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
      ...(dto.merchantNote !== undefined ? { merchantNote: dto.merchantNote } : {}),
    });

    const view = await this.queries.getForMerchant(merchantId, reservationId);
    return { ...result, reservation: view ?? result.reservation };
  }
}

/**
 * Cross-field rules the DTO cannot express.
 *
 * Both are the kind of setting that looks fine in isolation and produces a book
 * nobody can use: `min > max` makes every party size invalid, and a turn shorter
 * than the grid means a booking occupies less than the slot it is placed on —
 * which the counter arithmetic then rounds in the shop's favour, quietly
 * overbooking.
 */
function assertSettingsCoherent(merged: {
  slotMinutes: number;
  turnMinutes: number;
  minPartySize: number;
  maxPartySize: number;
}): void {
  if (merged.minPartySize > merged.maxPartySize) {
    throw new InvalidReservationSettingsError('minPartySize 不能大於 maxPartySize', {
      minPartySize: merged.minPartySize,
      maxPartySize: merged.maxPartySize,
    });
  }

  if (merged.turnMinutes < merged.slotMinutes) {
    throw new InvalidReservationSettingsError('turnMinutes 不能短於 slotMinutes', {
      turnMinutes: merged.turnMinutes,
      slotMinutes: merged.slotMinutes,
    });
  }
}

/** Mapped to 422 by the exception filter via `PLATFORM_CONFIG_INVALID`. */
export class InvalidReservationSettingsError extends DomainError {
  constructor(message: string, details: Record<string, unknown>) {
    // A dedicated code so the settings screen can highlight the offending pair
    // rather than showing a generic validation failure.
    super('PLATFORM_CONFIG_INVALID', message, details);
  }
}
