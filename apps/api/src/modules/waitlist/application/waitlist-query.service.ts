import { Inject, Injectable } from '@nestjs/common';
import {
  WaitlistActor,
  WaitlistStateMachine,
  WaitlistStatus,
  dayLetterFor,
  estimateWaitMinutes,
  isActiveWaitlistStatus,
  nextTicketNo,
  queuePosition,
} from '@takeout/domain';
import { localDateString } from '../../../common/time/service-date';
import { WAITLIST_REPOSITORY, WAITLIST_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { WaitlistRepositoryPort } from '../domain/waitlist.repository.port';
import {
  CustomerQueueEntryPointView,
  CustomerQueueTicketView,
  MerchantQueueEntryView,
  MerchantQueueView,
  WaitlistSettingsView,
} from '../interface/waitlist.views';
import { toCustomerTicket, toMerchantEntry } from './waitlist.mapper';

/**
 * Read side.
 *
 * Deliberately does NOT go through `WaitlistRepositoryPort` for every query —
 * same CQRS split as `ReservationQueryService`. What it DOES reuse the port for
 * is settings and the live list, because the position a guest is shown and the
 * position the board renders have to be computed from the same queue by the
 * same function, or the two will disagree the moment a host seats somebody.
 */
@Injectable()
export class WaitlistQueryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WAITLIST_REPOSITORY) private readonly waitlist: WaitlistRepositoryPort,
    @Inject(WAITLIST_STATE_MACHINE) private readonly stateMachine: WaitlistStateMachine,
  ) {}

  /**
   * The take-a-number page for one merchant.
   *
   * `myPhone`, when supplied, is how a guest finds their own ticket without an
   * account. It is not a session: the page is opened by somebody who has just
   * walked in, and the phone they typed is the only handle they will still have
   * an hour later.
   */
  async entryPoint(params: {
    merchantId: string;
    myPhone?: string;
    now?: Date;
  }): Promise<CustomerQueueEntryPointView | null> {
    const now = params.now ?? new Date();
    const merchant = await this.waitlist.findQueueMerchant(params.merchantId);
    if (!merchant) return null;

    const settings = await this.waitlist.findSettings(merchant.id, now);
    const policy = settings.policy;
    const serviceDate = serviceDateInFrom(merchant.timezone, now);

    const queue = policy.enabled
      ? await this.waitlist.listActive(merchant.id, serviceDate)
      : [];

    const tickets = queue.map((entry) => ({
      id: entry.id,
      status: entry.status,
      joinedAt: entry.joinedAt,
      calledAt: entry.calledAt,
    }));

    const mine = params.myPhone
      ? await this.waitlist.findActiveForPhone(merchant.id, params.myPhone, serviceDate)
      : null;

    return {
      merchantId: merchant.id,
      merchantName: merchant.name,
      merchantSlug: merchant.slug,
      timezone: merchant.timezone,
      enabled: policy.enabled,
      // Two conditions, and they are not the same: the feature has to be ON and
      // the shop has to be OPEN (or be willing to queue while shut). Collapsing
      // them would make a shop that queues before opening look closed.
      acceptingNow: policy.enabled && (settings.openNow || policy.acceptWhenClosed),
      closedReason: !policy.enabled
        ? 'DISABLED'
        : settings.openNow || policy.acceptWhenClosed
          ? null
          : 'CLOSED',
      policy: {
        minPartySize: policy.minPartySize,
        maxPartySize: policy.maxPartySize,
        averageTurnMinutes: policy.averageTurnMinutes,
        callTimeoutMinutes: policy.callTimeoutMinutes,
      },
      customerNotice: policy.customerNotice,
      queueLength: queue.length,
      // What a NEW guest would wait: the whole queue in front of them.
      estimatedWaitMinutes: estimateWaitMinutes(queue.length, tickets, policy),
      myTicket: mine
        ? toCustomerTicket(mine, queuePosition(tickets, mine.id, policy), policy, now)
        : null,
    };
  }

  /** One guest's own ticket. `null` when it does not exist or is not theirs. */
  async myTicket(params: {
    entryId: string;
    phone: string;
    now?: Date;
  }): Promise<CustomerQueueTicketView | null> {
    const now = params.now ?? new Date();
    const entry = await this.waitlist.findById(params.entryId);
    if (!entry) return null;
    // The phone is the ownership check. It is not authentication and is not
    // pretending to be: it is the same secret the host would use to ring them,
    // and it stops a guessed ticket id from revealing a stranger's name.
    if (entry.contactPhone !== params.phone) return null;

    const settings = await this.waitlist.findSettings(entry.merchantId, now);
    const queue = await this.waitlist.listActive(entry.merchantId, entry.serviceDate);

    return toCustomerTicket(
      entry,
      queuePosition(
        queue.map((row) => ({
          id: row.id,
          status: row.status,
          joinedAt: row.joinedAt,
          calledAt: row.calledAt,
        })),
        entry.id,
        settings.policy,
      ),
      settings.policy,
      now,
    );
  }

  /**
   * The host board.
   *
   * Reads the WHOLE day — active and terminal — in one pass and splits it in
   * memory. Two queries would be two round-trips for a screen that polls every
   * few seconds, and the split is a two-line filter over rows already in hand.
   */
  async board(params: {
    merchantId: string;
    date?: string;
    now?: Date;
  }): Promise<MerchantQueueView | null> {
    const now = params.now ?? new Date();
    const merchant = await this.waitlist.findQueueMerchant(params.merchantId);
    if (!merchant) return null;

    const settings = await this.waitlist.findSettings(merchant.id, now);
    const policy = settings.policy;
    const serviceDate = resolveServiceDate(merchant.timezone, params.date, now);

    const day = await this.waitlist.listForDay(merchant.id, serviceDate);
    const tickets = day.map((entry) => ({
      id: entry.id,
      status: entry.status,
      joinedAt: entry.joinedAt,
      calledAt: entry.calledAt,
    }));

    const toRow = (entry: (typeof day)[number]): MerchantQueueEntryView =>
      toMerchantEntry(
        entry,
        queuePosition(tickets, entry.id, policy),
        policy,
        this.stateMachine.allowedTransitions(entry.status, WaitlistActor.MERCHANT),
        now,
      );

    const active = day.filter((entry) => isActiveWaitlistStatus(entry.status)).map(toRow);
    // Newest first: the log is read top-down when a host is asked "did we seat
    // table six", and the most recent answer is the one they want.
    const completed = day
      .filter((entry) => !isActiveWaitlistStatus(entry.status))
      .reverse()
      .map(toRow);

    return {
      merchantId: merchant.id,
      serviceDate: serviceDate.toISOString().slice(0, 10),
      timezone: merchant.timezone,
      enabled: policy.enabled,
      acceptingNow: policy.enabled && (settings.openNow || policy.acceptWhenClosed),
      customerNotice: policy.customerNotice,
      policy,
      active,
      completed,
      counts: {
        waiting: day.filter((entry) => entry.status === WaitlistStatus.WAITING).length,
        called: day.filter((entry) => entry.status === WaitlistStatus.CALLED).length,
        seated: day.filter((entry) => entry.status === WaitlistStatus.SEATED).length,
        noShow: day.filter((entry) => entry.status === WaitlistStatus.NO_SHOW).length,
        cancelled: day.filter((entry) => entry.status === WaitlistStatus.CANCELLED).length,
      },
      // What the host would issue next. Shown on the board so a ticket read out
      // over the phone can be checked against the screen.
      nextTicketNo: nextTicketNo(
        day.map((entry) => entry.ticketNo),
        dayLetterFor(serviceDate.toISOString().slice(0, 10)),
      ),
    };
  }

  /** The settings screen's read model. */
  async settingsForMerchant(merchantId: string): Promise<WaitlistSettingsView | null> {
    const merchant = await this.waitlist.findQueueMerchant(merchantId);
    if (!merchant) return null;
    const settings = await this.waitlist.findSettings(merchant.id);
    // See WaitlistSettingsService#read: the notice belongs at the top level of
    // this view, not inside `policy` where the domain policy keeps it.
    const { customerNotice, ...policy } = settings.policy;
    return { merchantId, policy, customerNotice, openNow: settings.openNow };
  }
}

/** `YYYY-MM-DD` → `Date` at UTC midnight, which is what `@db.Date` round-trips. */
function resolveServiceDate(timeZone: string, date: string | undefined, now: Date): Date {
  if (date) return new Date(`${date}T00:00:00.000Z`);
  return serviceDateInFrom(timeZone, now);
}

function serviceDateInFrom(timeZone: string, now: Date): Date {
  return new Date(`${localDateString(timeZone, now)}T00:00:00.000Z`);
}
