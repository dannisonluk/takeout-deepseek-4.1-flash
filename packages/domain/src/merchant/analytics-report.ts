/**
 * 營業報表 — the pure arithmetic behind the report page.
 *
 * The SQL layer fetches *rows*; everything that turns rows into a report lives
 * here, in plain TypeScript, so the definitions of "revenue", "a trading day"
 * and "the busiest hour" are testable in milliseconds and cannot drift between
 * the merchant's page, the export and the admin console.
 *
 * Two definitions are worth stating out loud because getting either wrong makes
 * the numbers disagree with a shopkeeper's own arithmetic, which is how a
 * report loses trust:
 *
 *   - **A trading day is a local calendar date, not a 24-hour window.** An
 *     order at 00:30 HKT belongs to that HKT day. The bucket key is the
 *     merchant-local `YYYY-MM-DD`, computed by the caller, and this file never
 *     does timezone maths of its own.
 *   - **Revenue excludes orders that never became trade.** Cancelled, rejected
 *     and expired orders are counted separately — they are not "zero-revenue
 *     sales", they are things that did not happen, and mixing them in makes the
 *     average order value wrong.
 */

/**
 * The shape the SQL layer must hand over.
 *
 * **One row per GROUP, not per order.** The SQL groups on
 * `(serviceDate, hourOfDay, status, fulfilmentMode, paymentMode)` and sums the
 * money, so a single row can stand for several orders — two orders at the same
 * hour on the same day paid the same way arrive as one row carrying their
 * combined subtotal.
 *
 * That is why `orderCount` exists as an explicit field: the money can be summed
 * by SQL but the *number of orders* cannot be recovered from an array length.
 * Reading `orders.length` here is the bug that reports four sales on a day the
 * shop made six; it is invisible whenever a group happens to hold one order,
 * which is most of the time in development.
 */
export interface ReportableOrder {
  /** Merchant-local `YYYY-MM-DD` of the trading day. */
  readonly serviceDate: string;
  /** Merchant-local hour `0–23`. */
  readonly hourOfDay: number;
  readonly status: string;
  /** How many orders this grouped row represents. `COUNT(*)` from the SQL. */
  readonly orderCount: number;
  readonly subtotalMinor: number;
  readonly platformFeeMinor: number;
  readonly merchantPayoutMinor: number;
  readonly fulfilmentMode: string;
  readonly paymentMode: string;
  readonly itemCount: number;
}

/** One line item, denormalised — a name and what it earned. */
export interface ReportableLine {
  readonly nameSnapshot: string;
  readonly quantity: number;
  readonly lineTotalMinor: number;
  readonly isMainItem: boolean;
}

/**
 * Orders that represent trade, as opposed to an attempt that did not happen.
 *
 * `REFUNDED` is deliberately **included**: the sale happened, and the refund is
 * a separate event with its own line. Excluding it would make a day with one
 * refund look like a day with one fewer customer.
 */
const TRADING_STATUSES: readonly string[] = [
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'COMPLETED',
  'REFUNDED',
];

/** Orders that were attempted and did not go through — reported, never counted as revenue. */
const VOID_STATUSES: readonly string[] = ['CANCELLED', 'REJECTED', 'EXPIRED'];

export function isTradingOrder(status: string): boolean {
  return TRADING_STATUSES.includes(status);
}

export function isVoidOrder(status: string): boolean {
  return VOID_STATUSES.includes(status);
}

export interface DailyRollup {
  readonly date: string;
  readonly orderCount: number;
  readonly voidCount: number;
  readonly revenueMinor: number;
  readonly platformFeeMinor: number;
  readonly payoutMinor: number;
  /** Revenue ÷ trading orders, rounded half away from zero. */
  readonly averageOrderValueMinor: number;
}

export interface ItemMixRow {
  readonly name: string;
  readonly quantity: number;
  readonly revenueMinor: number;
  readonly isMainItem: boolean;
}

export interface HourBucket {
  readonly hour: number;
  readonly orderCount: number;
  readonly revenueMinor: number;
}

export interface ChannelMixRow {
  readonly key: string;
  readonly orderCount: number;
  readonly revenueMinor: number;
}

export interface ReportTotals {
  readonly orderCount: number;
  readonly voidCount: number;
  readonly revenueMinor: number;
  readonly platformFeeMinor: number;
  readonly payoutMinor: number;
  readonly averageOrderValueMinor: number;
  readonly itemCount: number;
}

export interface AnalyticsReport {
  readonly totals: ReportTotals;
  readonly daily: readonly DailyRollup[];
  readonly itemMix: readonly ItemMixRow[];
  readonly hourOfDay: readonly HourBucket[];
  readonly channels: readonly ChannelMixRow[];
}

/** Round half away from zero — the same rule `Money` uses, applied to an average. */
function roundDiv(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const sign = numerator < 0 !== denominator < 0 ? -1 : 1;
  const value = Math.abs(numerator) / Math.abs(denominator);
  return sign * Math.round(value);
}

/**
 * Fold raw orders and lines into the whole report.
 *
 * Pure and total: an empty input yields an empty report with zero totals rather
 * than throwing, because "a brand-new shop with no orders" is the normal first
 * thing a report page renders, not an error.
 */
export function buildAnalyticsReport(
  orders: readonly ReportableOrder[],
  lines: readonly ReportableLine[],
): AnalyticsReport {
  const trading = orders.filter((order) => isTradingOrder(order.status));
  const voids = orders.filter((order) => isVoidOrder(order.status));

  const countOrders = (rows: readonly ReportableOrder[]): number =>
    sum(rows, (row) => row.orderCount);

  const totals: ReportTotals = {
    // Summed, never `trading.length` — a row can stand for several orders.
    orderCount: countOrders(trading),
    voidCount: countOrders(voids),
    revenueMinor: sum(trading, (order) => order.subtotalMinor),
    platformFeeMinor: sum(trading, (order) => order.platformFeeMinor),
    payoutMinor: sum(trading, (order) => order.merchantPayoutMinor),
    averageOrderValueMinor: roundDiv(sum(trading, (order) => order.subtotalMinor), countOrders(trading)),
    itemCount: sum(trading, (order) => order.itemCount),
  };

  return {
    totals,
    daily: buildDaily(trading, voids),
    itemMix: buildItemMix(lines),
    hourOfDay: buildHourOfDay(trading),
    channels: buildChannels(trading),
  };
}

function buildDaily(
  trading: readonly ReportableOrder[],
  voids: readonly ReportableOrder[],
): DailyRollup[] {
  const keys = new Set<string>();
  for (const order of trading) keys.add(order.serviceDate);
  // A day with nothing but cancellations is still a day the shop traded on
  // paper — dropping it would make the chart skip a date and look broken.
  for (const order of voids) keys.add(order.serviceDate);

  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((date) => {
      const dayTrading = trading.filter((order) => order.serviceDate === date);
      const dayVoid = voids.filter((order) => order.serviceDate === date);
      const revenue = sum(dayTrading, (order) => order.subtotalMinor);
      const dayOrderCount = sum(dayTrading, (order) => order.orderCount);
      return {
        date,
        // NOT `dayTrading.length` — see `ReportableOrder`.
        orderCount: dayOrderCount,
        voidCount: sum(dayVoid, (order) => order.orderCount),
        revenueMinor: revenue,
        platformFeeMinor: sum(dayTrading, (order) => order.platformFeeMinor),
        payoutMinor: sum(dayTrading, (order) => order.merchantPayoutMinor),
        averageOrderValueMinor: roundDiv(revenue, dayOrderCount),
      };
    });
}

function buildItemMix(lines: readonly ReportableLine[]): ItemMixRow[] {
  const byName = new Map<string, ItemMixRow>();
  for (const line of lines) {
    const existing = byName.get(line.nameSnapshot);
    if (existing) {
      byName.set(line.nameSnapshot, {
        ...existing,
        quantity: existing.quantity + line.quantity,
        revenueMinor: existing.revenueMinor + line.lineTotalMinor,
      });
    } else {
      byName.set(line.nameSnapshot, {
        name: line.nameSnapshot,
        quantity: line.quantity,
        revenueMinor: line.lineTotalMinor,
        isMainItem: line.isMainItem,
      });
    }
  }
  // Most-sold first, then by revenue — a stable tie-break so the list does not
  // jitter between two polls of the same data.
  return [...byName.values()].sort(
    (a, b) => b.quantity - a.quantity || b.revenueMinor - a.revenueMinor || a.name.localeCompare(b.name),
  );
}

function buildHourOfDay(trading: readonly ReportableOrder[]): HourBucket[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const bucket = trading.filter((order) => order.hourOfDay === hour);
    return {
      hour,
      // Summed, not `bucket.length`: two orders in the same hour, same day,
      // paid the same way arrive as one row.
      orderCount: sum(bucket, (order) => order.orderCount),
      revenueMinor: sum(bucket, (order) => order.subtotalMinor),
    };
  });
}

function buildChannels(trading: readonly ReportableOrder[]): ChannelMixRow[] {
  const byKey = new Map<string, ChannelMixRow>();
  for (const order of trading) {
    // A dine-in order is a self-pickup order with a session attached, so the
    // channel key is composed rather than taken from `fulfilmentMode` alone —
    // otherwise dine-in and counter pickup would collapse into one line.
    const key = `${order.fulfilmentMode}/${order.paymentMode}`;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        ...existing,
        orderCount: existing.orderCount + order.orderCount,
        revenueMinor: existing.revenueMinor + order.subtotalMinor,
      });
    } else {
      byKey.set(key, {
        key,
        orderCount: order.orderCount,
        revenueMinor: order.subtotalMinor,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => b.orderCount - a.orderCount || a.key.localeCompare(b.key));
}

function sum<T>(rows: readonly T[], pick: (row: T) => number): number {
  let total = 0;
  for (const row of rows) total += pick(row);
  return total;
}

/**
 * The window one period earlier, for a comparison view.
 *
 * Returned as a label and a matching pair of dates so the caller does not have
 * to re-derive "the same length immediately before" — the off-by-one there is
 * the classic way a comparison silently overlaps its own window.
 */
export interface ComparisonWindow {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

export function previousWindow(from: string, to: string): ComparisonWindow {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  const dayCount = Math.round((toMs - fromMs) / 86_400_000) + 1;
  const prevTo = new Date(fromMs - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (dayCount - 1) * 86_400_000);
  return {
    label: `前 ${dayCount} 日`,
    from: isoDate(prevFrom),
    to: isoDate(prevTo),
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Percentage change, as a signed number, or `null` when there is no baseline.
 *
 * `null` rather than `100` or `0`: a shop open for one week has no "last
 * period", and rendering "+100%" against nothing is a fiction.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
