import { Injectable } from '@nestjs/common';
import { DiningSessionStatus as PrismaDiningSessionStatus, Prisma } from '@prisma/client';
import { DiningSessionStatus, DiningTableCodeTakenError } from '@takeout/domain';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  DiningRepositoryPort,
  DiningTableWithSession,
  PersistedDiningSession,
  PersistedDiningTable,
  ScannedTable,
  SessionOrderSummary,
} from '../domain/dining.repository.port';

/** Domain enum <-> Prisma enum. Same strings, different TS types. */
const fromPrismaStatus = (status: PrismaDiningSessionStatus): DiningSessionStatus =>
  status as unknown as DiningSessionStatus;

const tableFields = {
  id: true,
  merchantId: true,
  code: true,
  label: true,
  seats: true,
  isActive: true,
  qrToken: true,
  createdAt: true,
  updatedAt: true,
} as const;

const sessionFields = {
  id: true,
  merchantId: true,
  tableId: true,
  status: true,
  partySize: true,
  serviceDate: true,
  guestToken: true,
  guestCustomerId: true,
  openedAt: true,
  closedAt: true,
  closedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Prisma-backed floor plan.
 *
 * NOTE ON IDENTIFIERS: Prisma emits camelCase column names for any field
 * without an explicit `@map`, so hand-written SQL must quote them. Only table
 * names are snake_case, via `@@map`.
 *
 * The tab total is summed in SQL rather than by loading the orders: a table
 * that has been ordering all evening should not make the board fetch a hundred
 * rows to display one number. Same reasoning as `AnalyticsService`.
 */
@Injectable()
export class PrismaDiningRepository implements DiningRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async listTables(merchantId: string): Promise<readonly DiningTableWithSession[]> {
    const rows = await this.prisma.diningTable.findMany({
      where: { merchantId },
      orderBy: { code: 'asc' },
      select: {
        ...tableFields,
        // Only the OPEN one. `sessions` ordered by `openedAt` with a `take: 1`
        // would return the MOST RECENT sitting, which on a table turned around
        // three times tonight is a closed one — and the board would show a
        // table as busy when it is free.
        sessions: {
          where: { status: PrismaDiningSessionStatus.OPEN },
          take: 1,
          select: sessionFields,
        },
      },
    });

    return rows.map((row) => ({
      ...toTable(row),
      openSession: row.sessions[0] ? toSession(row.sessions[0]) : null,
    }));
  }

  async findTable(merchantId: string, tableId: string): Promise<PersistedDiningTable | null> {
    const row = await this.prisma.diningTable.findFirst({
      where: { id: tableId, merchantId },
      select: tableFields,
    });
    return row ? toTable(row) : null;
  }

  async findTableByCode(merchantId: string, code: string): Promise<PersistedDiningTable | null> {
    const row = await this.prisma.diningTable.findUnique({
      where: { merchantId_code: { merchantId, code } },
      select: tableFields,
    });
    return row ? toTable(row) : null;
  }

  /**
   * Resolve a scanned token.
   *
   * One query, joining the merchant, because the QR page has ONLY the token —
   * everything it renders (which shop, which table, is there a sitting already)
   * has to come back from this single call or the page flashes empty before it
   * can render.
   */
  async findByQrToken(qrToken: string): Promise<ScannedTable | null> {
    const row = await this.prisma.diningTable.findUnique({
      where: { qrToken },
      select: {
        ...tableFields,
        merchant: { select: { id: true, name: true, slug: true, timezone: true, status: true } },
        sessions: {
          where: { status: PrismaDiningSessionStatus.OPEN },
          take: 1,
          select: sessionFields,
        },
      },
    });
    if (!row) return null;

    return {
      table: toTable(row),
      merchant: row.merchant,
      openSession: row.sessions[0] ? toSession(row.sessions[0]) : null,
    };
  }

  /**
   * Resolve a one-time sitting token.
   *
   * Same single-query shape as `findByQrToken` — the guest's phone holds only
   * this token, so the response has to carry everything the page renders.
   */
  async findByGuestToken(guestToken: string): Promise<ScannedTable | null> {
    const row = await this.prisma.diningSession.findUnique({
      where: { guestToken },
      select: {
        ...sessionFields,
        table: { select: tableFields },
        merchant: { select: { id: true, name: true, slug: true, timezone: true, status: true } },
      },
    });
    if (!row) return null;

    return {
      table: toTable(row.table),
      merchant: row.merchant,
      openSession: row.status === PrismaDiningSessionStatus.OPEN ? toSession(row) : null,
    };
  }

  async findGuestCustomer(sessionId: string): Promise<string | null> {
    const row = await this.prisma.diningSession.findUnique({
      where: { id: sessionId },
      select: { guestCustomerId: true },
    });
    return row?.guestCustomerId ?? null;
  }

  async attachGuestCustomer(sessionId: string, guestCustomerId: string): Promise<void> {
    await this.prisma.diningSession.updateMany({
      where: { id: sessionId, guestCustomerId: null },
      data: { guestCustomerId },
    });
  }

  async createTable(
    tx: Prisma.TransactionClient,
    data: {
      merchantId: string;
      code: string;
      label: string | null;
      seats: number;
      isActive: boolean;
      qrToken: string;
    },
  ): Promise<PersistedDiningTable> {
    try {
      const row = await tx.diningTable.create({ data, select: tableFields });
      return toTable(row);
    } catch (error) {
      // `@@unique([merchantId, code])` is the real guard; this turns its
      // violation into the refusal the shop should see. The code has already
      // been canonicalised by the use case, so the collision this catches is
      // exactly "you already have a table called A12".
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new DiningTableCodeTakenError(data.code);
      }
      throw error;
    }
  }

  async updateTable(
    merchantId: string,
    tableId: string,
    data: {
      label?: string | null;
      seats?: number;
      isActive?: boolean;
      qrToken?: string;
    },
  ): Promise<PersistedDiningTable | null> {
    // Scoped by merchant in the WHERE, not checked after the write: an owner
    // who guesses another shop's table id must not be able to switch it off.
    const existing = await this.prisma.diningTable.findFirst({
      where: { id: tableId, merchantId },
      select: { id: true },
    });
    if (!existing) return null;

    const row = await this.prisma.diningTable.update({
      where: { id: tableId },
      data: {
        ...(data.label !== undefined ? { label: data.label } : {}),
        ...(data.seats !== undefined ? { seats: data.seats } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.qrToken !== undefined ? { qrToken: data.qrToken } : {}),
      },
      select: tableFields,
    });
    return toTable(row);
  }

  async findOpenSession(
    tx: Prisma.TransactionClient | null,
    tableId: string,
  ): Promise<PersistedDiningSession | null> {
    const client = tx ?? this.prisma;
    const row = await client.diningSession.findFirst({
      where: { tableId, status: PrismaDiningSessionStatus.OPEN },
      orderBy: { openedAt: 'desc' },
      select: sessionFields,
    });
    return row ? toSession(row) : null;
  }

  async findSessionById(sessionId: string): Promise<PersistedDiningSession | null> {
    const row = await this.prisma.diningSession.findUnique({
      where: { id: sessionId },
      select: sessionFields,
    });
    return row ? toSession(row) : null;
  }

  async findSessionForUpdate(
    tx: Prisma.TransactionClient,
    sessionId: string,
  ): Promise<PersistedDiningSession | null> {
    // `FOR UPDATE` serialises "close this table" against "add one more round to
    // it" — the two writes a host and a guest genuinely race on.
    const rows = await tx.$queryRaw<(PersistedDiningSession & { status: string })[]>`
      SELECT
        id, "merchantId", "tableId", status, "partySize", "serviceDate",
        "guestToken", "guestCustomerId",
        "openedAt", "closedAt", "closedById", version, "createdAt", "updatedAt"
      FROM "dining_sessions"
      WHERE id = ${sessionId}::uuid
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return toSession({ ...row, status: fromPrismaStatus(row.status as PrismaDiningSessionStatus) });
  }

  async openSession(
    tx: Prisma.TransactionClient,
    data: {
      merchantId: string;
      tableId: string;
      partySize: number | null;
      serviceDate: Date;
      guestToken: string;
    },
  ): Promise<PersistedDiningSession> {
    const row = await tx.diningSession.create({
      data: {
        merchantId: data.merchantId,
        tableId: data.tableId,
        partySize: data.partySize,
        serviceDate: data.serviceDate,
        guestToken: data.guestToken,
        status: DiningSessionStatus.OPEN,
      },
      select: sessionFields,
    });
    return toSession(row);
  }

  async closeSession(
    tx: Prisma.TransactionClient,
    sessionId: string,
    expectedStatus: DiningSessionStatus,
    nextStatus: DiningSessionStatus,
    closedById: string | null,
  ): Promise<boolean> {
    // `version` is bumped on the same UPDATE as the status, so the board's poll
    // sees a change and the outbox payload and the row cannot disagree.
    const result = await tx.diningSession.updateMany({
      where: {
        id: sessionId,
        status: expectedStatus as unknown as PrismaDiningSessionStatus,
      },
      data: {
        status: nextStatus as unknown as PrismaDiningSessionStatus,
        closedAt: new Date(),
        closedById,
        version: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  /**
   * The table's running tab.
   *
   * Which statuses count is the one decision this method makes, and it differs
   * from the collection flow in exactly one place:
   *
   *   - **`PENDING_PAYMENT` IS included.** For a pickup order, unpaid means the
   *     food is not being made yet, so it is not on a bill. For a dine-in round
   *     it is the opposite: the guest is SITTING THERE and the food was ordered
   *     — the money is settled on the whole tab at the end, so an unpaid round
   *     is the normal state of every round until the bill. Excluding it would
   *     show a seated guest an empty tab the moment after they ordered.
   *   - `REJECTED` / `CANCELLED` / `EXPIRED` are excluded: a round the shop
   *     refused, or one that timed out, is not food the guest owes for.
   *   - **`REFUNDED` is INCLUDED.** The dish was served; the refund is a
   *     separate settlement the shop and the guest arrange directly — the same
   *     principle as the refund-ticket flow, which never touches this ledger.
   */
  async listSessionOrders(sessionId: string): Promise<readonly SessionOrderSummary[]> {
    const rows = await this.prisma.order.findMany({
      where: {
        diningSessionId: sessionId,
        status: { notIn: ['REJECTED', 'CANCELLED', 'EXPIRED'] as never[] },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        orderNo: true,
        status: true,
        totalMinor: true,
        merchantPayoutMinor: true,
        mainItemCount: true,
        createdAt: true,
      },
    });

    return rows.map((row) => ({
      orderId: row.id,
      orderNo: row.orderNo,
      status: row.status,
      totalMinor: row.totalMinor,
      merchantPayoutMinor: row.merchantPayoutMinor,
      itemCount: row.mainItemCount,
      createdAt: row.createdAt,
    }));
  }
}

function toTable(row: {
  id: string;
  merchantId: string;
  code: string;
  label: string | null;
  seats: number;
  isActive: boolean;
  qrToken: string;
  createdAt: Date;
  updatedAt: Date;
}): PersistedDiningTable {
  return { ...row };
}

function toSession(row: {
  id: string;
  merchantId: string;
  tableId: string;
  status: PrismaDiningSessionStatus;
  partySize: number | null;
  serviceDate: Date;
  guestToken: string | null;
  guestCustomerId: string | null;
  openedAt: Date;
  closedAt: Date | null;
  closedById: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): PersistedDiningSession {
  return { ...row, status: fromPrismaStatus(row.status) };
}
