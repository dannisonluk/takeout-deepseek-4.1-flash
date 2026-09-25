'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
import {
  Badge,
  Button,
  Card,
  CardHead,
  Empty,
  ErrorBlock,
  Loading,
  Stat,
  Toggle,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { useAsync, useTicker } from '@/lib/use-async';
import {
  ACTIVE_ORDER_STATUSES,
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  money,
  moneyCompact,
  timeOnly,
} from '@/lib/format';
import type { MerchantOrder } from '@/lib/types';

/**
 * How many recent orders the overview reads.
 *
 * There is no merchant-facing aggregate endpoint, so today's totals are
 * computed from the recent-order page. That is exact for a shop doing fewer
 * than this many orders a day and under-reports above it — which the page says
 * out loud rather than quietly showing a wrong number. The admin console's
 * dashboard does the real aggregation in SQL.
 */
const WINDOW = 200;

/** `YYYY-MM-DD` on the merchant's own clock. String comparison, no arithmetic. */
function localDateKey(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(typeof iso === 'string' ? new Date(iso) : iso);
}

export default function MerchantTodayPage() {
  const { merchant, merchantId, patchLocal, reload: reloadMerchants } = useMerchant();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const tick = useTicker(30_000);

  const state = useAsync<{ data: MerchantOrder[]; hasMore: boolean }>(
    () =>
      merchantId
        ? api.kitchen.list(merchantId, { status: 'ALL', limit: WINDOW })
        : Promise.resolve({ data: [], hasMore: false }),
    [merchantId, tick],
  );

  // Re-read the merchant row too, so a status change made by an admin shows up
  // without the owner having to reload the page.
  useEffect(() => {
    void reloadMerchants();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  if (!merchant || !merchantId) return null;

  const timeZone = merchant.timezone;
  const today = localDateKey(new Date(), timeZone);
  const orders = state.data?.data ?? [];
  const todaysOrders = orders.filter((order) => localDateKey(order.createdAt, timeZone) === today);

  const active = orders.filter((order) => ACTIVE_ORDER_STATUSES.includes(order.status));
  const awaitingAccept = active.filter((order) => order.status === 'PAID');

  const revenue = todaysOrders
    .filter((order) => order.status !== 'CANCELLED' && order.status !== 'REJECTED' && order.status !== 'EXPIRED')
    .reduce((sum, order) => sum + order.subtotalMinor, 0);
  const platformFees = todaysOrders.reduce((sum, order) => sum + order.platformFeeMinor, 0);
  const payout = todaysOrders.reduce((sum, order) => sum + order.merchantPayoutMinor, 0);
  const completed = todaysOrders.filter((order) => order.status === 'COMPLETED').length;

  async function toggleIntake(next: boolean) {
    setBusy(true);
    try {
      const updated = await api.merchant.setIntake(merchantId!, next);
      patchLocal(updated);
      toast.push(next ? '已開始接單' : '已暫停接單，顧客目前無法下單', next ? 'ok' : 'warn');
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <MerchantShell
      title="今日概況"
      subtitle={`${merchant.name} · ${localDateKey(new Date(), timeZone)}（${timeZone}）`}
      counts={{ activeOrders: active.length }}
      actions={
        <Button size="sm" onClick={() => void state.reload()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        {state.error ? (
          <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
        ) : (
          <>
            <Card>
              <div className="row-between">
                <div className="stack-sm" style={{ gap: 2 }}>
                  <strong>接單狀態</strong>
                  <span className="tiny muted">
                    {merchant.acceptsOrders
                      ? '目前接受新訂單。暫停後，新訂單會被平台自動拒單並退款。'
                      : '已暫停接單。顧客仍可看到你的餐廳，但無法下單。'}
                  </span>
                </div>
                <Toggle
                  checked={merchant.acceptsOrders}
                  onChange={(next) => void toggleIntake(next)}
                  disabled={busy || merchant.status !== 'ACTIVE'}
                  onLabel="接單中"
                  offLabel="已暫停"
                />
              </div>
              {merchant.status !== 'ACTIVE' && (
                <p className="tiny dim" style={{ marginTop: 'var(--space-2)' }}>
                  餐廳未上線，接單開關暫不生效。
                </p>
              )}
            </Card>

            {awaitingAccept.length > 0 && (
              <div className="banner banner-warn">
                <div className="grow stack-sm" style={{ gap: 2 }}>
                  <strong>有 {awaitingAccept.length} 張新訂單待接單</strong>
                  <div>
                    逾時未接單的訂單會由系統自動處理。
                    {awaitingAccept[0]?.acceptDeadlineAt
                      ? ` 最近一張將於 ${timeOnly(awaitingAccept[0].acceptDeadlineAt, timeZone)} 到期。`
                      : ''}
                  </div>
                </div>
                <Link href="/merchant/orders">
                  <Button variant="primary" size="sm">
                    前往接單
                  </Button>
                </Link>
              </div>
            )}

            <div className="grid-4">
              <Stat label="今日訂單" value={todaysOrders.length} hint={`已完成 ${completed}`} />
              <Stat label="今日營業額" value={moneyCompact(revenue)} hint="未扣平台費前" />
              <Stat label="平台費" value={moneyCompact(platformFees)} hint="今日累計" />
              <Stat
                label="預計入帳"
                value={moneyCompact(payout)}
                tone="ok"
                hint="扣平台費與支付手續費後"
              />
            </div>

            <Card flush>
              <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
                <CardHead
                  title="待處理訂單"
                  subtitle={active.length === 0 ? undefined : `${active.length} 張`}
                  action={
                    <Link href="/merchant/orders">
                      <Button size="sm" variant="ghost">
                        全部訂單
                      </Button>
                    </Link>
                  }
                />
              </div>

              {state.loading ? (
                <Loading rows={3} />
              ) : active.length === 0 ? (
                <Empty icon="🍽" title="目前沒有待處理訂單">
                  新訂單進來時會即時顯示在這裡。
                </Empty>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>訂單</th>
                        <th>狀態</th>
                        <th>取餐時間</th>
                        <th className="right">件數</th>
                        <th className="right">入帳</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.slice(0, 8).map((order) => (
                        <tr key={order.id}>
                          <td className="mono">{order.orderNo}</td>
                          <td>
                            <Badge tone={ORDER_STATUS_TONE[order.status]}>
                              {ORDER_STATUS_LABEL[order.status]}
                            </Badge>
                          </td>
                          <td className="num">
                            {order.scheduledPickupAt
                              ? timeOnly(order.scheduledPickupAt, timeZone)
                              : '即時'}
                          </td>
                          <td className="right num">
                            {order.items.reduce((sum, item) => sum + item.quantity, 0)}
                          </td>
                          <td className="right num">{money(order.merchantPayoutMinor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {state.data?.hasMore && (
              <p className="tiny dim">
                僅統計最近 {WINDOW} 張訂單，較早的訂單未計入今日數字。平台端的報表為完整統計。
              </p>
            )}
          </>
        )}
      </div>
    </MerchantShell>
  );
}
