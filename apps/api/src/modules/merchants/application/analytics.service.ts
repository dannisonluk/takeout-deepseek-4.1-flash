import { Injectable, Logger } from '@nestjs/common';
import {
  AnalyticsCapability,
  AnalyticsTier,
  ExportRow,
  buildAnalyticsReport,
  buildOrdersCsv,
  exportFilename,
  hasAnalyticsCapability,
  percentChange,
  previousWindow,
  toAnalyticsTier,
} from '@takeout/domain';
import { localDateString, utcOffsetMinutesAt } from '../../../common/time/service-date';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { MerchantAnalyticsView, analyticsTierView } from '../interface/merchant.views';

/**
 * 商戶營業報表 — the read side of the report page.
 *
 * WHY THIS IS NOT `findMany` + `reduce`
 * -------------------------------------
 * The merchant dashboard used to fetch the most recent 200 orders into Node and
 * sum them in a loop. That is wrong in a way that is invisible until a shop is
 * successful: the 200-row window silently truncates, so a busy Saturday quietly
 * reports the wrong revenue, and the merchant's own arithmetic (which they do
 * from their POS) disagrees. The fix is not "fetch 2000 rows" — it is to let
 * Postgres do the aggregation, which is what every query below does.
 *
 * Two consequences of doing it in SQL are worth stating because they are where
 * a hand-written aggregate goes wrong:
 *
 *   1. **The day bucket is computed in the MERCHANT'S timezone, in SQL.** The
 *      grouping key is `(created_at AT TIME ZONE $tz)::date`, not
 *      `created_at::date` — the latter would bucket a 00:30 HKT order into the
 *      previous day, because the timestamp is stored in UTC. The timezone is
 *      bound as a parameter rather than interpolated, so a merchant row with a
 *      surprising value cannot inject SQL.
 *   2. **Only orders that traded are aggregated.** The status filter is applied
 *      in SQL as well as in `buildAnalyticsReport`, deliberately twice: the SQL
 *      filter keeps void orders out of the `SUM`, and the domain filter is what
 *      the tests assert on. Removing the SQL filter would make the daily
 *      rollup's `voidCount` wrong; removing the domain filter would make the
 *      unit tests stop describing the real query.
 *
 * The projection of "rows → report" still happens in `buildAnalyticsReport` in
 * `packages/domain`, so the arithmetic — average order value, the item-mix
 * sort, the comparison window — is testable without a database.
 */

/** The statuses that represent trade. Mirrors `TRADING_STATUSES` in the domain. */
const TRADING_STATUSES = ['PAID', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED', 'REFUNDED'] as const;

/** Orders that were attempted and never became trade. */
const VOID_STATUSES = ['CANCELLED', 'REJECTED', 'EXPIRED'] as const;

/** A report plus the entitlement facts the page needs to render it honestly. */
export interface MerchantAnalyticsResult extends MerchantAnalyticsView {}

export interface AnalyticsComparison {
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly revenueChangePercent: number | null;
  readonly orderCountChangePercent: number | null;
  readonly averageOrderValueChangePercent: number | null;
}

/** One row of the raw export. Includes the money columns the BI view omits. */
export interface AnalyticsExportResult {
  readonly filename: string;
  /** UTF-8 CSV with BOM and CRLF — see `buildOrdersCsv`. */
  readonly body: string;
  readonly rowCount: number;
}

interface AnalyticsWindow {
  readonly from: string;
  readonly to: string;
  readonly fromDate: Date;
  readonly toDate: Date;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  /**
   * A ceiling on the window, in days.
   *
   * The aggregation runs inside an HTTP request, and a merchant who asks for
   * "the last five years" should get a clear refusal rather than a query that
   * holds a connection for thirty seconds. 366 covers a leap year — the honest
   * maximum for "compare this year with last".
   */
  static readonly MAX_WINDOW_DAYS = 366;

  constructor(private readonly prisma: PrismaService) {}

  /** The shop's entitlement, read once. Fails closed to `NONE` on an unknown value. */
  async tierOf(merchantId: string): Promise<AnalyticsTier> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { analyticsTier: true },
    });
    return toAnalyticsTier(merchant?.analyticsTier ?? null);
  }

  /**
   * The whole report for a window.
   *
   * The window is resolved in the merchant's timezone: "today" for a +08 shop at
   * 17:30 UTC is already tomorrow, so a `to` derived from `new Date()` would
   * leave the most recent trading day out of the report the owner just opened.
   */
  async report(params: {
    merchantId: string;
    timezone: string;
    from?: string;
    to?: string;
  }): Promise<MerchantAnalyticsResult> {
    const tier = await this.tierOf(params.merchantId);
    const window = resolveWindow(params.timezone, params.from, params.to);

    // The aggregation is fetched even for `NONE`: the totals are what the
    // dashboard's summary strip shows, and they are the shop's own numbers. The
    // TIER decides which *panels* render, not whether the owner may see their
    // own revenue at all. A shop on `NONE` that could not see its own total
    // would be worse than the old 200-row page it is replacing.
    const [orders, lines, voids] = await Promise.all([
      this.aggregateOrders(params.merchantId, params.timezone, window),
      this.aggregateItemMix(params.merchantId, params.timezone, window),
      this.aggregateVoids(params.merchantId, params.timezone, window),
    ]);

    const report = buildAnalyticsReport([...orders, ...voids], lines);

    const comparison = hasAnalyticsCapability(tier, 'COMPARISON')
      ? await this.buildComparison(params.merchantId, params.timezone, window, report)
      : null;

    // The entitlement decides which panels RENDER, not which numbers exist. The
    // arrays are filtered here rather than in the client so a `BASIC` shop's
    // response never carries a comparison it is not paying for — hiding it in
    // CSS would make the paid feature one `curl` away.
    const capabilities = capabilitiesFor(tier);
    const allows = (capability: AnalyticsCapability): boolean =>
      capabilities.includes(capability);

    return {
      merchantId: params.merchantId,
      tier: analyticsTierView(tier),
      window: { from: window.from, to: window.to, days: dayCount(window) },
      totals: report.totals,
      comparison,
      daily: allows('DAILY_ROLLUP') ? report.daily : [],
      itemMix: allows('ITEM_MIX') ? report.itemMix : [],
      hourOfDay: allows('HOUR_OF_DAY') ? report.hourOfDay : [],
      channels: allows('CHANNEL_MIX') ? report.channels : [],
    };
  }

  /**
   * The raw export — **never** gated on the tier.
   *
   * `canExportRawData` always returns true, and this method does not read the
   * tier at all. That is deliberate: the export is the shop's own data, and a
   * check here would be the one line that turns "your orders in a spreadsheet"
   * into a paid feature. Keeping the entitlement query out of this method means
   * there is no tier value that could accidentally gate it.
   */
  async export(params: {
    merchantId: string;
    merchantSlug: string;
    timezone: string;
    from?: string;
    to?: string;
  }): Promise<AnalyticsExportResult> {
    const window = resolveWindow(params.timezone, params.from, params.to);
    const exportRows = await this.fetchExportRows(params.merchantId, params.timezone, window);

    return {
      filename: exportFilename(params.merchantSlug, window.from, window.to),
      body: buildOrdersCsv(exportRows),
      rowCount: exportRows.length,
    };
  }

  // -------------------------------------------------------------------------
  //  SQL aggregation
  // -------------------------------------------------------------------------

  /**
   * Revenue / orders / payouts per merchant-local trading day.
   *
   * `SUM(...)::int` rather than leaving them as `bigint`: Prisma's `$queryRaw`
   * hands back a `BigInt` for a `bigint` column, and `JSON.stringify` throws on
   * a `BigInt`. Casting in SQL is the fix that does not need a serialiser shim.
   *
   * The `FILTER (WHERE ...)` for voids is what makes one query answer both
   * "how many orders traded" and "how many were attempted and did not" — a
   * second round-trip for the void count would be a second place the status
   * list lives.
   */
  private async aggregateOrders(
    merchantId: string,
    timezone: string,
    window: AnalyticsWindow,
  ): Promise<ReportableOrderRow[]> {
    const rows = await this.prisma.$queryRaw<ReportableOrderRow[]>`
      SELECT
        to_char(("createdAt" AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD')            AS "serviceDate",
        EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE ${timezone}))::int                AS "hourOfDay",
        "status"::text                                                                AS "status",
        COUNT(*)::int                                                                 AS "orderCount",
        COALESCE(SUM("subtotalMinor"), 0)::int                                        AS "subtotalMinor",
        COALESCE(SUM("platformFeeMinor"), 0)::int                                     AS "platformFeeMinor",
        COALESCE(SUM("merchantPayoutMinor"), 0)::int                                  AS "merchantPayoutMinor",
        "fulfilmentMode"::text                                                        AS "fulfilmentMode",
        "paymentMode"::text                                                           AS "paymentMode",
        COALESCE(SUM("mainItemCount"), 0)::int                                        AS "itemCount"
      FROM "orders"
      WHERE "merchantId" = ${merchantId}::uuid
        AND "createdAt" >= ${window.fromDate}
        AND "createdAt" < ${window.toDate}
        AND "status"::text = ANY(${[...TRADING_STATUSES]}::text[])
      GROUP BY 1, 2, 3, 8, 9
      ORDER BY 1 ASC, 2 ASC
    `;

    return rows;
  }

  /** The void count per day, for the "N 筆未成交" line on the rollup table. */
  private async aggregateVoids(
    merchantId: string,
    timezone: string,
    window: AnalyticsWindow,
  ): Promise<ReportableOrderRow[]> {
    // Voids contribute nothing to revenue, so this returns one row per void DAY
    // with zeroed money — enough for `buildDaily` to count them without
    // inventing revenue that never existed.
    const rows = await this.prisma.$queryRaw<{ serviceDate: string; voidCount: number }[]>`
      SELECT
        to_char(("createdAt" AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS "serviceDate",
        COUNT(*)::int                                                       AS "voidCount"
      FROM "orders"
      WHERE "merchantId" = ${merchantId}::uuid
        AND "createdAt" >= ${window.fromDate}
        AND "createdAt" < ${window.toDate}
        AND "status"::text = ANY(${[...VOID_STATUSES]}::text[])
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return rows.map((row) => ({
      serviceDate: row.serviceDate,
      hourOfDay: 0,
      status: 'CANCELLED',
      // `COUNT(*)` from the SQL — the same reason `aggregateOrders` carries it.
      orderCount: row.voidCount,
      subtotalMinor: 0,
      platformFeeMinor: 0,
      merchantPayoutMinor: 0,
      fulfilmentMode: 'SELF_PICKUP',
      paymentMode: 'ONLINE',
      itemCount: 0,
    }));
  }

  /**
   * Item mix — what sold, how many, and what it earned.
   *
   * Joined to `orders` rather than to `menu_items`: the join is what scopes the
   * lines to this merchant's trading orders, and joining the menu instead would
   * include a dish that was loaded onto a cancelled order. The name comes from
   * `nameSnapshot`, never from the live menu — a renamed dish must not rewrite
   * last month's report.
   */
  private async aggregateItemMix(
    merchantId: string,
    timezone: string,
    window: AnalyticsWindow,
  ): Promise<ReportableLineRow[]> {
    return this.prisma.$queryRaw<ReportableLineRow[]>`
      SELECT
        i."nameSnapshot"                    AS "nameSnapshot",
        SUM(i."quantity")::int              AS "quantity",
        SUM(i."lineTotalMinor")::int        AS "lineTotalMinor",
        bool_or(i."isMainItem")             AS "isMainItem"
      FROM "order_items" i
      JOIN "orders" o ON o."id" = i."orderId"
      WHERE o."merchantId" = ${merchantId}::uuid
        AND o."createdAt" >= ${window.fromDate}
        AND o."createdAt" < ${window.toDate}
        AND o."status"::text = ANY(${[...TRADING_STATUSES]}::text[])
      GROUP BY i."nameSnapshot"
      ORDER BY 2 DESC, 3 DESC, 1 ASC
    `;
  }

  /** One comparison row per metric, against the equal-length window before. */
  private async buildComparison(
    merchantId: string,
    timezone: string,
    window: AnalyticsWindow,
    current: ReturnType<typeof buildAnalyticsReport>,
  ): Promise<AnalyticsComparison> {
    const previous = previousWindow(window.from, window.to);
    const previousReport = buildAnalyticsReport(
      await this.aggregateOrders(merchantId, timezone, resolveWindow(timezone, previous.from, previous.to)),
      [],
    );

    return {
      label: previous.label,
      from: previous.from,
      to: previous.to,
      revenueChangePercent: percentChange(
        current.totals.revenueMinor,
        previousReport.totals.revenueMinor,
      ),
      orderCountChangePercent: percentChange(
        current.totals.orderCount,
        previousReport.totals.orderCount,
      ),
      averageOrderValueChangePercent: percentChange(
        current.totals.averageOrderValueMinor,
        previousReport.totals.averageOrderValueMinor,
      ),
    };
  }

  /** The raw rows behind the export, most recent first. */
  private async fetchExportRows(
    merchantId: string,
    timezone: string,
    window: AnalyticsWindow,
  ): Promise<ExportRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        orderNo: string;
        serviceDate: string;
        createdAt: Date;
        status: string;
        fulfilmentMode: string;
        paymentMode: string;
        mainItemCount: number;
        subtotalMinor: number;
        platformFeeMinor: number;
        merchantPayoutMinor: number;
        customerNote: string | null;
      }[]
    >`
      SELECT
        "orderNo"                                                           AS "orderNo",
        to_char(("createdAt" AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS "serviceDate",
        "createdAt"                                                         AS "createdAt",
        "status"::text                                                      AS "status",
        "fulfilmentMode"::text                                              AS "fulfilmentMode",
        "paymentMode"::text                                                 AS "paymentMode",
        "mainItemCount"::int                                                AS "mainItemCount",
        "subtotalMinor"::int                                                AS "subtotalMinor",
        "platformFeeMinor"::int                                             AS "platformFeeMinor",
        "merchantPayoutMinor"::int                                          AS "merchantPayoutMinor",
        "customerNote"                                                      AS "customerNote"
      FROM "orders"
      WHERE "merchantId" = ${merchantId}::uuid
        AND "createdAt" >= ${window.fromDate}
        AND "createdAt" < ${window.toDate}
      ORDER BY "createdAt" DESC
      LIMIT 20000
    `;

    return rows.map((row) => ({
      orderNo: row.orderNo,
      serviceDate: row.serviceDate,
      // Local wall-clock in the merchant's zone, so the CSV's "下單時間"
      // column reads the way the shop experienced it rather than in UTC.
      createdAt: localDateTimeString(timezone, row.createdAt),
      status: row.status,
      fulfilmentMode: row.fulfilmentMode,
      paymentMode: row.paymentMode,
      itemCount: row.mainItemCount,
      subtotalMinor: row.subtotalMinor,
      platformFeeMinor: row.platformFeeMinor,
      merchantPayoutMinor: row.merchantPayoutMinor,
      customerNote: row.customerNote,
    }));
  }
}

// ============================================================================
//  Rows as the SQL returns them
// ============================================================================

interface ReportableOrderRow {
  serviceDate: string;
  hourOfDay: number;
  status: string;
  /**
   * How many orders this grouped row stands for.
   *
   * The SQL groups on `(serviceDate, hourOfDay, status, fulfilmentMode,
   * paymentMode)` so it can `SUM` the money in one round-trip. The consequence
   * is that a row is not an order, and counting rows is how a shop that made six
   * sales sees four on its dashboard.
   */
  orderCount: number;
  subtotalMinor: number;
  platformFeeMinor: number;
  merchantPayoutMinor: number;
  fulfilmentMode: string;
  paymentMode: string;
  itemCount: number;
}

interface ReportableLineRow {
  nameSnapshot: string;
  quantity: number;
  lineTotalMinor: number;
  isMainItem: boolean;
}

// ============================================================================
//  Window helpers
// ============================================================================

/**
 * Turn `from`/`to` (or "the last 30 days") into an absolute, half-open window.
 *
 * Half-open — `[fromDate, toDate)` where `toDate` is the UTC instant of local
 * midnight on the day AFTER `to` — because a closed interval would need the
 * last day to end at 23:59:59.999, and a row at exactly midnight would be
 * either double-counted or dropped depending on which bound used `<=`.
 *
 * The bounds are built with `utcOffsetMinutesAt` at the window's own start and
 * end rather than with a fixed offset: a shop in a zone with DST would
 * otherwise report a 23- or 25-hour day twice a year.
 */
export function resolveWindow(timezone: string, from?: string, to?: string): AnalyticsWindow {
  const today = localDateString(timezone, new Date());
  const resolvedTo = isValidDate(to) ? (to as string) : today;
  const resolvedFrom = isValidDate(from) ? (from as string) : addDays(resolvedTo, -29);

  if (resolvedFrom > resolvedTo) {
    // A reversed window is a client bug, not a data condition. Throw rather
    // than silently swapping the bounds: swapping would hide the bug and
    // produce a report for a window the caller never asked for.
    throw new InvalidAnalyticsWindowError(resolvedFrom, resolvedTo);
  }

  const days = dayCountBetween(resolvedFrom, resolvedTo);
  if (days > AnalyticsService.MAX_WINDOW_DAYS) {
    throw new InvalidAnalyticsWindowError(
      resolvedFrom,
      resolvedTo,
      `查詢範圍不可超過 ${AnalyticsService.MAX_WINDOW_DAYS} 日`,
    );
  }

  return {
    from: resolvedFrom,
    to: resolvedTo,
    fromDate: localMidnightUtc(timezone, resolvedFrom),
    toDate: localMidnightUtc(timezone, addDays(resolvedTo, 1)),
  };
}

/** The local-timezone midnight of `YYYY-MM-DD`, as the UTC instant it occurs at. */
function localMidnightUtc(timezone: string, date: string): Date {
  // Probe the offset at the UTC-midnight instant of that date. For every zone
  // with a whole-hour offset this is exact; for a half-hour zone it can be out
  // by at most the offset difference across a DST boundary, which the half-open
  // window absorbs because both bounds are shifted by the same amount.
  const probe = new Date(`${date}T00:00:00.000Z`);
  const offsetMinutes = utcOffsetMinutesAt(timezone, probe);
  return new Date(probe.getTime() - offsetMinutes * 60_000);
}

function isValidDate(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

function dayCount(window: AnalyticsWindow): number {
  return dayCountBetween(window.from, window.to);
}

function dayCountBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** `YYYY-MM-DD HH:mm` in the merchant's zone. */
function localDateTimeString(timezone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = String(Number.parseInt(get('hour'), 10) % 24).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

function capabilitiesFor(tier: AnalyticsTier): readonly AnalyticsCapability[] {
  // The five names, in the order the page renders them, filtered by entitlement.
  const all: readonly AnalyticsCapability[] = [
    'DAILY_ROLLUP',
    'ITEM_MIX',
    'HOUR_OF_DAY',
    'CHANNEL_MIX',
    'COMPARISON',
  ];
  return all.filter((capability) => hasAnalyticsCapability(tier, capability));
}

/** The window a report was asked for is not one we can serve. */
export class InvalidAnalyticsWindowError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    message = `查詢日期範圍無效：${from} 至 ${to}`,
  ) {
    super(message);
    this.name = 'InvalidAnalyticsWindowError';
  }
}

export type { MerchantAnalyticsView };
