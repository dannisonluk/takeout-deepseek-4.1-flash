import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReservationActor, ReservationStatus } from '@takeout/domain';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PlaceReservationUseCase } from '../application/place-reservation.use-case';
import { ReservationQueryService } from '../application/reservation-query.service';
import { TransitionReservationUseCase } from '../application/transition-reservation.use-case';
import { AvailabilityQueryDto, PlaceReservationDto, ReservationReasonDto } from './dto/reservation.dto';
import {
  CustomerReservationView,
  ReservationAvailabilityView,
  ReservationCreatedView,
} from './reservation.view';

const PAGE_SIZE_CAP = 100;

/**
 * The customer's side of 預約訂位.
 *
 * Two surfaces, deliberately on different paths:
 *
 *   - `GET /merchants/:merchantId/reservation-availability` is PUBLIC (no
 *     guard). A booking page has to render the grid before it knows who is
 *     looking — requiring a token just to see which times exist would put the
 *     login wall in front of the shop's opening hours.
 *   - Everything under `POST/GET /reservations` needs a token, because it
 *     creates or reads a specific customer's booking.
 */
@Controller()
export class CustomerReservationController {
  constructor(
    private readonly placeReservation: PlaceReservationUseCase,
    private readonly transitionReservation: TransitionReservationUseCase,
    private readonly queries: ReservationQueryService,
  ) {}

  /** Public. The slot grid for a merchant. */
  @Get('merchants/:merchantId/reservation-availability')
  async availability(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: AvailabilityQueryDto,
  ): Promise<ReservationAvailabilityView> {
    const result = await this.queries.availability({
      merchantId,
      from: parseFrom(query.from),
      ...(query.to ? { to: parseFrom(query.to) } : {}),
      ...(query.partySize !== undefined ? { partySize: query.partySize } : {}),
    });
    if (!result) throw new NotFoundException('Merchant not found');
    return result;
  }

  @Post('reservations')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PlaceReservationDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<ReservationCreatedView> {
    const result = await this.placeReservation.execute({
      customerId: user.userId,
      merchantId: dto.merchantId,
      partySize: dto.partySize,
      startsAt: new Date(dto.startsAt),
      customerName: dto.customerName,
      contactPhone: dto.contactPhone,
      ...(dto.customerNote !== undefined ? { customerNote: dto.customerNote } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    const { reservation, settings, merchant } = result;
    return {
      id: reservation.id,
      reservationNo: reservation.reservationNo,
      merchantId: reservation.merchantId,
      merchantName: merchant.name,
      status: reservation.status,
      partySize: reservation.partySize,
      startsAt: reservation.startsAt.toISOString(),
      serviceDate: reservation.serviceDate.toISOString().slice(0, 10),
      timezone: merchant.timezone,
      customerNotice: settings.customerNotice,
      autoConfirmed: settings.policy.autoConfirm,
    };
  }

  @Get('reservations')
  @UseGuards(JwtAuthGuard)
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status: 'ACTIVE' | 'ALL' = 'ALL',
    @Query('limit') limit = '20',
  ): Promise<{ data: CustomerReservationView[]; hasMore: boolean }> {
    const take = Math.min(Number.parseInt(limit, 10) || 20, PAGE_SIZE_CAP);
    const rows = await this.queries.listForCustomer({
      customerId: user.userId,
      activeOnly: status === 'ACTIVE',
      limit: take + 1,
    });

    const hasMore = rows.length > take;
    return { data: hasMore ? rows.slice(0, take) : rows, hasMore };
  }

  @Get('reservations/:reservationId')
  @UseGuards(JwtAuthGuard)
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
  ): Promise<CustomerReservationView> {
    const reservation = await this.queries.getForCustomer(user.userId, reservationId);
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }

  /**
   * The customer calls it off.
   *
   * The state machine is the authority on whether they may: a booking already
   * `SEATED` refuses with `RESERVATION_NOT_PERMITTED` (409), and the customer
   * page never offers the button in that state — `canCancel` is computed from
   * this same machine.
   */
  @Post('reservations/:reservationId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body() dto: ReservationReasonDto,
  ) {
    // Ownership check first: a customer must not be able to drive somebody
    // else's booking to CANCELLED just by knowing its id. The state machine
    // permits CUSTOMER -> CANCELLED in the abstract; it has no idea who is
    // asking.
    const owned = await this.queries.getForCustomer(user.userId, reservationId);
    if (!owned) throw new NotFoundException('Reservation not found');

    const result = await this.transitionReservation.execute({
      reservationId,
      to: ReservationStatus.CANCELLED,
      actor: ReservationActor.CUSTOMER,
      actorId: user.userId,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    });

    const view = await this.queries.getForCustomer(user.userId, reservationId);
    return { ...result, reservation: view ?? owned };
  }
}

/**
 * `from` accepts either a full ISO instant or a bare `YYYY-MM-DD` local date.
 *
 * A bare date is parsed as UTC midnight. The availability window is wide enough
 * that the hour either way does not move which slots appear for a shop in a
 * +8 zone, and a caller that cares about the exact boundary sends a full
 * instant — which is what the booking page does, since the availability
 * response hands it the timezone.
 */
function parseFrom(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00.000Z`);
  }
  return new Date(value);
}
