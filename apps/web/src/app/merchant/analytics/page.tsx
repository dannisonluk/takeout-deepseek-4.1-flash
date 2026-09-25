'use client';

import { useMemo, useState } from 'react';
import { MerchantShell } from '@/components/merchant-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  ErrorBlock,
  Loading,
  Segmented,
  Stat,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { useAsync } from '@/lib/use-async';
import {
  ANALYTICS_CAPABILITY_LABEL,
  dateOnly,
  hourLabel,
  money,
  moneyCompact,
  percentChange,
  percentChangeTone,
  weekday,
} from '@/lib/format';
import type {
  AnalyticsCapability,
  AnalyticsDailyRow,
  AnalyticsHourRow,
  AnalyticsItemRow,
  MerchantAnalytics,
} from '@/lib/types';

/**
 * 商戶營業報表 — the merchant's own numbers.
 *
 * Two things about this page are deliberate and worth stating.
 *
 * **1. The export is not behind the paywall.** Every shop, including one on
 * 標準, can download its own order rows as a CSV. The platform charges for
 * *computation* — the trends, the item ranking, the comparison — never for
 * access to data the shop generated. The button is rendered from
 * `tier.canExportRawData` (which the API hard-codes to `true`) rather than from
 * a local `isPaid` check, so a future change to the commercial model is one
 * edit in the domain instead of a hunt through the UI for hard-coded gates.
 *
 * **2. A gated panel is explained, not hidden.** On a tier without
 * `ITEM_MIX`, the panel still renders — greyed, with the capability's name and
 * a 升級 link. A page that silently omits four sections looks broken; one that
 * names what is missing and offers the upgrade is the sales pitch the shop's
 * owner actually asked for.
 */

/** The preset windows, in days. `null` means "since opening". */
const RANGES = [
  { value: '7', label: '7 天' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
] as const;

type RangeKey = (typeof RANGES)[number]['value'];

/** A local `YYYY-MM-DD`, offset from today. */
function shiftDays(date: Date, days: number): string {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  const month = String(copy.getMonth() + 1).padStart(2, '0');
  const day = String(copy.getDate()).padStart(2, '0');
  return `${copy.getFullYear()}-${month}-${day}`;
}

export default function MerchantAnalyticsPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const [range, setRange] = useState<RangeKey>('30');
  const [exporting, setExporting] = useState(false);

  /**
   * The window, computed from the BROWSER's today.
   *
   * Slightly at odds with the server's default (which uses the shop's zone),
   * but only for a shop whose zone differs from the viewer's — and the viewer
   * here is the shop's own owner on their own phone. Sending an explicit window
   * is what makes the range buttons work at all; the alternative is three
   * server-side presets. The `daily` rows still come back keyed on the shop's
   * local date, which is the part that has to be right for bookkeeping.
   */
  const window = useMemo(() => {
    const today = new Date();
    return { from: shiftDays(today, -(Number(range) - 1)), to: shiftDays(today, 0) };
  }, [range]);

  const report = useAsync<MerchantAnalytics>(
    () => api.analytics.report(merchantId!, window),
    [merchantId, window.from, window.to],
  );

  if (!merchant || !merchantId) return null;

  const data = report.data;
  const has = (capability: AnalyticsCapability) =>
    data?.tier.capabilities.includes(capability) ?? false;

  async function exportCsv() {
    setExporting(true);
    try {
      const result = await api.analytics.exportCsv(merchantId!, window);
      toast.push(
        result.rowCount === null
          ? `已匯出 ${result.filename}`
          : `已匯出 ${result.filename}（${result.rowCount} 筆訂單）`,
        'ok',
      );
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
    } finally {
      setExporting(false);
    }
  }

  return (
    <MerchantShell
      title="營業報表"
      subtitle={`${window.from} 至 ${window.to} · 時區 ${merchant.timezone}`}
      actions={
        <div className="row">
          <Segmented
            options={RANGES.map((item) => ({ value: item.value, label: item.label }))}
            value={range}
            onChange={(next) => setRange(next)}
          />
          <Button
            variant="primary"
            size="sm"
            loading={exporting}
            onClick={() => void exportCsv()}
          >
            匯出 Excel
          </Button>
        </div>
      }
    >
      <div className="stack">
        {/* ---- the tier marker the owner asked for ------------------------ */}
        {data && <TierBanner view={data} />}

        {report.error ? (
          <ErrorBlock error={report.error} onRetry={() => void report.reload()} />
        ) : !data ? (
          <Loading rows={6} />
        ) : (
          <>
            {/* ---- totals ------------------------------------------------ */}
            <Card>
              <CardHead
                title="總覽"
                subtitle={`${data.window.days} 天 · ${data.totals.orderCount} 張訂單`}
              />
              <div className="grid-4">
                <Stat
                  label="營業額"
                  value={money(data.totals.revenueMinor)}
                  hint={
                    data.comparison ? (
                      <ChangeBadge
                        value={data.comparison.revenueChangePercent}
                        label={data.comparison.label}
                      />
                    ) : undefined
                  }
                />
                <Stat
                  label="訂單數"
                  value={data.totals.orderCount}
                  hint={
                    data.comparison ? (
                      <ChangeBadge
                        value={data.comparison.orderCountChangePercent}
                        label={data.comparison.label}
                      />
                    ) : undefined
                  }
                />
                <Stat
                  label="平均客單價"
                  value={money(data.totals.averageOrderValueMinor)}
                  hint={
                    data.comparison ? (
                      <ChangeBadge
                        value={data.comparison.averageOrderValueChangePercent}
                        label={data.comparison.label}
                      />
                    ) : undefined
                  }
                />
                <Stat
                  label="預計撥款"
                  value={money(data.totals.payoutMinor)}
                  hint={`平台費 ${money(data.totals.platformFeeMinor)}`}
                />
              </div>
              {data.totals.voidCount > 0 && (
                <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
                  同期間有 {data.totals.voidCount} 張訂單未成交（已取消、被拒或逾時），不計入營業額。
                </p>
              )}
            </Card>

            {/* ---- daily rollup ------------------------------------------ */}
            <Panel
              title="每日營業額"
              capability="DAILY_ROLLUP"
              unlocked={has('DAILY_ROLLUP')}
              tier={data.tier.tier}
            >
              <DailyTable rows={data.daily} />
            </Panel>

            {/* ---- item mix ---------------------------------------------- */}
            <Panel
              title="菜品排行"
              capability="ITEM_MIX"
              unlocked={has('ITEM_MIX')}
              tier={data.tier.tier}
            >
              <ItemTable rows={data.itemMix} />
            </Panel>

            {/* ---- hour of day ------------------------------------------- */}
            <Panel
              title="時段分佈"
              capability="HOUR_OF_DAY"
              unlocked={has('HOUR_OF_DAY')}
              tier={data.tier.tier}
            >
              <HourChart rows={data.hourOfDay} />
            </Panel>

            {/* ---- channel mix ------------------------------------------- */}
            <Panel
              title="取餐／付款方式分佈"
              capability="CHANNEL_MIX"
              unlocked={has('CHANNEL_MIX')}
              tier={data.tier.tier}
            >
              <ChannelTable rows={data.channels} />
            </Panel>
          </>
        )}
      </div>
    </MerchantShell>
  );
}

/**
 * The user-facing tier marker.
 *
 * Shows the badge, what the tier buys, and — on anything below 專業 — what the
 * next step would add. Distinct from the panels' own "locked" state: this is
 * the "what do I have" answer, those are the "what am I missing" answers.
 */
function TierBanner({ view }: { view: MerchantAnalytics }) {
  const tier = view.tier;
  return (
    <Card tight>
      <div className="row-between row-wrap" style={{ gap: 'var(--space-3)' }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="row-wrap" style={{ gap: 'var(--space-2)' }}>
            <Badge tone={tier.isPaid ? 'accent' : 'neutral'}>{tier.label}</Badge>
            <span className="small strong">目前的報表方案</span>
          </div>
          <span className="tiny muted">{tier.blurb}</span>
        </div>
        <div className="stack-sm" style={{ gap: 2, alignItems: 'flex-end' }}>
          {tier.canExportRawData && (
            <span className="tiny dim">訂單明細匯出：永久免費</span>
          )}
          {tier.tier === 'NONE' && (
            <span className="tiny">
              <span className="dim">升級可看趨勢、排行與時段分析 → 聯絡平台</span>
            </span>
          )}
          {tier.tier === 'BASIC' && (
            <span className="tiny">
              <span className="dim">升級至專業報表可加看同期比較 → 聯絡平台</span>
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

/**
 * One BI panel, gated on a capability.
 *
 * Renders the locked state rather than `null`. The point of the paywall is to
 * sell the upgrade, and a missing section sells nothing — nobody upgrades for a
 * feature they never saw.
 */
function Panel({
  title,
  capability,
  unlocked,
  tier,
  children,
}: {
  title: string;
  capability: AnalyticsCapability;
  unlocked: boolean;
  tier: string;
  children: React.ReactNode;
}) {
  if (unlocked) {
    return (
      <Card>
        <CardHead
          title={title}
          subtitle={ANALYTICS_CAPABILITY_LABEL[capability]}
          action={<Badge tone="accent">已啟用</Badge>}
        />
        {children}
      </Card>
    );
  }
  return (
    <Card>
      <CardHead
        title={title}
        subtitle={ANALYTICS_CAPABILITY_LABEL[capability]}
        action={<Badge tone="neutral">未啟用</Badge>}
      />
      <Banner tone="info" title={`${ANALYTICS_CAPABILITY_LABEL[capability]}屬於付費方案`}>
        <span className="tiny">
          目前的方案是「{tier === 'NONE' ? '標準' : tier}」，因此看不到這一塊。
          升級後即可查看，並保留過去所有日期的資料 —— 升級不會丟失歷史。
          也可以先用右上角的「匯出 Excel」把明細取回自行分析。
        </span>
      </Banner>
    </Card>
  );
}

function ChangeBadge({ value, label }: { value: number | null; label: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <Badge tone={percentChangeTone(value)}>{percentChange(value)}</Badge>
      <span className="tiny dim">較{label}</span>
    </span>
  );
}

function DailyTable({ rows }: { rows: AnalyticsDailyRow[] }) {
  if (rows.length === 0) {
    return <Empty icon="📊" title="這段期間沒有已成交的訂單" />;
  }
  // Newest first: the row a shop checks is today's, and a table that needs
  // scrolling to the bottom to find it is a table nobody reads.
  const ordered = [...rows].sort((a, b) => b.date.localeCompare(a.date));
  const peak = Math.max(...ordered.map((row) => row.revenueMinor), 1);

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>日期</th>
            <th className="right">訂單</th>
            <th className="right">未成交</th>
            <th className="right">營業額</th>
            <th className="right">平台費</th>
            <th className="right">撥款</th>
            <th className="right">平均客單</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <tr key={row.date}>
              <td className="nowrap">
                <span className="strong">{dateOnly(`${row.date}T00:00:00.000Z`)}</span>{' '}
                <span className="tiny dim">{weekdayFromDate(row.date)}</span>
              </td>
              <td className="right num">{row.orderCount}</td>
              <td className="right num">
                {row.voidCount > 0 ? (
                  <span className="dim">{row.voidCount}</span>
                ) : (
                  <span className="dim">—</span>
                )}
              </td>
              <td className="right num">
                <div className="stack-sm" style={{ gap: 3, alignItems: 'flex-end' }}>
                  <span className="strong">{money(row.revenueMinor)}</span>
                  {/* A bar, so a week of rows reads as a trend without a chart
                      library — the shape is the point, the exact pixels are not. */}
                  <div className="bar-track">
                    <div
                      className="bar-fill"
                      style={{ width: `${Math.round((row.revenueMinor / peak) * 100)}%` }}
                    />
                  </div>
                </div>
              </td>
              <td className="right num dim">{money(row.platformFeeMinor)}</td>
              <td className="right num">{money(row.payoutMinor)}</td>
              <td className="right num dim">{money(row.averageOrderValueMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `"2026-09-25"` -> `"週五"`. Parsed as UTC noon so the weekday cannot shift. */
function weekdayFromDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return '';
  return weekday(parsed.getUTCDay());
}

function ItemTable({ rows }: { rows: AnalyticsItemRow[] }) {
  if (rows.length === 0) {
    return <Empty icon="🍜" title="這段期間沒有已成交的品項" />;
  }
  const peak = Math.max(...rows.map((row) => row.revenueMinor), 1);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 32 }}>#</th>
            <th>菜品</th>
            <th className="right">數量</th>
            <th className="right">營業額</th>
            <th className="right">佔比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.name}-${index}`}>
              <td className="dim num">{index + 1}</td>
              <td>
                <span className="strong">{row.name}</span>
                {row.isMainItem && (
                  <>
                    {' '}
                    <Badge tone="info">主菜</Badge>
                  </>
                )}
              </td>
              <td className="right num">{row.quantity}</td>
              <td className="right num strong">{money(row.revenueMinor)}</td>
              <td className="right" style={{ width: 120 }}>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${Math.round((row.revenueMinor / peak) * 100)}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
        標記為「主菜」的品項會計入平台費（每件主菜收取固定費用）。
      </p>
    </div>
  );
}

/**
 * Hour-of-day as columns.
 *
 * A hand-rolled bar chart rather than a charting library: it is 24 numbers, it
 * must be readable on a phone, and pulling in Recharts for one panel costs more
 * bundle than the entire merchant console. Empty hours are still rendered, so
 * the x-axis stays evenly spaced and 18:00 lands in the same place every day.
 */
function HourChart({ rows }: { rows: AnalyticsHourRow[] }) {
  if (rows.length === 0) {
    return <Empty icon="🕐" title="這段期間沒有已成交的訂單" />;
  }
  const byHour = new Map(rows.map((row) => [row.hour, row]));
  const hours = Array.from({ length: 24 }, (_, hour) => byHour.get(hour));
  const peak = Math.max(...rows.map((row) => row.orderCount), 1);
  const busiest = rows.reduce<AnalyticsHourRow | null>(
    (best, row) => (best === null || row.orderCount > best.orderCount ? row : best),
    null,
  );

  return (
    <div className="stack">
      {busiest && (
        <p className="tiny muted">
          最繁忙時段：<span className="strong">{hourLabel(busiest.hour)}</span>
          （{busiest.orderCount} 張 · {money(busiest.revenueMinor)}）
        </p>
      )}
      <div className="hour-chart">
        {hours.map((row, hour) => (
          <div className="hour-col" key={hour}>
            <div className="hour-bar-track">
              <div
                className="hour-bar"
                title={
                  row
                    ? `${hourLabel(hour)} · ${row.orderCount} 張 · ${money(row.revenueMinor)}`
                    : `${hourLabel(hour)} · 無訂單`
                }
                style={{ height: `${row ? Math.max(3, (row.orderCount / peak) * 100) : 0}%` }}
              />
            </div>
            {/* Only every third hour is labelled — 24 labels on a phone is noise. */}
            <span className="hour-tick">{hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Fulfilment / payment-mode split.
 *
 * The `key` is a raw enum from the API; `moneyCompact` is used for the revenue
 * so a long number does not push the count off a phone screen.
 */
function ChannelTable({ rows }: { rows: { key: string; orderCount: number; revenueMinor: number }[] }) {
  if (rows.length === 0) {
    return <Empty icon="🧾" title="這段期間沒有已成交的訂單" />;
  }
  const label: Record<string, string> = {
    SELF_PICKUP: '自取',
    DINE_IN: '店內用餐',
    ONLINE: '線上付款',
    PAY_AT_STORE: '到店付款',
    UNKNOWN: '未標示',
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>方式</th>
            <th className="right">訂單</th>
            <th className="right">營業額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="strong">{label[row.key] ?? row.key}</td>
              <td className="right num">{row.orderCount}</td>
              <td className="right num">{moneyCompact(row.revenueMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
