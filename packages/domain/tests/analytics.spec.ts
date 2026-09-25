import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_TIER_LABEL,
  AnalyticsTier,
  analyticsCapabilities,
  analyticsTierRank,
  buildAnalyticsReport,
  buildOrdersCsv,
  canExportRawData,
  escapeCsvField,
  exportFilename,
  hasAnalyticsCapability,
  isAnalyticsDowngrade,
  isPaidAnalyticsTier,
  moneyToDecimalString,
  percentChange,
  previousWindow,
  toAnalyticsTier,
  type ReportableLine,
  type ReportableOrder,
} from '../src/merchant/index';

function order(over: Partial<ReportableOrder> = {}): ReportableOrder {
  return {
    serviceDate: '2026-09-25',
    hourOfDay: 12,
    status: 'COMPLETED',
    // One row standing for one order — the common case. The tests that care
    // about a GROUPED row (one row for several orders) set this explicitly.
    orderCount: 1,
    subtotalMinor: 10_000,
    platformFeeMinor: 1_050,
    merchantPayoutMinor: 8_500,
    fulfilmentMode: 'SELF_PICKUP',
    paymentMode: 'ONLINE',
    itemCount: 3,
    ...over,
  };
}

function line(over: Partial<ReportableLine> = {}): ReportableLine {
  return { nameSnapshot: '招牌飯', quantity: 1, lineTotalMinor: 5_000, isMainItem: true, ...over };
}

describe('analytics entitlement', () => {
  it('parses a stored value, failing closed on anything unrecognised', () => {
    expect(toAnalyticsTier('PRO')).toBe(AnalyticsTier.PRO);
    expect(toAnalyticsTier('BASIC')).toBe(AnalyticsTier.BASIC);
    expect(toAnalyticsTier('NONE')).toBe(AnalyticsTier.NONE);
    // A typo in a config row must not hand out paid features.
    expect(toAnalyticsTier('pro')).toBe(AnalyticsTier.NONE);
    expect(toAnalyticsTier('ENTERPRISE')).toBe(AnalyticsTier.NONE);
    expect(toAnalyticsTier(null)).toBe(AnalyticsTier.NONE);
    expect(toAnalyticsTier(undefined)).toBe(AnalyticsTier.NONE);
  });

  it('gives the free tier no computed capabilities', () => {
    expect(analyticsCapabilities(AnalyticsTier.NONE)).toEqual([]);
    expect(hasAnalyticsCapability(AnalyticsTier.NONE, 'DAILY_ROLLUP')).toBe(false);
  });

  it('unlocks aggregates on BASIC and comparison only on PRO', () => {
    expect(hasAnalyticsCapability(AnalyticsTier.BASIC, 'DAILY_ROLLUP')).toBe(true);
    expect(hasAnalyticsCapability(AnalyticsTier.BASIC, 'ITEM_MIX')).toBe(true);
    expect(hasAnalyticsCapability(AnalyticsTier.BASIC, 'HOUR_OF_DAY')).toBe(true);
    expect(hasAnalyticsCapability(AnalyticsTier.BASIC, 'CHANNEL_MIX')).toBe(true);
    // The line that separates the two paid tiers.
    expect(hasAnalyticsCapability(AnalyticsTier.BASIC, 'COMPARISON')).toBe(false);
    expect(hasAnalyticsCapability(AnalyticsTier.PRO, 'COMPARISON')).toBe(true);
  });

  it('is monotonic — a higher tier grants everything the lower one does', () => {
    for (const capability of analyticsCapabilities(AnalyticsTier.BASIC)) {
      expect(hasAnalyticsCapability(AnalyticsTier.PRO, capability)).toBe(true);
    }
  });

  it('lets EVERY tier take its own raw data', () => {
    // The whole point: the export is not a paid feature. If this ever becomes
    // tier-gated, a shop loses access to data it already owns.
    for (const tier of [AnalyticsTier.NONE, AnalyticsTier.BASIC, AnalyticsTier.PRO]) {
      expect(canExportRawData(tier)).toBe(true);
    }
  });

  it('separates the paid marker from the authorisation check', () => {
    expect(isPaidAnalyticsTier(AnalyticsTier.NONE)).toBe(false);
    expect(isPaidAnalyticsTier(AnalyticsTier.BASIC)).toBe(true);
    expect(isPaidAnalyticsTier(AnalyticsTier.PRO)).toBe(true);
    // Every tier has a label, so the UI never renders an empty chip.
    for (const tier of Object.values(AnalyticsTier)) {
      expect(ANALYTICS_TIER_LABEL[tier]).toBeTruthy();
    }
  });

  it('ranks tiers and detects a downgrade', () => {
    expect(analyticsTierRank(AnalyticsTier.PRO)).toBeGreaterThan(
      analyticsTierRank(AnalyticsTier.BASIC),
    );
    expect(isAnalyticsDowngrade(AnalyticsTier.PRO, AnalyticsTier.BASIC)).toBe(true);
    expect(isAnalyticsDowngrade(AnalyticsTier.BASIC, AnalyticsTier.PRO)).toBe(false);
    expect(isAnalyticsDowngrade(AnalyticsTier.BASIC, AnalyticsTier.BASIC)).toBe(false);
  });
});

describe('the report arithmetic', () => {
  it('counts only orders that traded as revenue', () => {
    const report = buildAnalyticsReport(
      [
        order({ subtotalMinor: 10_000 }),
        order({ status: 'CANCELLED', subtotalMinor: 99_999 }),
        order({ status: 'REJECTED', subtotalMinor: 99_999 }),
        order({ status: 'EXPIRED', subtotalMinor: 99_999 }),
      ],
      [],
    );
    expect(report.totals.orderCount).toBe(1);
    expect(report.totals.revenueMinor).toBe(10_000);
    expect(report.totals.voidCount).toBe(3);
  });

  it('counts a refunded order as trade, not as a void', () => {
    // The sale happened; the refund is a separate event. Dropping it would make
    // a day with one refund look like a day with one fewer customer.
    const report = buildAnalyticsReport([order({ status: 'REFUNDED' })], []);
    expect(report.totals.orderCount).toBe(1);
    expect(report.totals.voidCount).toBe(0);
    expect(report.totals.revenueMinor).toBe(10_000);
  });

  it('counts ORDERS in a grouped row, not rows', () => {
    // The SQL groups on (day, hour, status, fulfilment, payment) so it can SUM
    // the money in one round-trip. A row is therefore NOT an order: two sales at
    // the same hour paid the same way arrive as one row with their money added.
    //
    // Counting `orders.length` here reports four sales on a day the shop made
    // six — and it looks correct in development, where a group usually holds one
    // order. This test is the guard on that.
    const report = buildAnalyticsReport(
      [
        order({ orderCount: 2, subtotalMinor: 9_600, itemCount: 3 }),
        order({ orderCount: 1, subtotalMinor: 4_800, itemCount: 1 }),
      ],
      [],
    );
    expect(report.totals.orderCount).toBe(3);
    expect(report.totals.revenueMinor).toBe(14_400);
    expect(report.totals.itemCount).toBe(4);
    // The average divides by ORDERS, not rows — otherwise it is inflated.
    expect(report.totals.averageOrderValueMinor).toBe(4_800);
  });

  it('a grouped row is reflected in the daily rollup and the hour buckets too', () => {
    const report = buildAnalyticsReport(
      [
        order({ orderCount: 3, hourOfDay: 19, subtotalMinor: 30_000 }),
        order({ orderCount: 2, hourOfDay: 12, subtotalMinor: 20_000 }),
      ],
      [],
    );

    const day = report.daily.find((row) => row.date === '2026-09-25');
    expect(day).toBeDefined();
    // The day counts orders, not grouped rows.
    expect(day?.orderCount).toBe(5);
    expect(day?.averageOrderValueMinor).toBe(10_000);

    const hour19 = report.hourOfDay.find((row) => row.hour === 19);
    const hour12 = report.hourOfDay.find((row) => row.hour === 12);
    expect(hour19?.orderCount).toBe(3);
    expect(hour12?.orderCount).toBe(2);

    const channel = report.channels.find((row) => row.key === 'SELF_PICKUP/ONLINE');
    // The channel split must count orders as well.
    expect(channel?.orderCount).toBe(5);

    // Every view of the same data must agree, or the page contradicts itself.
    const fromDaily = report.daily.reduce((sum, row) => sum + row.orderCount, 0);
    const fromHours = report.hourOfDay.reduce((sum, row) => sum + row.orderCount, 0);
    const fromChannels = report.channels.reduce((sum, row) => sum + row.orderCount, 0);
    expect(fromDaily).toBe(report.totals.orderCount);
    expect(fromHours).toBe(report.totals.orderCount);
    expect(fromChannels).toBe(report.totals.orderCount);
  });

  it('averages only over trading orders, rounded half away from zero', () => {
    const report = buildAnalyticsReport(
      [
        order({ subtotalMinor: 1_001 }),
        order({ subtotalMinor: 1_002 }),
        order({ status: 'CANCELLED' }),
      ],
      [],
    );
    // 2003 / 2 = 1001.5 -> 1002
    expect(report.totals.averageOrderValueMinor).toBe(1_002);
  });

  it('returns zeroes rather than throwing on an empty shop', () => {
    const report = buildAnalyticsReport([], []);
    expect(report.totals.orderCount).toBe(0);
    expect(report.totals.averageOrderValueMinor).toBe(0);
    expect(report.daily).toEqual([]);
    expect(report.itemMix).toEqual([]);
    // The hour chart still renders 24 empty buckets, so the axis is stable.
    expect(report.hourOfDay).toHaveLength(24);
    expect(report.hourOfDay.every((bucket) => bucket.orderCount === 0)).toBe(true);
  });

  it('buckets a local trading day, keeping cancellation-only days on the axis', () => {
    const report = buildAnalyticsReport(
      [
        order({ serviceDate: '2026-09-24' }),
        order({ serviceDate: '2026-09-25' }),
        order({ serviceDate: '2026-09-25', status: 'CANCELLED' }),
      ],
      [],
    );
    expect(report.daily.map((day) => day.date)).toEqual(['2026-09-24', '2026-09-25']);
    expect(report.daily[1]!.orderCount).toBe(1);
    expect(report.daily[1]!.voidCount).toBe(1);
    expect(report.daily[1]!.revenueMinor).toBe(10_000);
  });

  it('sorts the item mix by quantity, with a stable tie-break', () => {
    const report = buildAnalyticsReport(
      [],
      [
        line({ nameSnapshot: '凍檸茶', quantity: 1, lineTotalMinor: 2_000, isMainItem: false }),
        line({ nameSnapshot: '招牌飯', quantity: 3 }),
        line({ nameSnapshot: '燒賣', quantity: 3, lineTotalMinor: 4_500, isMainItem: false }),
      ],
    );
    // Quantity desc, then revenue desc: 燒賣 (4500) before 招牌飯 (5000)? No —
    // 招牌飯 lineTotal is 5000 per line, 燒賣 4500, so 招牌飯 first.
    expect(report.itemMix.map((row) => row.name)).toEqual(['招牌飯', '燒賣', '凍檸茶']);
    expect(report.itemMix[0]!.quantity).toBe(3);
  });

  it('merges repeated lines of the same item across orders', () => {
    const report = buildAnalyticsReport(
      [],
      [line({ quantity: 2 }), line({ quantity: 3 }), line({ nameSnapshot: '叉燒包', quantity: 1 })],
    );
    expect(report.itemMix[0]).toMatchObject({ name: '招牌飯', quantity: 5, revenueMinor: 10_000 });
  });

  it('puts every trading order in exactly one hour bucket', () => {
    const report = buildAnalyticsReport(
      [order({ hourOfDay: 12 }), order({ hourOfDay: 12 }), order({ hourOfDay: 19 })],
      [],
    );
    const total = report.hourOfDay.reduce((sum, bucket) => sum + bucket.orderCount, 0);
    expect(total).toBe(3);
    expect(report.hourOfDay[12]!.orderCount).toBe(2);
    expect(report.hourOfDay[19]!.orderCount).toBe(1);
  });

  it('composes the channel key so dine-in cannot collapse into counter pickup', () => {
    const report = buildAnalyticsReport(
      [
        order({ fulfilmentMode: 'SELF_PICKUP', paymentMode: 'PAY_AT_STORE' }),
        order({ fulfilmentMode: 'SELF_PICKUP', paymentMode: 'ONLINE' }),
      ],
      [],
    );
    expect(report.channels.map((row) => row.key).sort()).toEqual([
      'SELF_PICKUP/ONLINE',
      'SELF_PICKUP/PAY_AT_STORE',
    ]);
  });
});

describe('comparison windows', () => {
  it('computes the equal-length window immediately before, without overlapping', () => {
    const window = previousWindow('2026-09-18', '2026-09-24');
    expect(window).toMatchObject({ from: '2026-09-11', to: '2026-09-17', label: '前 7 日' });
    // The critical property: the previous window must END before this one starts.
    expect(window.to < '2026-09-18').toBe(true);
  });

  it('handles a single-day window', () => {
    const window = previousWindow('2026-09-25', '2026-09-25');
    expect(window).toMatchObject({ from: '2026-09-24', to: '2026-09-24', label: '前 1 日' });
  });

  it('reports a percentage change, and null when there is no baseline', () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    // One week open is not a "last period" — a number would be a fiction.
    expect(percentChange(100, 0)).toBeNull();
    expect(percentChange(0, 0)).toBe(0);
  });
});

describe('the CSV export', () => {
  it('writes money as decimals, never minor units', () => {
    // `350` is wrong by a factor of 100 to anyone reading the file.
    expect(moneyToDecimalString(350)).toBe('3.50');
    expect(moneyToDecimalString(5)).toBe('0.05');
    expect(moneyToDecimalString(1_234_567)).toBe('12345.67');
    expect(moneyToDecimalString(0)).toBe('0.00');
    expect(moneyToDecimalString(-250)).toBe('-2.50');
  });

  it('leads with a UTF-8 BOM so Excel does not mangle Chinese', () => {
    const csv = buildOrdersCsv([
      {
        orderNo: 'A-001',
        serviceDate: '2026-09-25',
        createdAt: '2026-09-25T04:00:00.000Z',
        status: 'COMPLETED',
        fulfilmentMode: 'SELF_PICKUP',
        paymentMode: 'ONLINE',
        itemCount: 2,
        subtotalMinor: 8_000,
        platformFeeMinor: 700,
        merchantPayoutMinor: 6_800,
        customerNote: null,
      },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('訂單編號');
    expect(csv).toContain('80.00');
    expect(csv).not.toContain('8000');
  });

  it('uses CRLF, which Excel expects', () => {
    const csv = buildOrdersCsv([]);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('neutralises a note that Excel would run as a formula', () => {
    // `=cmd|...` in a spreadsheet is worse than a wrong number.
    expect(escapeCsvField('=1+1')).toBe("'=1+1");
    expect(escapeCsvField('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(escapeCsvField('-2+2')).toBe("'-2+2");
    expect(escapeCsvField('@foo')).toBe("'@foo");
  });

  it('quotes and doubles a field containing a comma, quote or newline', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField('plain')).toBe('plain');
  });

  it('carries a customer note through the injection guard', () => {
    const csv = buildOrdersCsv([
      {
        orderNo: 'A-002',
        serviceDate: '2026-09-25',
        createdAt: '2026-09-25T04:00:00.000Z',
        status: 'COMPLETED',
        fulfilmentMode: 'SELF_PICKUP',
        paymentMode: 'ONLINE',
        itemCount: 1,
        subtotalMinor: 1_000,
        platformFeeMinor: 350,
        merchantPayoutMinor: 650,
        customerNote: '=1+1',
      },
    ]);
    expect(csv).toContain("'=1+1");
  });

  it('produces a filename that survives every OS', () => {
    expect(exportFilename('dim-sum-express', '2026-09-01', '2026-09-25')).toBe(
      'dim-sum-express-orders-2026-09-01_2026-09-25.csv',
    );
    // A single day is not a range.
    expect(exportFilename('dim-sum-express', '2026-09-25', '2026-09-25')).toBe(
      'dim-sum-express-orders-2026-09-25.csv',
    );
    // A slug with a slash must not become a path separator.
    expect(exportFilename('a/b c', '2026-09-25', '2026-09-25')).toBe(
      'a-b-c-orders-2026-09-25.csv',
    );
  });
});
