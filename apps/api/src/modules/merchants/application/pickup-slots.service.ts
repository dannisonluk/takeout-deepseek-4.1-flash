import { Injectable } from '@nestjs/common';
import { closuresWithin } from '@takeout/domain';
import { localDateString } from '../../../common/time/service-date';
import {
  checkOpening,
  earliestPickupAt,
  latestPickupAt,
  MAX_ADVANCE_HOURS,
  OperatingWindow,
  roundUpToSlot,
  SLOT_STEP_MINUTES,
} from '../../../common/time/pickup-policy';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { PickupSlotView, PickupSlotsView } from '../interface/merchant.views';

/**
 * A 24-hour booking horizon at 15-minute granularity is 96 slots; the cap only
 * guards against a misconfigured step size turning the walk into a long loop.
 */
const MAX_SLOTS = 200;

const hourMinuteFormatCache = new Map<string, Intl.DateTimeFormat>();

function hourMinuteFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = hourMinuteFormatCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    hourMinuteFormatCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Bookable pickup slots.
 *
 * This is a read model, not a business rule: the rules themselves live in
 * `common/time/pickup-policy.ts` and are applied by `PlaceOrderUseCase` too.
 * What this service adds is the *walk* — every 15 minutes from the earliest
 * feasible time to the end of the booking horizon, filtered to the moments the
 * merchant is actually open.
 */
@Injectable()
export class PickupSlotService {
  constructor(private readonly prisma: PrismaService) {}

  async forSlug(slug: string, now: Date = new Date()): Promise<PickupSlotsView | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { slug },
      select: merchantSlotFields,
    });
    if (!merchant || merchant.status !== 'ACTIVE') return null;
    return build(merchant, now, await this.closuresFor(merchant.id, merchant.timezone, now));
  }

  async forMerchantId(
    merchantId: string,
    now: Date = new Date(),
  ): Promise<PickupSlotsView | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: merchantSlotFields,
    });
    if (!merchant) return null;
    return build(merchant, now, await this.closuresFor(merchantId, merchant.timezone, now));
  }

  /**
   * The 特別休息日 that can possibly matter to this walk: from today to the far
   * edge of the booking horizon.
   *
   * Windowed rather than "every closure this shop ever wrote" — the horizon is
   * 24 hours, so a shop with three years of history would otherwise drag all of
   * it into memory to answer a question about tomorrow. `+2` days of slack on
   * the far edge because the horizon is expressed in hours and the last date it
   * can touch is one or two calendar days out depending on the local clock.
   */
  private async closuresFor(
    merchantId: string,
    timeZone: string,
    now: Date,
  ): Promise<ReadonlySet<string>> {
    const from = localDateString(timeZone, now);
    const to = localDateString(timeZone, new Date(now.getTime() + MAX_ADVANCE_HOURS * 3_600_000 + 2 * 86_400_000));

    const rows = await this.prisma.merchantClosure.findMany({
      where: {
        merchantId,
        serviceDate: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
      },
      select: { serviceDate: true, reason: true, note: true },
    });

    return closuresWithin(
      rows.map((row) => ({
        serviceDate: row.serviceDate.toISOString().slice(0, 10),
        reason: row.reason as never,
        note: row.note,
      })),
      from,
      to,
    );
  }
}

const merchantSlotFields = {
  id: true,
  status: true,
  timezone: true,
  prepTimeMinutes: true,
  pickupWindowMinutes: true,
  hours: {
    select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
  },
} as const;

type MerchantSlotRow = {
  id: string;
  status: string;
  timezone: string;
  prepTimeMinutes: number;
  pickupWindowMinutes: number;
  hours: OperatingWindow[];
};

function build(
  merchant: MerchantSlotRow,
  now: Date,
  closures: ReadonlySet<string>,
): PickupSlotsView {
  const earliest = earliestPickupAt(now, merchant.prepTimeMinutes);
  const latest = latestPickupAt(now);
  const first = roundUpToSlot(earliest, merchant.timezone, SLOT_STEP_MINUTES);
  const today = localDateString(merchant.timezone, now);
  const formatter = hourMinuteFormatter(merchant.timezone);
  const windowMs = merchant.pickupWindowMinutes * 60_000;

  const slots: PickupSlotView[] = [];
  for (
    let cursor = first;
    cursor.getTime() <= latest.getTime() && slots.length < MAX_SLOTS;
    cursor = new Date(cursor.getTime() + SLOT_STEP_MINUTES * 60_000)
  ) {
    if (!checkOpening(merchant.hours, merchant.timezone, cursor, closures).open) continue;

    slots.push({
      startAt: cursor.toISOString(),
      endAt: new Date(cursor.getTime() + windowMs).toISOString(),
      label: formatter.format(cursor),
      dayOffset: dayOffsetBetween(today, localDateString(merchant.timezone, cursor)),
    });
  }

  const openingNow = checkOpening(merchant.hours, merchant.timezone, now, closures);

  return {
    merchantId: merchant.id,
    timezone: merchant.timezone,
    stepMinutes: SLOT_STEP_MINUTES,
    windowMinutes: merchant.pickupWindowMinutes,
    earliestAt: earliest.toISOString(),
    latestAt: latest.toISOString(),
    acceptingNow: openingNow.open,
    // Why not, when the answer is no. `null` when the shop is open now, so the
    // front end has one field to read rather than re-deriving the rule — and so
    // the customer is told whether this is a rest day or just closing time.
    closedReason: openingNow.open ? null : openingNow.reason,
    // The next dated closure the walk actually ran into, if any. Only one: the
    // banner says "this shop is shut on <date>", and a second date would make it
    // a list.
    closureDate: firstClosureDate(
      closures,
      today,
      localDateString(merchant.timezone, latest),
    ),
    slots,
  };
}

/**
 * The earliest closure date inside the booking horizon, or `null`.
 *
 * Derived from the closure SET rather than by walking the horizon: the set was
 * already windowed to `[today, today + horizon]` by `closuresFor`, so its
 * minimum IS the answer, and a walk over 24 hourly steps to rediscover it would
 * be 24 timezone conversions to find a value already in hand.
 *
 * Returns `null` when the horizon holds no closure, which is the common case
 * and must stay cheap.
 */
function firstClosureDate(closures: ReadonlySet<string>, from: string, to: string): string | null {
  let earliest: string | null = null;
  for (const date of closures) {
    // Bounded by the dates the walk can actually produce, not by the padded set.
    // A closure on `to + 1` is in the set (the padding is deliberate, see
    // `closuresFor`) but cannot be a slot, so naming it in the banner would
    // promise the customer a rest day they can never see.
    if (date < from || date > to) continue;
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

/** Whole days between two `YYYY-MM-DD` strings. */
function dayOffsetBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}
