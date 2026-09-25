'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  ErrorBlock,
  Loading,
  Stat,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  basisPoints,
  duration,
  money,
  moneyCompact,
  relative,
} from '@/lib/format';
import type { OrderStatus } from '@/lib/types';

export default function AdminDashboardPage() {
  const stats = useAsync(() => api.admin.dashboard(), []);
  const health = useAsync(() => api.admin.health(), []);

  const data = stats.data;

  /**
   * The age of the oldest undelivered event.
   *
   * `DashboardStats.ops` carries the timestamp but not the age, so it is
   * derived here rather than fetched again from `/admin/outbox/stats` — the
   * dashboard already paid for the timestamp.
   */
  const pendingAgeSeconds =
    data?.ops.oldestPendingAt != null
      ? Math.max(0, Math.round((Date.now() - new Date(data.ops.oldestPendingAt).getTime()) / 1000))
      : null;

  return (
    <AdminShell
      title="平台總覽"
      subtitle={data ? `產生於 ${relative(data.generatedAt)}` : undefined}
      counts={{
        activeOrders: data?.orders.active,
        pendingMerchants: data?.merchants.pendingReview,
        outboxDeadLetter: data?.ops.outboxDeadLetter,
      }}
      actions={
        <Button size="sm" onClick={() => void stats.reload()}>
          重新整理
        </Button>
      }
    >
      {stats.error ? (
        <ErrorBlock error={stats.error} onRetry={() => void stats.reload()} />
      ) : !data ? (
        <Loading rows={5} />
      ) : (
        <div className="stack">
          {/* ---- things that need a human ---------------------------------- */}
          {data.merchants.pendingReview > 0 && (
            <Banner
              tone="warn"
              title={`有 ${data.merchants.pendingReview} 間商戶待審核`}
              action={
                <Link href="/admin/merchants?status=PENDING_REVIEW">
                  <Button size="sm" variant="primary">
                    前往審核
                  </Button>
                </Link>
              }
            >
              待審核的商戶不會出現在顧客前台，也不會收到訂單。
            </Banner>
          )}

          {data.ops.outboxDeadLetter > 0 && (
            <Banner
              tone="danger"
              title={`有 ${data.ops.outboxDeadLetter} 筆事件已隔離`}
              action={
                <Link href="/admin/ops?status=DEAD_LETTER">
                  <Button size="sm" variant="danger">
                    查看
                  </Button>
                </Link>
              }
            >
              隔離的事件不會被自動重試。若涉及已付款訂單，相關的帳務與通知會停在半途。
            </Banner>
          )}

          {data.ops.oldestPendingAt && (
            <Banner
              tone="info"
              title={`最舊的待發送事件已積壓 ${duration(pendingAgeSeconds)}`}
              action={
                <Link href="/admin/ops">
                  <Button size="sm">
                    查看
                  </Button>
                </Link>
              }
            >
              積壓時間持續上升代表 relay 沒有在消費 outbox。
            </Banner>
          )}

          {(!health.loading && health.data && !health.data.redis) && (
            <Banner tone="danger" title="Redis 未連線">
              即時通知與部分快取會失效。API 仍可運作，但商家不會收到即時提醒。
            </Banner>
          )}

          {/* ---- money ----------------------------------------------------- */}
          <section className="stack">
            <h2>今日</h2>
            <div className="grid-4">
              <Stat label="今日訂單" value={data.orders.today} />
              <Stat label="今日 GMV" value={moneyCompact(data.orders.todayGmvMinor)} hint="顧客支付總額" />
              <Stat
                label="平台收入"
                value={moneyCompact(data.orders.todayPlatformFeeMinor)}
                tone="ok"
                hint="中介費"
              />
              <Stat
                label="應付商戶"
                value={moneyCompact(data.orders.todayPayoutMinor)}
                hint="扣除平台費與手續費後"
              />
            </div>
          </section>

          {/* ---- merchants ------------------------------------------------- */}
          <section className="stack">
            <h2>商戶</h2>
            <div className="grid-4">
              <Stat label="商戶總數" value={data.merchants.total} />
              <Stat label="營業中" value={data.merchants.active} tone="ok" />
              <Stat
                label="待審核"
                value={data.merchants.pendingReview}
                tone={data.merchants.pendingReview > 0 ? 'warn' : undefined}
              />
              <Stat label="接單中" value={data.merchants.acceptingOrders} />
              <Stat label="已暫停" value={data.merchants.suspended} tone="danger" />
              <Stat label="已結業" value={data.merchants.closed} />
            </div>
          </section>

          {/* ---- users ----------------------------------------------------- */}
          <section className="stack">
            <h2>使用者</h2>
            <div className="grid-4">
              <Stat label="總數" value={data.users.total} />
              <Stat label="顧客" value={data.users.customers} />
              <Stat label="商戶人員" value={data.users.merchantUsers} />
              <Stat label="管理員" value={data.users.admins} />
              <Stat label="今日活躍" value={data.users.activeToday} />
              <Stat
                label="已停用"
                value={data.users.disabled}
                tone={data.users.disabled > 0 ? 'warn' : undefined}
              />
            </div>
          </section>

          <div className="grid-2">
            {/* ---- pricing in force ---------------------------------------- */}
            <Card>
              <CardHead
                title="目前生效的計費"
                subtitle="所有新訂單即時套用"
                action={
                  <Link href="/admin/config">
                    <Button size="sm">調整</Button>
                  </Link>
                }
              />
              <div className="stack-sm">
                <Row
                  label="每件主餐中介費"
                  value={money(data.pricing.platformFee.feePerMainItemMinor)}
                />
                <Row
                  label="支付手續費"
                  value={`${basisPoints(data.pricing.paymentFee.rateBps)} + ${money(
                    data.pricing.paymentFee.fixedMinor,
                  )}`}
                />
                <Row
                  label="顧客服務費"
                  value={money(data.pricing.customerServiceFeeMinor)}
                />
                <Row label="最低入帳金額" value={money(data.pricing.minimumPayoutMinor)} />
                <Row
                  label="設定來源"
                  value={
                    <Badge tone={data.pricing.source === 'platform_config' ? 'accent' : 'neutral'}>
                      {data.pricing.source === 'platform_config'
                        ? '平台設定（資料庫）'
                        : data.pricing.source === 'environment'
                          ? '環境變數'
                          : '程式預設'}
                    </Badge>
                  }
                />
              </div>
            </Card>

            {/* ---- order mix ----------------------------------------------- */}
            <Card>
              <CardHead
                title="進行中訂單分佈"
                subtitle={`共 ${data.orders.active} 張未完成`}
                action={
                  <Link href="/admin/orders">
                    <Button size="sm">全部訂單</Button>
                  </Link>
                }
              />
              {data.orders.active === 0 ? (
                <Empty icon="✓" title="目前沒有進行中的訂單" />
              ) : (
                <div className="stack-sm">
                  {Object.entries(data.orders.byStatus)
                    .filter(([, count]) => count > 0)
                    .map(([status, count]) => (
                      <div className="row-between" key={status}>
                        <Badge tone={ORDER_STATUS_TONE[status as OrderStatus] ?? 'neutral'}>
                          {ORDER_STATUS_LABEL[status as OrderStatus] ?? status}
                        </Badge>
                        <span className="num strong">{count}</span>
                      </div>
                    ))}
                </div>
              )}
            </Card>
          </div>

          {/* ---- finance + ops --------------------------------------------- */}
          <div className="grid-2">
            <Card>
              <CardHead
                title="結算"
                action={
                  <Link href="/admin/finance">
                    <Button size="sm">前往結算</Button>
                  </Link>
                }
              />
              <div className="stack-sm">
                <Row
                  label="待結算筆數"
                  value={
                    <span className={data.payouts.pendingCount > 0 ? 'strong' : undefined}>
                      {data.payouts.pendingCount}
                    </span>
                  }
                />
                <Row label="待結算金額" value={money(data.payouts.pendingNetMinor)} />
                <Row
                  label="近 30 日已付款"
                  value={money(data.payouts.paidLast30DaysMinor)}
                />
              </div>
            </Card>

            <Card>
              <CardHead
                title="系統"
                action={
                  <Link href="/admin/ops">
                    <Button size="sm">維運面板</Button>
                  </Link>
                }
              />
              <div className="stack-sm">
                <Row
                  label="資料庫"
                  value={
                    health.loading ? (
                      '檢查中…'
                    ) : health.data?.database ? (
                      <Badge tone="ok" dot>
                        正常
                      </Badge>
                    ) : (
                      <Badge tone="danger" dot>
                        異常
                      </Badge>
                    )
                  }
                />
                <Row
                  label="Redis"
                  value={
                    health.loading ? (
                      '檢查中…'
                    ) : health.data?.redis ? (
                      <Badge tone="ok" dot>
                        已連線
                      </Badge>
                    ) : (
                      <Badge tone="warn" dot>
                        未連線
                      </Badge>
                    )
                  }
                />
                <Row label="Outbox 待發送" value={data.ops.outboxPending} />
                <Row
                  label="Outbox 失敗"
                  value={data.ops.outboxFailed}
                  tone={data.ops.outboxFailed > 0 ? 'danger' : undefined}
                />
              </div>
            </Card>
          </div>
        </div>
      )}
    </AdminShell>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger';
}) {
  return (
    <div className="row-between">
      <span className="tiny muted">{label}</span>
      <span className="num" style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}>
        {value}
      </span>
    </div>
  );
}
