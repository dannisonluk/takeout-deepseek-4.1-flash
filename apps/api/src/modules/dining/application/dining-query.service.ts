import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { localDateString } from '../../../common/time/service-date';
import { checkOpening, OperatingWindow } from '../../../common/time/pickup-policy';
import { DINING_REPOSITORY } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  DiningRepositoryPort,
  PersistedDiningSession,
  PersistedDiningTable,
  SessionOrderSummary,
} from '../domain/dining.repository.port';
import { DiningSessionNotFoundError, DiningTableNotFoundError } from '../domain/dining.errors';
import {
  DiningSessionTabView,
  DiningTableView,
  MerchantTableBoardView,
  ScannedTableView,
} from '../interface/dining.views';
import { toSessionSummary, toTabLine } from './dining.mapper';

/**
 * 店內點餐 — read side.
 *
 * Same CQRS split as the other contexts: reads go through Prisma directly where
 * the query is a projection, and through the port where the SAME arithmetic must
 * feed two audiences. The tab total is the case in point — the guest's running
 * bill and the host's board total have to agree to the cent, so both call
 * `summarise` rather than each summing however it likes.
 */
@Injectable()
export class DiningQueryService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DINING_REPOSITORY) private readonly dining: DiningRepositoryPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Resolve a scanned QR.
   *
   * One repository call, because the page has nothing but the token and any
   * second round-trip is a spinner in front of a hungry guest. Returns `null`
   * for an unknown token so the controller can answer 404 — a rotated code must
   * read as "this code no longer works", not as a server error.
   */
  async scanned(qrToken: string, now: Date = new Date()): Promise<ScannedTableView | null> {
    const scanned = await this.dining.findByQrToken(qrToken);
    if (!scanned) return null;

    const { table, merchant, openSession } = scanned;
    const orders = openSession ? await this.dining.listSessionOrders(openSession.id) : [];

    // The shop's own hours and dated closures, read here rather than on the
    // table row: whether the kitchen is open is a property of the shop, and
    // duplicating it onto every table would let a shop's hours change without
    // the tables following.
    const opening = await this.prisma.merchant.findUnique({
      where: { id: merchant.id },
      select: {
        hours: {
          select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
        },
        closures: { select: { serviceDate: true } },
      },
    });
    const closures = new Set(
      (opening?.closures ?? []).map((row) => row.serviceDate.toISOString().slice(0, 10)),
    );
    const openNow = checkOpening(
      (opening?.hours ?? []) as OperatingWindow[],
      merchant.timezone,
      now,
      closures,
    ).open;

    return {
      merchantId: merchant.id,
      merchantName: merchant.name,
      merchantSlug: merchant.slug,
      timezone: merchant.timezone,
      tableId: table.id,
      tableCode: table.code,
      tableLabel: table.label,
      seats: table.seats,
      // A table switched off, or a suspended shop, is not taking dine-in
      // orders — and the distinction is worth keeping: a guest at a table that
      // was deactivated mid-service should be told the table, not the shop.
      diningEnabled: table.isActive && merchant.status === 'ACTIVE',
      openNow,
      session: openSession ? toSessionSummary(openSession, table, orders, now) : null,
      qrToken: table.qrToken,
    };
  }

  /**
   * The merchant's floor plan.
   *
   * Every table comes back with its live sitting and the sitting's running
   * total, so the board can render without a per-table request — a shop with
   * thirty tables would otherwise make thirty round-trips every poll.
   */
  async board(merchantId: string, now: Date = new Date()): Promise<MerchantTableBoardView | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, timezone: true },
    });
    if (!merchant) return null;

    const tables = await this.dining.listTables(merchantId);

    // Sequential rather than Promise.all: this is a handful of tables in a
    // single shop, and fanning out one query per table would open as many
    // connections as the shop has tables to save a few milliseconds on a
    // request that already polls.
    const views: DiningTableView[] = [];
    let occupied = 0;
    let seatedGuests = 0;

    for (const table of tables) {
      let session = null;
      if (table.openSession) {
        const orders = await this.dining.listSessionOrders(table.openSession.id);
        session = toSessionSummary(table.openSession, table, orders, now);
        occupied += 1;
        seatedGuests += table.openSession.partySize ?? 0;
      }

      views.push({
        id: table.id,
        code: table.code,
        label: table.label,
        seats: table.seats,
        isActive: table.isActive,
        qrToken: table.qrToken,
        qrUrl: this.qrUrl(table.qrToken),
        session,
      });
    }

    return {
      merchantId,
      timezone: merchant.timezone,
      serviceDate: localDateString(merchant.timezone, now),
      tables: views,
      counts: {
        total: tables.length,
        active: tables.filter((table) => table.isActive).length,
        occupied,
        free: tables.filter((table) => table.isActive).length - occupied,
        seatedGuests,
      },
    };
  }

  /** The tab for one sitting, as the guest reviews it and the host closes it. */
  async tab(params: {
    sessionId: string;
    merchantId: string;
    now?: Date;
  }): Promise<DiningSessionTabView | null> {
    const now = params.now ?? new Date();
    const session = await this.dining.findSessionById(params.sessionId);
    // Scoped by merchant, not merely found: a session id is a uuid and a wrong
    // one must not read another shop's bill.
    if (!session || session.merchantId !== params.merchantId) return null;

    const [table, orders, merchant] = await Promise.all([
      this.dining.findTable(params.merchantId, session.tableId),
      this.dining.listSessionOrders(session.id),
      this.prisma.merchant.findUnique({
        where: { id: params.merchantId },
        select: { name: true },
      }),
    ]);
    if (!table) throw new DiningSessionNotFoundError(session.id);

    return this.buildTab(session, table, orders, merchant?.name ?? '', now);
  }

  /**
   * The tab for a scanned table, keyed on the QR token.
   *
   * The guest's route: they hold a token and nothing else. Sharing the internal
   * builder with `tab` means the guest's bill and the host's bill are the same
   * object, which is the only way "the numbers disagree" cannot happen.
   */
  async tabByQrToken(qrToken: string, now: Date = new Date()): Promise<DiningSessionTabView | null> {
    const scanned = await this.dining.findByQrToken(qrToken);
    if (!scanned || !scanned.openSession) return null;

    const orders = await this.dining.listSessionOrders(scanned.openSession.id);
    return this.buildTab(
      scanned.openSession,
      scanned.table,
      orders,
      scanned.merchant.name,
      now,
    );
  }

  /**
   * The tab keyed on the one-time sitting token.
   *
   * The route the guest's phone actually polls. Distinct from `tabByQrToken`
   * because the two tokens prove different things: the table code proves "I am
   * at this table", the sitting token proves "I may order on this bill".
   */
  async tabByGuestToken(
    guestToken: string,
    now: Date = new Date(),
  ): Promise<DiningSessionTabView | null> {
    const scanned = await this.dining.findByGuestToken(guestToken);
    if (!scanned || !scanned.openSession) return null;

    const orders = await this.dining.listSessionOrders(scanned.openSession.id);
    return this.buildTab(
      scanned.openSession,
      scanned.table,
      orders,
      scanned.merchant.name,
      now,
    );
  }

  /**
   * The QR URL a shop prints.
   *
   * Built from the configured web origin rather than a client-supplied one: a
   * printed sheet and a tablet on the shop's LAN must produce the same string,
   * and only the server knows the public origin. `corsOrigins[0]` is that
   * origin in this codebase — the first allowed origin IS the web app.
   *
   * The `/table/` segment is NOT decoration: the web app routes a scanned TABLE
   * code and a sitting's GUEST token to two different pages
   * (`app/dine/table/[qrToken]` and `app/dine/s/[guestToken]`), because the two
   * tokens grant different powers. A shared `/dine/<token>` prefix would make
   * every printed label 404 — the shop would laminate the sheet, stick it on
   * the table, and the first guest to scan it would get a blank screen.
   */
  qrUrl(qrToken: string): string {
    return this.webUrl(`/dine/table/${qrToken}`);
  }

  /** Where the guest's phone settles once a sitting is open. */
  diningUrl(guestToken: string): string {
    return this.webUrl(`/dine/s/${guestToken}`);
  }

  /** An absolute URL on the public web origin. */
  private webUrl(path: string): string {
    const base = (this.config.corsOrigins[0] ?? 'http://localhost:3001').replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  /**
   * The tab totals for a table, which the tab view and the close response both
   * need. A single builder so the two cannot drift.
   */
  private buildTab(
    session: PersistedDiningSession,
    table: PersistedDiningTable,
    orders: readonly SessionOrderSummary[],
    merchantName: string,
    now: Date,
  ): DiningSessionTabView {
    const summary = toSessionSummary(session, table, orders, now);
    const lines = orders.map(toTabLine);
    const subtotalMinor = lines
      .filter((line) => line.countsTowardTotal)
      .reduce((total, line) => total + line.lineTotalMinor, 0);

    return {
      session: summary,
      merchantId: session.merchantId,
      merchantName,
      lines,
      subtotalMinor,
      totalMinor: subtotalMinor,
      canOrderMore: summary.status === 'OPEN',
      settledAt: summary.closedAt,
    };
  }
}
