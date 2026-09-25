import { Injectable } from '@nestjs/common';
import {
  OrderActorType as PrismaActorType,
  Prisma,
  ReservationStatus as PrismaReservationStatus,
} from '@prisma/client';
import {
  DEFAULT_RESERVATION_POLICY,
  ReservationActor,
  ReservationPolicy,
  ReservationStatus,
} from '@takeout/domain';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  BookableMerchant,
  CreateReservationData,
  PersistedReservation,
  PersistedSettingsInput,
  ReservationRepositoryPort,
  ReservationStatusPatch,
  ResolvedSettings,
  SlotOccupancyRow,
} from '../domain/reservation.repository.port';

/** Domain enum <-> Prisma enum. Same string values, different TS types. */
const toPrismaStatus = (status: ReservationStatus): PrismaReservationStatus =>
  status as unknown as PrismaReservationStatus;
const fromPrismaStatus = (status: PrismaReservationStatus): ReservationStatus =>
  status as unknown as ReservationStatus;
const toPrismaActor = (actor: ReservationActor): PrismaActorType =>
  actor as unknown as PrismaActorType;

/**
 * Prisma-backed reservation book.
 *
 * The concurrency story mirrors `PrismaOrderRepository` deliberately: a
 * conditional `UPDATE` whose row count *is* the answer, rather than a
 * read-then-write that two requests can both pass.
 *
 * NOTE ON IDENTIFIERS: Prisma emits camelCase column names for any field
 * without an explicit `@map`, so hand-written SQL must quote them
 * (`"slotStart"`). Only table names are snake_case, via `@@map`.
 */
@Injectable()
export class PrismaReservationRepository implements ReservationRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async findBookableMerchant(merchantId: string): Promise<BookableMerchant | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, name: true, slug: true, timezone: true, status: true },
    });
    return this.toBookableMerchant(merchant);
  }

  async findBookableMerchantBySlug(slug: string): Promise<BookableMerchant | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, timezone: true, status: true },
    });
    return this.toBookableMerchant(merchant);
  }

  /**
   * A merchant that is not `ACTIVE` is not bookable.
   *
   * `findBookableMerchantBySlug` in particular serves an unauthenticated
   * endpoint, so this is the line that stops a `DRAFT` shop's half-built
   * profile from being bookable because somebody guessed its slug.
   */
  private toBookableMerchant(
    merchant: {
      id: string;
      name: string;
      slug: string;
      timezone: string;
      status: string;
    } | null,
  ): BookableMerchant | null {
    if (!merchant || merchant.status !== 'ACTIVE') return null;
    return {
      id: merchant.id,
      name: merchant.name,
      slug: merchant.slug,
      timezone: merchant.timezone,
      status: merchant.status,
    };
  }

  /**
   * Settings -> defaults, never a `null`.
   *
   * The fallback is the whole point: `DEFAULT_RESERVATION_POLICY.enabled` is
   * false, so a merchant who never opened the settings screen simply has the
   * feature off — which is the correct behaviour and also the one a missing row
   * cannot accidentally turn into "accept everything".
   */
  async findSettings(merchantId: string): Promise<ResolvedSettings> {
    const row = await this.prisma.reservationSettings.findUnique({ where: { merchantId } });
    return this.toResolvedSettings(row);
  }

  private toResolvedSettings(
    row: {
      enabled: boolean;
      autoConfirm: boolean;
      slotMinutes: number;
      turnMinutes: number;
      seatsPerSlot: number;
      minPartySize: number;
      maxPartySize: number;
      leadTimeMinutes: number;
      advanceDays: number;
      customerNotice: string | null;
    } | null,
  ): ResolvedSettings {
    if (!row) {
      return {
        policy: { ...DEFAULT_RESERVATION_POLICY },
        customerNotice: null,
        acceptingNew: false,
      };
    }

    const policy: ReservationPolicy = {
      enabled: row.enabled,
      autoConfirm: row.autoConfirm,
      slotMinutes: row.slotMinutes,
      turnMinutes: row.turnMinutes,
      seatsPerSlot: row.seatsPerSlot,
      minPartySize: row.minPartySize,
      maxPartySize: row.maxPartySize,
      leadTimeMinutes: row.leadTimeMinutes,
      advanceDays: row.advanceDays,
    };

    return {
      policy,
      customerNotice: row.customerNotice,
      // Derived from `enabled` today. Kept as its own field so the day a shop
      // needs "open the book but stop taking new parties" the read model
      // already has somewhere to put it.
      acceptingNew: row.enabled,
    };
  }

  async findOccupancy(
    merchantId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<readonly SlotOccupancyRow[]> {
    const rows = await this.prisma.reservationSlot.findMany({
      where: {
        merchantId,
        // Exclusive end: a day query must not pull in the next day's first slot.
        slotStart: { gte: windowStart, lt: windowEnd },
      },
      select: { slotStart: true, booked: true },
      orderBy: { slotStart: 'asc' },
    });

    return rows.map((row) => ({ startsAt: row.slotStart, booked: row.booked }));
  }

  /**
   * One conditional upsert per occupied start-slot.
   *
   * `INSERT ... ON CONFLICT DO UPDATE ... WHERE` is the whole concurrency
   * answer: the row is created on first use and incremented only when the
   * resulting total still fits. `affected = 0` means this slot is full, and
   * because the caller's transaction rolls back on a `false` return, the
   * earlier slots in the same booking are released with it — the hold is
   * all-or-nothing without needing a manual undo.
   *
   * `seatsPerSlot` is passed in rather than read here because it comes from
   * `ReservationSettings`, which the caller has already resolved. Reading it
   * again inside the statement would make the capacity depend on a second read
   * that a concurrent settings change could move between the two.
   */
  async holdSlots(
    tx: Prisma.TransactionClient,
    merchantId: string,
    slotStarts: readonly Date[],
    seats: number,
    seatsPerSlot: number,
  ): Promise<boolean> {
    for (const slotStart of slotStarts) {
      // The `WHERE` on the DO UPDATE clause is the guard: it re-checks the
      // post-increment value, which a plain ON CONFLICT cannot express.
      const affected = await tx.$executeRaw`
        INSERT INTO reservation_slots (id, "merchantId", "slotStart", booked, "updatedAt")
        VALUES (gen_random_uuid(), ${merchantId}::uuid, ${slotStart}, ${seats}, now())
        ON CONFLICT ("merchantId", "slotStart") DO UPDATE
           SET booked = reservation_slots.booked + ${seats},
               "updatedAt" = now()
         WHERE reservation_slots.booked + ${seats} <= ${seatsPerSlot}
      `;

      if (affected === 0) return false;
    }
    return true;
  }

  /**
   * `GREATEST(booked - n, 0)` rather than a bare subtraction.
   *
   * A replayed transition must not drive `booked` negative — that would make
   * the book look emptier than it is and hand the same table out twice. Clamping
   * keeps the anomaly visible in the number instead of throwing inside a
   * release, which would roll back the status change the customer is waiting on.
   */
  async releaseSlots(
    tx: Prisma.TransactionClient,
    merchantId: string,
    slotStarts: readonly Date[],
    seats: number,
  ): Promise<void> {
    for (const slotStart of slotStarts) {
      await tx.$executeRaw`
        UPDATE reservation_slots
           SET booked = GREATEST(booked - ${seats}, 0),
               "updatedAt" = now()
         WHERE "merchantId" = ${merchantId}::uuid
           AND "slotStart" = ${slotStart}
      `;
    }
  }

  /**
   * Serialise the per-merchant-per-day counter with an advisory transaction
   * lock, exactly as the pickup code does — two simultaneous bookings must not
   * both be told they are `R-0007`.
   *
   * Counts *all* reservations for the day, terminal ones included: the number
   * is an identifier, not a measure of how full the book is, and reusing a
   * cancelled booking's number would make two customers hold the same reference.
   */
  async nextReservationSequence(
    tx: Prisma.TransactionClient,
    merchantId: string,
    serviceDate: Date,
  ): Promise<number> {
    const dateKey = serviceDate.toISOString().slice(0, 10);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`res:${merchantId}:${dateKey}`}))`;

    const used = await tx.reservation.count({ where: { merchantId, serviceDate } });
    return used + 1;
  }

  async insertReservation(
    tx: Prisma.TransactionClient,
    data: CreateReservationData,
  ): Promise<PersistedReservation> {
    const reservation = await tx.reservation.create({
      data: {
        reservationNo: data.reservationNo,
        customerId: data.customerId,
        merchantId: data.merchantId,
        status: toPrismaStatus(data.status),
        partySize: data.partySize,
        startsAt: data.startsAt,
        turnMinutes: data.turnMinutes,
        serviceDate: data.serviceDate,
        customerName: data.customerName,
        contactPhone: data.contactPhone,
        customerNote: data.customerNote,
        // An auto-confirmed booking is confirmed the moment it exists; leaving
        // `confirmedAt` null would make the board unable to tell "the shop said
        // yes" from "the system did", and the customer's page would show a
        // confirmation with no timestamp.
        ...(data.status === ReservationStatus.CONFIRMED ? { confirmedAt: new Date() } : {}),
      },
      select: reservationSelect,
    });

    return mapReservation(reservation);
  }

  async findById(reservationId: string): Promise<PersistedReservation | null> {
    const row = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: reservationSelect,
    });
    return row ? mapReservation(row) : null;
  }

  async findByIdForUpdate(
    tx: Prisma.TransactionClient,
    reservationId: string,
  ): Promise<PersistedReservation | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reservations WHERE id = ${reservationId}::uuid FOR UPDATE
    `;
    if (rows.length === 0) return null;

    const row = await tx.reservation.findUnique({
      where: { id: reservationId },
      select: reservationSelect,
    });
    return row ? mapReservation(row) : null;
  }

  /**
   * `WHERE status = expected` — the optimistic lock.
   *
   * `version` is incremented in the same statement, which is what makes the
   * outbox version monotonic without a second write: two transitions cannot
   * both read version 3 and both write 4, because the second one's `WHERE
   * status` no longer matches.
   */
  async updateStatus(
    tx: Prisma.TransactionClient,
    reservationId: string,
    expectedStatus: ReservationStatus,
    nextStatus: ReservationStatus,
    patch: ReservationStatusPatch,
  ): Promise<boolean> {
    const result = await tx.reservation.updateMany({
      where: { id: reservationId, status: toPrismaStatus(expectedStatus) },
      data: {
        status: toPrismaStatus(nextStatus),
        version: { increment: 1 },
        ...(patch.confirmedAt ? { confirmedAt: patch.confirmedAt } : {}),
        ...(patch.seatedAt ? { seatedAt: patch.seatedAt } : {}),
        ...(patch.completedAt ? { completedAt: patch.completedAt } : {}),
        ...(patch.cancelledAt ? { cancelledAt: patch.cancelledAt } : {}),
        // `!== undefined`, not truthiness: `null` is a real value here
        // ("clear the shop's note"), and a truthy check would keep the old one.
        ...(patch.statusReason !== undefined ? { statusReason: patch.statusReason } : {}),
        ...(patch.merchantNote !== undefined ? { merchantNote: patch.merchantNote } : {}),
        ...(patch.lastActor ? { lastActor: toPrismaActor(patch.lastActor) } : {}),
        ...(patch.lastActorId !== undefined ? { lastActorId: patch.lastActorId } : {}),
      },
    });
    return result.count === 1;
  }

  /**
   * Upsert the shop's book.
   *
   * Every field is written on every call — this is a PUT-shaped save from a
   * settings form that always submits the whole object, so a partial update
   * would be a way to silently keep a stale `maxPartySize` the merchant thought
   * they had changed.
   */
  async saveSettings(
    merchantId: string,
    settings: Partial<PersistedSettingsInput> & { updatedById?: string },
  ): Promise<ResolvedSettings> {
    const row = await this.prisma.reservationSettings.upsert({
      where: { merchantId },
      create: {
        merchantId,
        ...settings,
        ...(settings.updatedById ? { updatedById: settings.updatedById } : {}),
      },
      update: {
        ...settings,
        ...(settings.updatedById ? { updatedById: settings.updatedById } : {}),
      },
    });

    return this.toResolvedSettings(row);
  }
}

const reservationSelect = {
  id: true,
  reservationNo: true,
  merchantId: true,
  customerId: true,
  status: true,
  partySize: true,
  startsAt: true,
  turnMinutes: true,
  serviceDate: true,
  customerName: true,
  contactPhone: true,
  customerNote: true,
  merchantNote: true,
  statusReason: true,
  version: true,
  confirmedAt: true,
  seatedAt: true,
  completedAt: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function mapReservation(row: {
  id: string;
  reservationNo: string;
  merchantId: string;
  customerId: string;
  status: PrismaReservationStatus;
  partySize: number;
  startsAt: Date;
  turnMinutes: number;
  serviceDate: Date;
  customerName: string;
  contactPhone: string;
  customerNote: string | null;
  merchantNote: string | null;
  statusReason: string | null;
  version: number;
  confirmedAt: Date | null;
  seatedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PersistedReservation {
  return {
    id: row.id,
    reservationNo: row.reservationNo,
    merchantId: row.merchantId,
    customerId: row.customerId,
    status: fromPrismaStatus(row.status),
    partySize: row.partySize,
    startsAt: row.startsAt,
    turnMinutes: row.turnMinutes,
    serviceDate: row.serviceDate,
    customerName: row.customerName,
    contactPhone: row.contactPhone,
    customerNote: row.customerNote,
    merchantNote: row.merchantNote,
    statusReason: row.statusReason,
    version: row.version,
    confirmedAt: row.confirmedAt,
    seatedAt: row.seatedAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
