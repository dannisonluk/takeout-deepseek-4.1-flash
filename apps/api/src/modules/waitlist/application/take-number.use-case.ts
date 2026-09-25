import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IdGenerator,
  WaitlistActor,
  WaitlistDisabledError,
  WaitlistClosedError,
  WaitlistAlreadyQueuedError,
  WaitlistStatus,
  assertPartySize,
  dayLetterFor,
  estimateWaitMinutes,
  normalizeGuestName,
  normalizePhone,
  nextTicketNo,
  queuePosition,
} from '@takeout/domain';
import { localDateString, serviceDateIn } from '../../../common/time/service-date';
import { ID_GENERATOR, WAITLIST_REPOSITORY } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ConcurrentWaitlistModificationError } from '../domain/waitlist.errors';
import { WaitlistRepositoryPort } from '../domain/waitlist.repository.port';
import {
  CustomerQueueTicketView,
  TakeNumberResultView,
} from '../interface/waitlist.views';
import { toCustomerTicket, WAITLIST_STATUS_LABEL } from './waitlist.mapper';

export interface TakeNumberCommand {
  readonly merchantId: string;
  readonly partySize: number;
  readonly guestName: string;
  readonly contactPhone: string;
  readonly note?: string;
  /** Injected so the service-day rollover can be tested at a chosen instant. */
  readonly now?: Date;
}

/**
 * 取候位號碼 — put a guest in the queue.
 *
 * WHY TAKING A NUMBER IS THE WHOLE CONFIRMATION
 * ---------------------------------------------
 * There is no `PENDING`: a guest who has pulled a number is in the queue. An
 * intake step that had to approve each ticket would be a queue the shop has to
 * work before it can work the queue, and the guest would be standing at the
 * door holding a number that means nothing.
 *
 * What the method DOES have to get right is the ticket number. Three facts
 * about it are load-bearing:
 *
 *   1. **It is unique per shop per trading day**, and `nextTicketNo` never
 *      reuses a gap. Two parties must never be briefly holding `A-014`.
 *   2. **The letter is a pure function of the date** (`dayLetterFor`), so the
 *      same ticket means the same thing after a restart or on a second server.
 *   3. **The sequence is read inside the same transaction as the insert.**
 *      Reading it outside would let two simultaneous arrivals both compute
 *      `A-015`; the `@@unique([merchantId, serviceDate, ticketNo])` constraint
 *      is the backstop, and the retry below is what turns that constraint into
 *      a correct number rather than a 500.
 */
@Injectable()
export class TakeNumberUseCase {
  private readonly logger = new Logger(TakeNumberUseCase.name);

  /**
   * How many times to re-read the sequence after a unique-constraint clash.
   *
   * Three, because a clash means somebody inserted between our read and our
   * write — a window of microseconds. A fourth failure means the queue is
   * being hammered, and the honest answer then is to let the caller retry
   * rather than hold a transaction open longer.
   */
  private static readonly MAX_TICKET_RETRIES = 3;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WAITLIST_REPOSITORY) private readonly waitlist: WaitlistRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: TakeNumberCommand): Promise<TakeNumberResultView> {
    const now = command.now ?? new Date();
    const merchant = await this.waitlist.findQueueMerchant(command.merchantId);
    if (!merchant) throw new WaitlistDisabledError(command.merchantId);

    const settings = await this.waitlist.findSettings(merchant.id, now);
    const policy = settings.policy;

    // Three refusals, in order, each with its own code because the page shows a
    // different line for each. The order matters: "the feature is off" beats
    // "we are shut", because a shop with the queue off is not a shop the guest
    // should be told to come back to.
    if (!policy.enabled) throw new WaitlistDisabledError(merchant.id);
    if (!settings.openNow && !policy.acceptWhenClosed) {
      throw new WaitlistClosedError(merchant.id);
    }

    assertPartySize(command.partySize, policy);

    const guestName = normalizeGuestName(command.guestName);
    const contactPhone = normalizePhone(command.contactPhone);
    const serviceDate = serviceDateIn(merchant.timezone, now);

    // One live ticket per guest per shop per day, keyed on the phone. A second
    // tap on the button is the common case here — the page is a single large
    // button on a phone with a slow connection — and answering it with "you are
    // already A-014" is far better than issuing A-015 to the same person.
    const existing = await this.waitlist.findActiveForPhone(
      merchant.id,
      contactPhone,
      serviceDate,
    );
    if (existing) {
      throw new WaitlistAlreadyQueuedError(existing.id, existing.ticketNo);
    }

    // The estimate is computed against the queue BEFORE this guest joins, and
    // snapshotted onto the row. Showing it now and again later must not move
    // the goalposts: the page says "你加入時預計 N 分鐘".
    const queue = await this.waitlist.listActive(merchant.id, serviceDate);
    const quotedMinutes = estimateWaitMinutes(
      queue.length,
      queue.map((entry) => ({
        id: entry.id,
        status: entry.status,
        joinedAt: entry.joinedAt,
        calledAt: entry.calledAt,
      })),
      policy,
    );

    const inserted = await this.insertWithTicket(merchant.id, merchant.timezone, serviceDate, {
      partySize: Math.trunc(command.partySize),
      guestName,
      contactPhone,
      note: command.note?.trim() || null,
      quotedMinutes,
    });

    this.logger.log(
      `Queue ${merchant.id}: ${inserted.ticketNo} issued for ${partySizeLabel(inserted.partySize)}`,
    );

    // Position is recomputed against the queue INCLUDING the new ticket, so the
    // guest's own page is consistent with what the board will show a moment
    // later. Computed here rather than returned as "1" so the very first render
    // is already truthful.
    const withNew = [...queue, inserted];
    const position = queuePosition(
      withNew.map((entry) => ({
        id: entry.id,
        status: entry.status,
        joinedAt: entry.joinedAt,
        calledAt: entry.calledAt,
      })),
      inserted.id,
      policy,
    );

    return {
      ticket: toCustomerTicket(inserted, position, policy, now),
      message: `已取號 ${inserted.ticketNo}，前方約有 ${position.ahead} 組客人，預計等候 ${quotedMinutes} 分鐘。`,
    };
  }

  /**
   * Insert, computing the ticket number inside the transaction.
   *
   * The retry loop exists because the unique key `(merchantId, serviceDate,
   * ticketNo)` is the only thing that can actually prevent a duplicate — two
   * transactions can read the same sequence value before either writes. When
   * the constraint fires, the right response is to read again and issue the
   * next number, not to fail: from the guest's point of view the button simply
   * worked.
   */
  private async insertWithTicket(
    merchantId: string,
    timezone: string,
    serviceDate: Date,
    data: {
      partySize: number;
      guestName: string;
      contactPhone: string;
      note: string | null;
      quotedMinutes: number;
    },
  ) {
    let lastError: unknown;

    for (let attempt = 0; attempt < TakeNumberUseCase.MAX_TICKET_RETRIES; attempt += 1) {
      try {
        return await this.prisma.runInTransaction(async (tx) => {
          const issued = await this.waitlist.ticketNumbersForDay(merchantId, serviceDate);
          const ticketNo = nextTicketNo(issued, dayLetterFor(localDateString(timezone, serviceDate)));

          return this.waitlist.insertEntry(tx, {
            merchantId,
            ticketNo,
            serviceDate,
            partySize: data.partySize,
            guestName: data.guestName,
            contactPhone: data.contactPhone,
            note: data.note,
            quotedMinutes: data.quotedMinutes,
          });
        });
      } catch (error) {
        lastError = error;
        if (!isUniqueViolation(error)) throw error;
        this.logger.warn(
          `Ticket sequence clash for ${merchantId} on ${serviceDate.toISOString().slice(0, 10)}, retrying (${attempt + 1})`,
        );
      }
    }

    throw new ConcurrentWaitlistModificationError(merchantId, String(lastError));
  }
}

/** Prisma's unique-constraint code. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

function partySizeLabel(partySize: number): string {
  return `${partySize} 人`;
}

export { WAITLIST_STATUS_LABEL, WaitlistActor, WaitlistStatus };
