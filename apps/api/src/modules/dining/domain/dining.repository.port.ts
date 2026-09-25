import { Prisma } from '@prisma/client';
import { DiningSessionStatus } from '@takeout/domain';

/**
 * Persistence port for 店內點餐 — tables and sittings.
 *
 * `DiningTable` and `DiningSession` share one port rather than pretending to be
 * two aggregates. The reason is that a table has no meaning on this side of the
 * boundary without its sitting: the code printed on the QR is only useful in
 * order to open one, and a table row by itself answers no question anybody
 * asks. Splitting them would produce two ports that are always injected
 * together.
 *
 * What is NOT here, deliberately: any write to `orders`. An in-store order is
 * created by `PlaceOrderUseCase` through `OrderRepositoryPort` like every other
 * order, and reaching into that table from here would be exactly the
 * cross-context write the per-module ports exist to prevent.
 */

/** A table, as the merchant's floor plan manages it. */
export interface PersistedDiningTable {
  readonly id: string;
  readonly merchantId: string;
  /** What is printed on the QR, e.g. `A12`. Unique per shop. */
  readonly code: string;
  readonly label: string | null;
  readonly seats: number;
  readonly isActive: boolean;
  /** Opaque, rotatable token embedded in the QR URL. */
  readonly qrToken: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A table with its live sitting, if any. Drives the merchant's table board. */
export interface DiningTableWithSession extends PersistedDiningTable {
  readonly openSession: PersistedDiningSession | null;
}

/** One sitting at one table. */
export interface PersistedDiningSession {
  readonly id: string;
  readonly merchantId: string;
  readonly tableId: string;
  readonly status: DiningSessionStatus;
  readonly partySize: number | null;
  readonly serviceDate: Date;
  /** 一次性入座碼 — the token the guest's ordering session is keyed on. */
  readonly guestToken: string | null;
  /** The lightweight guest identity this sitting's orders belong to. */
  readonly guestCustomerId: string | null;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly closedById: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The guest's view of a scanned table: the table, and its sitting if open. */
export interface ScannedTable {
  readonly table: PersistedDiningTable;
  readonly merchant: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly timezone: string;
    readonly status: string;
  };
  readonly openSession: PersistedDiningSession | null;
}

export interface DiningRepositoryPort {
  /** Every table for a shop, with each one's live sitting. */
  listTables(merchantId: string): Promise<readonly DiningTableWithSession[]>;

  findTable(merchantId: string, tableId: string): Promise<PersistedDiningTable | null>;

  /** By the human code printed on the label, normalised to uppercase. */
  findTableByCode(merchantId: string, code: string): Promise<PersistedDiningTable | null>;

  /**
   * Resolve a scanned QR token.
   *
   * Returns the merchant too, because the QR page has nothing else to go on —
   * the token is the entire payload, so this one read has to produce everything
   * the page needs or the page needs a second round-trip before it can render.
   */
  findByQrToken(qrToken: string): Promise<ScannedTable | null>;

  /**
   * Resolve a one-time sitting token.
   *
   * The static table QR only ever OPENS a sitting; it never carries ordering
   * authority. Ordering is keyed on the per-sitting `guestToken` minted at
   * open, so a stale photo of a table code cannot add a round to somebody
   * else's bill.
   */
  findByGuestToken(guestToken: string): Promise<ScannedTable | null>;

  /** The guest identity this sitting's orders are attributed to. */
  findGuestCustomer(sessionId: string): Promise<string | null>;

  createTable(
    tx: Prisma.TransactionClient,
    data: {
      merchantId: string;
      code: string;
      label: string | null;
      seats: number;
      isActive: boolean;
      qrToken: string;
    },
  ): Promise<PersistedDiningTable>;

  updateTable(
    merchantId: string,
    tableId: string,
    data: {
      label?: string | null;
      seats?: number;
      isActive?: boolean;
      qrToken?: string;
    },
  ): Promise<PersistedDiningTable | null>;

  /**
   * The table's current open sitting, or `null`.
   *
   * Read under the caller's transaction on the open path, because "is there
   * already a sitting here" and "create one" have to be one atomic step or two
   * simultaneous scans open two.
   */
  findOpenSession(
    tx: Prisma.TransactionClient | null,
    tableId: string,
  ): Promise<PersistedDiningSession | null>;

  findSessionById(sessionId: string): Promise<PersistedDiningSession | null>;

  findSessionForUpdate(
    tx: Prisma.TransactionClient,
    sessionId: string,
  ): Promise<PersistedDiningSession | null>;

  openSession(
    tx: Prisma.TransactionClient,
    data: {
      merchantId: string;
      tableId: string;
      partySize: number | null;
      serviceDate: Date;
      /** The one-time token minted for this sitting. */
      guestToken: string;
    },
  ): Promise<PersistedDiningSession>;

  /** Record the provisioned guest identity once the first round is placed. */
  attachGuestCustomer(
    sessionId: string,
    guestCustomerId: string,
  ): Promise<void>;

  /** Optimistic close: `WHERE id = ? AND status = ?`. */
  closeSession(
    tx: Prisma.TransactionClient,
    sessionId: string,
    expectedStatus: DiningSessionStatus,
    nextStatus: DiningSessionStatus,
    closedById: string | null,
  ): Promise<boolean>;

  /**
   * The orders a table has placed this sitting — the running tab.
   *
   * Returns only ids and money: the kitchen board and the tab header need the
   * total, and pulling every line into memory to add it up is the same mistake
   * the analytics service was written to fix.
   *
   * Includes `PENDING_PAYMENT` — a dine-in round is on the tab from the moment
   * it is sent, because the money is settled on the whole bill at the end.
   */
  listSessionOrders(
    sessionId: string,
  ): Promise<readonly SessionOrderSummary[]>;
}

/** One order on a table's tab. */
export interface SessionOrderSummary {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: string;
  readonly totalMinor: number;
  readonly merchantPayoutMinor: number;
  readonly itemCount: number;
  readonly createdAt: Date;
}
