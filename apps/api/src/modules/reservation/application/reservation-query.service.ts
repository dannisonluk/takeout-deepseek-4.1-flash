import { Inject, Injectable } from '@nestjs/common';
import {
  AvailabilitySlot,
  ReservationActor,
  ReservationStateMachine,
  ReservationStatus,
  isActiveReservationStatus,
  planAvailability,
  type ReservationPolicy,
  type SlotGrid,
  type SlotOccupancy,
} from '@takeout/domain';
import { RESERVATION_REPOSITORY, RESERVATION_STATE_MACHINE } from '../../../common/tokens';
import { localDateString, utcOffsetMinutesAt } from '../../../common/time/service-date';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  BOOKING_WINDOW_DAYS,
  buildAvailabilityWindow,
  describeAvailability,
} from '../domain/availability-window';
import { ReservationRepositoryPort } from '../domain/reservation.repository.port';
import {
  CustomerReservationView,
  MerchantReservationView,
  ReservationAvailabilityView,
  ReservationSettingsView,
  ReservationSlotView,
} from '../interface/reservation.view';

/**
 * Read side.
 *
 * Deliberately does NOT go through `ReservationRepositoryPort` for the list and
 * detail queries — same CQRS split as `OrderQueryService`. What it DOES reuse
 * the port for is settings and occupancy, because availability has to agree
 * with the write path: the grid a customer is shown and the grid the booking is
 * validated against come from the same policy object, or the UI will offer a
 * slot the server then refuses.
 */
@Injectable()
export class ReservationQueryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepositoryPort,
    @Inject(RESERVATION_STATE_MACHINE) private readonly stateMachine: ReservationStateMachine,
  ) {}

  /**
   * The bookable grid for one merchant, over a window.
   *
   * The window defaults to the policy's own advance limit, capped by
   * `BOOKING_WINDOW_DAYS`, so a shop that sets `advanceDays: 365` cannot make a
   * single request walk a year of half-hour slots.
   */
  async availability(params: {
    merchantId: string;
    from: Date;
    to?: Date;
    partySize?: number;
  }): Promise<ReservationAvailabilityView | null> {
    const merchant = await this.reservations.findBookableMerchant(params.merchantId);
    if (!merchant) return null;

    const settings = await this.reservations.findSettings(merchant.id);
    const policy = settings.policy;

    const { windowStart, windowEnd } = buildAvailabilityWindow({
      from: params.from,
      to: params.to,
      policy,
    });

    const occupancy = await this.reservations.findOccupancy(merchant.id, windowStart, windowEnd);

    // 特別休息日 for the window the grid will actually walk. Read here rather
    // than inside `planAvailability` because a closure is a *local calendar
    // date* and this service is where the timezone lives — the domain package
    // is deliberately free of `Intl`.
    const closedDates = await this.closedDatesIn(merchant.id, merchant.timezone, windowStart, windowEnd);

    const grid: SlotGrid = {
      slotMinutes: policy.slotMinutes,
      // Anchored on the window start. The offset is read at that instant, which
      // is what makes a window that straddles a DST change come out right for
      // the part of it the grid actually walks. See `utcOffsetMinutesAt`.
      utcOffsetMinutes: utcOffsetMinutesAt(merchant.timezone, windowStart),
    };

    const slots = planAvailability({
      windowStart,
      windowEnd,
      policy,
      grid,
      now: new Date(),
      occupancy: occupancy.map(
        (row): SlotOccupancy => ({ startsAt: row.startsAt, booked: row.booked }),
      ),
      ...(params.partySize !== undefined ? { partySize: params.partySize } : {}),
      // Both supplied together or neither: the guard in `planAvailability`
      // requires the pair, because a date cannot be resolved without the zone.
      isDateOpen: (localDate) => !closedDates.has(localDate),
      localDateOf: (at) => localDateString(merchant.timezone, at),
    });

    return this.toAvailabilityView(
      merchant.timezone,
      policy,
      settings,
      slots,
      windowStart,
      windowEnd,
      closedDates,
    );
  }

  /**
   * The 特別休息日 inside `[windowStart, windowEnd]`, as local `YYYY-MM-DD`.
   *
   * Padded by one day at each end before the local-date conversion: a window
   * given in instants can start mid-afternoon UTC and end on the next local day
   * for a +08 shop, so converting the raw bounds would clip the first or last
   * date. The pad is harmless — every returned date is still probed against the
   * slots the grid actually produced.
   */
  private async closedDatesIn(
    merchantId: string,
    timeZone: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Set<string>> {
    const padMs = 86_400_000;
    const from = localDateString(timeZone, new Date(windowStart.getTime() - padMs));
    const to = localDateString(timeZone, new Date(windowEnd.getTime() + padMs));

    const rows = await this.prisma.merchantClosure.findMany({
      where: {
        merchantId,
        serviceDate: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      select: { serviceDate: true },
    });

    return new Set(rows.map((row) => row.serviceDate.toISOString().slice(0, 10)));
  }

  /** The shop's own book. Drives the board and its day view. */
  async listForMerchant(params: {
    merchantId: string;
    serviceDate?: Date;
    statuses?: readonly ReservationStatus[];
    limit: number;
  }): Promise<MerchantReservationView[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        merchantId: params.merchantId,
        ...(params.serviceDate ? { serviceDate: params.serviceDate } : {}),
        ...(params.statuses && params.statuses.length > 0
          ? { status: { in: params.statuses as unknown as never[] } }
          : {}),
      },
      orderBy: { startsAt: 'asc' },
      take: params.limit,
      select: merchantReservationSelect,
    });

    return rows.map((row) => this.toMerchantView(row));
  }

  async getForMerchant(
    merchantId: string,
    reservationId: string,
  ): Promise<MerchantReservationView | null> {
    const row = await this.prisma.reservation.findFirst({
      where: { id: reservationId, merchantId },
      select: merchantReservationSelect,
    });
    return row ? this.toMerchantView(row) : null;
  }

  async listForCustomer(params: {
    customerId: string;
    /** `true` hides the terminal bookings; `false` shows everything. */
    activeOnly: boolean;
    limit: number;
  }): Promise<CustomerReservationView[]> {
    const rows = await this.prisma.reservation.findMany({
      where: {
        customerId: params.customerId,
        ...(params.activeOnly
          ? {
              status: {
                in: Object.values(ReservationStatus).filter(
                  isActiveReservationStatus,
                ) as unknown as never[],
              },
            }
          : {}),
      },
      orderBy: { startsAt: 'desc' },
      take: params.limit,
      select: customerReservationSelect,
    });

    return rows.map((row) => this.toCustomerView(row));
  }

  async getForCustomer(
    customerId: string,
    reservationId: string,
  ): Promise<CustomerReservationView | null> {
    const row = await this.prisma.reservation.findFirst({
      where: { id: reservationId, customerId },
      select: customerReservationSelect,
    });
    return row ? this.toCustomerView(row) : null;
  }

  /** The settings screen's read model, including what the customer sees. */
  async settingsForMerchant(merchantId: string): Promise<ReservationSettingsView> {
    const settings = await this.reservations.findSettings(merchantId);
    return {
      policy: settings.policy,
      customerNotice: settings.customerNotice,
      acceptingNew: settings.acceptingNew,
    };
  }

  private toAvailabilityView(
    timeZone: string,
    policy: ReservationPolicy,
    settings: { customerNotice: string | null; acceptingNew: boolean },
    slots: readonly AvailabilitySlot[],
    windowStart: Date,
    windowEnd: Date,
    closedDates: ReadonlySet<string>,
  ): ReservationAvailabilityView {
    const bookable = slots.filter((slot) => slot.bookable);

    return {
      timezone: timeZone,
      enabled: policy.enabled,
      acceptingNew: settings.acceptingNew,
      customerNotice: settings.customerNotice,
      policy: {
        slotMinutes: policy.slotMinutes,
        turnMinutes: policy.turnMinutes,
        minPartySize: policy.minPartySize,
        maxPartySize: policy.maxPartySize,
        leadTimeMinutes: policy.leadTimeMinutes,
        advanceDays: policy.advanceDays,
      },
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      // The prose the booking page shows. Built here rather than in the browser
      // so the sentence and the numbers cannot drift apart.
      notice: describeAvailability(policy, settings.customerNotice, bookable.length),
      // The rest days inside this window, so the booking page can grey out the
      // calendar rather than showing an empty grid with no explanation. Sorted
      // because a Set has no order and the page renders them in sequence.
      closedDates: [...closedDates].sort(),
      slots: slots.map(
        (slot): ReservationSlotView => ({
          startsAt: slot.startsAt.toISOString(),
          remaining: slot.remaining,
          bookable: slot.bookable,
        }),
      ),
      bookableCount: bookable.length,
    };
  }

  private toCustomerView(row: CustomerReservationRow): CustomerReservationView {
    const status = row.status as unknown as ReservationStatus;
    return {
      id: row.id,
      reservationNo: row.reservationNo,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      merchantSlug: row.merchant.slug,
      merchantTimezone: row.merchant.timezone,
      status,
      partySize: row.partySize,
      startsAt: row.startsAt.toISOString(),
      serviceDate: row.serviceDate.toISOString().slice(0, 10),
      customerName: row.customerName,
      customerNote: row.customerNote,
      merchantNote: row.merchantNote,
      statusReason: row.statusReason,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      seatedAt: row.seatedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      // What the customer may do next. Computed by the same machine the write
      // path uses, so a Cancel button can never be offered on a booking the
      // server would refuse.
      canCancel: this.stateMachine.can(status, ReservationStatus.CANCELLED, ReservationActor.CUSTOMER),
    };
  }

  private toMerchantView(row: MerchantReservationRow): MerchantReservationView {
    const status = row.status as unknown as ReservationStatus;
    return {
      ...this.toCustomerView(row),
      contactPhone: row.contactPhone,
      turnMinutes: row.turnMinutes,
      version: row.version,
      // Both actors, so the board's action row is complete: the shop may seat
      // and complete, the system path is what the no-show button takes.
      allowedNextTransitions: {
        merchant: this.stateMachine.allowedTransitions(status, ReservationActor.MERCHANT),
        system: this.stateMachine.allowedTransitions(status, ReservationActor.SYSTEM),
      },
    };
  }
}

const customerReservationSelect = {
  id: true,
  reservationNo: true,
  merchantId: true,
  status: true,
  partySize: true,
  startsAt: true,
  serviceDate: true,
  customerName: true,
  customerNote: true,
  merchantNote: true,
  statusReason: true,
  confirmedAt: true,
  seatedAt: true,
  completedAt: true,
  cancelledAt: true,
  createdAt: true,
  merchant: { select: { name: true, slug: true, timezone: true } },
} as const;

const merchantReservationSelect = {
  ...customerReservationSelect,
  contactPhone: true,
  turnMinutes: true,
  version: true,
} as const;

type CustomerReservationRow = {
  id: string;
  reservationNo: string;
  merchantId: string;
  status: string;
  partySize: number;
  startsAt: Date;
  serviceDate: Date;
  customerName: string;
  customerNote: string | null;
  merchantNote: string | null;
  statusReason: string | null;
  confirmedAt: Date | null;
  seatedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  merchant: { name: string; slug: string; timezone: string };
};

type MerchantReservationRow = CustomerReservationRow & {
  contactPhone: string;
  turnMinutes: number;
  version: number;
};
