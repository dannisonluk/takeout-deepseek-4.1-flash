import { Injectable } from '@nestjs/common';
import { Prisma, WaitlistStatus as PrismaWaitlistStatus } from '@prisma/client';
import { DEFAULT_WAITLIST_POLICY, WaitlistPolicy, WaitlistStatus } from '@takeout/domain';
import { checkOpening, OperatingWindow } from '../../../common/time/pickup-policy';
import { localDateString } from '../../../common/time/service-date';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  CreateWaitlistEntryData,
  PersistedWaitlistEntry,
  PersistedWaitlistSettingsInput,
  QueueMerchant,
  ResolvedWaitlistSettings,
  WaitlistRepositoryPort,
  WaitlistStatusPatch,
} from '../domain/waitlist.repository.port';

/** Domain enum <-> Prisma enum. Same strings, different TS types. */
const toPrismaStatus = (status: WaitlistStatus): PrismaWaitlistStatus =>
  status as unknown as PrismaWaitlistStatus;
const fromPrismaStatus = (status: PrismaWaitlistStatus): WaitlistStatus =>
  status as unknown as WaitlistStatus;

const entryFields = {
  id: true,
  merchantId: true,
  ticketNo: true,
  serviceDate: true,
  status: true,
  partySize: true,
  guestName: true,
  contactPhone: true,
  note: true,
  joinedAt: true,
  quotedMinutes: true,
  calledAt: true,
  seatedAt: true,
  completedAt: true,
  cancelledAt: true,
  statusReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Prisma-backed walk-in queue.
 *
 * NOTE ON IDENTIFIERS: Prisma emits camelCase column names for any field
 * without an explicit `@map`, so hand-written SQL must quote them. Only table
 * names are snake_case, via `@@map`.
 *
 * The concurrency story mirrors `PrismaReservationRepository` deliberately: a
 * conditional `UPDATE` whose row count *is* the answer, rather than a
 * read-then-write that two hosts can both pass.
 */
@Injectable()
export class PrismaWaitlistRepository implements WaitlistRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findQueueMerchant(merchantId: string): Promise<QueueMerchant | null> {
    return this.toQueueMerchant(
      await this.prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, name: true, slug: true, timezone: true, status: true },
      }),
    );
  }

  async findQueueMerchantBySlug(slug: string): Promise<QueueMerchant | null> {
    return this.toQueueMerchant(
      await this.prisma.merchant.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true, timezone: true, status: true },
      }),
    );
  }

  /**
   * A merchant that is not `ACTIVE` has no queue.
   *
   * `findQueueMerchantBySlug` serves an unauthenticated page, so this is the
   * line that stops a `DRAFT` shop's take-a-number screen from working because
   * somebody guessed its slug.
   */
  private toQueueMerchant(
    merchant: {
      id: string;
      name: string;
      slug: string;
      timezone: string;
      status: string;
    } | null,
  ): QueueMerchant | null {
    if (!merchant || merchant.status !== 'ACTIVE') return null;
    return merchant;
  }

  /**
   * Settings -> defaults, never a `null`.
   *
   * `DEFAULT_WAITLIST_POLICY.enabled` is false, so a merchant who never opened
   * the settings screen simply has the queue off — which is the correct
   * behaviour and also the one a missing row cannot accidentally turn into
   * "start handing out numbers".
   *
   * `openNow` is computed here rather than by the caller because the opening
   * rule — weekly pattern AND 特別休息日 override — already exists once in
   * `checkOpening`, and a second implementation in the waitlist context would
   * disagree with the booking page the first time the shop closed a day.
   */
  async findSettings(merchantId: string, now: Date = new Date()): Promise<ResolvedWaitlistSettings> {
    const row = await this.prisma.waitlistSettings.findUnique({ where: { merchantId } });
    const policy = this.toPolicy(row);
    return { policy, openNow: await this.isOpenNow(merchantId, now) };
  }

  private toPolicy(
    row: {
      enabled: boolean;
      acceptWhenClosed: boolean;
      minPartySize: number;
      maxPartySize: number;
      averageTurnMinutes: number;
      callTimeoutMinutes: number;
      customerNotice: string | null;
    } | null,
  ): WaitlistPolicy {
    if (!row) return { ...DEFAULT_WAITLIST_POLICY };
    return {
      enabled: row.enabled,
      acceptWhenClosed: row.acceptWhenClosed,
      minPartySize: row.minPartySize,
      maxPartySize: row.maxPartySize,
      averageTurnMinutes: row.averageTurnMinutes,
      callTimeoutMinutes: row.callTimeoutMinutes,
      customerNotice: row.customerNotice,
    };
  }

  /** The shop's weekly hours, minus any dated closure covering `at`. */
  private async isOpenNow(merchantId: string, at: Date): Promise<boolean> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        timezone: true,
        hours: {
          select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
        },
      },
    });
    if (!merchant) return false;

    const today = localDateString(merchant.timezone, at);
    const closure = await this.prisma.merchantClosure.findUnique({
      where: { merchantId_serviceDate: { merchantId, serviceDate: new Date(`${today}T00:00:00.000Z`) } },
      select: { id: true },
    });

    const closures = closure ? new Set([today]) : undefined;
    return checkOpening(merchant.hours as OperatingWindow[], merchant.timezone, at, closures).open;
  }

  async listForDay(
    merchantId: string,
    serviceDate: Date,
    statuses?: readonly WaitlistStatus[],
  ): Promise<readonly PersistedWaitlistEntry[]> {
    const rows = await this.prisma.waitlistEntry.findMany({
      where: {
        merchantId,
        serviceDate,
        ...(statuses && statuses.length > 0
          ? { status: { in: statuses.map(toPrismaStatus) } }
          : {}),
      },
      orderBy: { joinedAt: 'asc' },
      select: entryFields,
    });
    return rows.map(toEntry);
  }

  async listActive(
    merchantId: string,
    serviceDate: Date,
  ): Promise<readonly PersistedWaitlistEntry[]> {
    return this.listForDay(merchantId, serviceDate, [
      WaitlistStatus.WAITING,
      WaitlistStatus.CALLED,
    ]);
  }

  async findById(entryId: string): Promise<PersistedWaitlistEntry | null> {
    const row = await this.prisma.waitlistEntry.findUnique({
      where: { id: entryId },
      select: entryFields,
    });
    return row ? toEntry(row) : null;
  }

  async findByIdForUpdate(
    tx: Prisma.TransactionClient,
    entryId: string,
  ): Promise<PersistedWaitlistEntry | null> {
    // `FOR UPDATE` serialises concurrent transitions on this row. Two hosts
    // tapping "call" on the same ticket at the same moment is the ordinary
    // case on a busy Friday, not an exotic race.
    const rows = await tx.$queryRaw<(PersistedWaitlistEntry & { status: string })[]>`
      SELECT
        id, "merchantId", "ticketNo", "serviceDate", status, "partySize",
        "guestName", "contactPhone", note, "joinedAt", "quotedMinutes",
        "calledAt", "seatedAt", "completedAt", "cancelledAt", "statusReason",
        version, "createdAt", "updatedAt"
      FROM "waitlist_entries"
      WHERE id = ${entryId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return toEntry({ ...row, status: fromPrismaStatus(row.status as PrismaWaitlistStatus) });
  }

  async findActiveForPhone(
    merchantId: string,
    phone: string,
    serviceDate: Date,
  ): Promise<PersistedWaitlistEntry | null> {
    const row = await this.prisma.waitlistEntry.findFirst({
      where: {
        merchantId,
        contactPhone: phone,
        serviceDate,
        status: {
          in: [WaitlistStatus.WAITING, WaitlistStatus.CALLED].map(toPrismaStatus),
        },
      },
      orderBy: { joinedAt: 'desc' },
      select: entryFields,
    });
    return row ? toEntry(row) : null;
  }

  async ticketNumbersForDay(merchantId: string, serviceDate: Date): Promise<readonly string[]> {
    const rows = await this.prisma.waitlistEntry.findMany({
      where: { merchantId, serviceDate },
      select: { ticketNo: true },
    });
    return rows.map((row) => row.ticketNo);
  }

  async insertEntry(
    tx: Prisma.TransactionClient,
    data: CreateWaitlistEntryData,
  ): Promise<PersistedWaitlistEntry> {
    const row = await tx.waitlistEntry.create({
      data: {
        merchantId: data.merchantId,
        ticketNo: data.ticketNo,
        serviceDate: data.serviceDate,
        partySize: data.partySize,
        guestName: data.guestName,
        contactPhone: data.contactPhone,
        note: data.note,
        quotedMinutes: data.quotedMinutes,
        status: WaitlistStatus.WAITING,
      },
      select: entryFields,
    });
    return toEntry(row);
  }

  async updateStatus(
    tx: Prisma.TransactionClient,
    entryId: string,
    expectedStatus: WaitlistStatus,
    nextStatus: WaitlistStatus,
    patch: WaitlistStatusPatch,
  ): Promise<boolean> {
    // `version` is bumped in the same `UPDATE`, which is what makes the outbox
    // event's version equal the row's — a separate counter read would race.
    const result = await tx.waitlistEntry.updateMany({
      where: { id: entryId, status: toPrismaStatus(expectedStatus) },
      data: {
        status: toPrismaStatus(nextStatus),
        version: { increment: 1 },
        ...(patch.calledAt !== undefined ? { calledAt: patch.calledAt } : {}),
        ...(patch.seatedAt !== undefined ? { seatedAt: patch.seatedAt } : {}),
        ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
        ...(patch.cancelledAt !== undefined ? { cancelledAt: patch.cancelledAt } : {}),
        ...(patch.statusReason !== undefined ? { statusReason: patch.statusReason } : {}),
      },
    });
    return result.count === 1;
  }

  async saveSettings(
    merchantId: string,
    settings: Partial<PersistedWaitlistSettingsInput> & { updatedById?: string },
  ): Promise<ResolvedWaitlistSettings> {
    const row = await this.prisma.waitlistSettings.upsert({
      where: { merchantId },
      update: {
        ...(settings.enabled !== undefined ? { enabled: settings.enabled } : {}),
        ...(settings.acceptWhenClosed !== undefined
          ? { acceptWhenClosed: settings.acceptWhenClosed }
          : {}),
        ...(settings.minPartySize !== undefined ? { minPartySize: settings.minPartySize } : {}),
        ...(settings.maxPartySize !== undefined ? { maxPartySize: settings.maxPartySize } : {}),
        ...(settings.averageTurnMinutes !== undefined
          ? { averageTurnMinutes: settings.averageTurnMinutes }
          : {}),
        ...(settings.callTimeoutMinutes !== undefined
          ? { callTimeoutMinutes: settings.callTimeoutMinutes }
          : {}),
        ...(settings.customerNotice !== undefined ? { customerNotice: settings.customerNotice } : {}),
        ...(settings.updatedById !== undefined ? { updatedById: settings.updatedById } : {}),
      },
      create: {
        merchantId,
        enabled: settings.enabled ?? DEFAULT_WAITLIST_POLICY.enabled,
        acceptWhenClosed: settings.acceptWhenClosed ?? DEFAULT_WAITLIST_POLICY.acceptWhenClosed,
        minPartySize: settings.minPartySize ?? DEFAULT_WAITLIST_POLICY.minPartySize,
        maxPartySize: settings.maxPartySize ?? DEFAULT_WAITLIST_POLICY.maxPartySize,
        averageTurnMinutes:
          settings.averageTurnMinutes ?? DEFAULT_WAITLIST_POLICY.averageTurnMinutes,
        callTimeoutMinutes:
          settings.callTimeoutMinutes ?? DEFAULT_WAITLIST_POLICY.callTimeoutMinutes,
        customerNotice: settings.customerNotice ?? null,
        updatedById: settings.updatedById ?? null,
      },
    });

    return { policy: this.toPolicy(row), openNow: await this.isOpenNow(merchantId, new Date()) };
  }

  /**
   * Called-and-never-appeared tickets, past their deadline.
   *
   * Not scoped to a service day on purpose: a sweep that runs at 09:00 must
   * find a table called at 23:40 the previous night, and a `serviceDate =
   * today` filter would leave it in `CALLED` forever — a guest the board shows
   * as "being seated" from the day before.
   */
  async findTimedOutCalls(
    merchantId: string,
    now: Date,
    timeoutMinutes: number,
    limit: number,
  ): Promise<readonly PersistedWaitlistEntry[]> {
    const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000);
    const rows = await this.prisma.waitlistEntry.findMany({
      where: {
        merchantId,
        status: toPrismaStatus(WaitlistStatus.CALLED),
        calledAt: { not: null, lt: cutoff },
      },
      orderBy: { calledAt: 'asc' },
      take: limit,
      select: entryFields,
    });
    return rows.map(toEntry);
  }
}

function toEntry(row: {
  id: string;
  merchantId: string;
  ticketNo: string;
  serviceDate: Date;
  status: PrismaWaitlistStatus;
  partySize: number;
  guestName: string;
  contactPhone: string;
  note: string | null;
  joinedAt: Date;
  quotedMinutes: number | null;
  calledAt: Date | null;
  seatedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  statusReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): PersistedWaitlistEntry {
  return {
    id: row.id,
    merchantId: row.merchantId,
    ticketNo: row.ticketNo,
    serviceDate: row.serviceDate,
    status: fromPrismaStatus(row.status),
    partySize: row.partySize,
    guestName: row.guestName,
    contactPhone: row.contactPhone,
    note: row.note,
    joinedAt: row.joinedAt,
    quotedMinutes: row.quotedMinutes,
    calledAt: row.calledAt,
    seatedAt: row.seatedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    statusReason: row.statusReason,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
