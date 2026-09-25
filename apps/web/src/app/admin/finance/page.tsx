'use client';

import { useState } from 'react';
import { AdminShell, Pager } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  ErrorBlock,
  Field,
  Input,
  Loading,
  Modal,
  Segmented,
  Select,
  Stat,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import {
  PAYOUT_STATUS_LABEL,
  PAYOUT_STATUS_TONE,
  dateOnly,
  money,
  moneyCompact,
} from '@/lib/format';
import type { AdminPayout, PayoutStatus } from '@/lib/types';

const LIMIT = 25;

const ALL_STATUSES: PayoutStatus[] = ['PENDING', 'PROCESSING', 'PAID', 'FAILED'];

/** Default reconciliation window: the last 30 days, inclusive. */
function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 24 * 60 * 60 * 1000);
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export default function AdminFinancePage() {
  const [tab, setTab] = useState<'payouts' | 'reconciliation'>('payouts');

  return (
    <AdminShell
      title="結算與對帳"
      subtitle="商戶入帳的產生、付款與核對"
      actions={
        <Segmented<'payouts' | 'reconciliation'>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'payouts', label: '結算批次' },
            { value: 'reconciliation', label: '對帳' },
          ]}
        />
      }
    >
      {tab === 'payouts' ? <PayoutsView /> : <ReconciliationView />}
    </AdminShell>
  );
}

/* ==========================================================================
   Payouts
   ========================================================================== */

function PayoutsView() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState<{ payout: AdminPayout; kind: 'paid' | 'failed' } | null>(
    null,
  );

  const list = useAsync(
    () =>
      api.admin.finance.payouts({
        ...(status ? { status } : {}),
        limit: LIMIT,
        offset,
      }),
    [status, offset],
  );

  const totals = list.data?.totals;

  return (
    <div className="stack">
      <div className="grid-3">
        <Stat
          label="待結算金額"
          value={moneyCompact(totals?.pendingNetMinor ?? 0)}
          tone={(totals?.pendingNetMinor ?? 0) > 0 ? 'warn' : undefined}
          hint="已產生但未付款的批次"
        />
        <Stat label="已付款金額" value={moneyCompact(totals?.paidNetMinor ?? 0)} tone="ok" />
        <Stat label="批次數" value={list.data?.total ?? 0} />
      </div>

      <Banner tone="info" title="結算批次由訂單完成時產生">
        每張訂單在標記為「已完成」時，會依計費快照寫入一筆入帳分錄。
        結算批次把同一商戶、同一服務日的分錄彙總成一次付款。標記付款只記錄結果，不會真的轉帳。
      </Banner>

      <Card flush>
        <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
          <div className="row-between">
            <CardHead title="結算批次" />
            <Select
              value={status}
              style={{ width: 160 }}
              onChange={(event) => {
                setStatus(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">全部狀態</option>
              {ALL_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PAYOUT_STATUS_LABEL[value]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {list.error ? (
          <ErrorBlock error={list.error} onRetry={() => void list.reload()} />
        ) : list.loading && !list.data ? (
          <Loading rows={6} />
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <Empty icon="💰" title="沒有結算批次">
            訂單完成後會自動產生。若已有完成訂單卻沒有批次，請檢查維運面板的 outbox 狀態。
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>商戶</th>
                    <th>服務日</th>
                    <th>狀態</th>
                    <th className="right">訂單</th>
                    <th className="right">小計</th>
                    <th className="right">平台費</th>
                    <th className="right">手續費</th>
                    <th className="right">淨額</th>
                    <th className="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.data.map((payout) => (
                    <tr key={payout.id}>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span className="strong">{payout.merchantName}</span>
                          <span className="tiny dim mono">{payout.merchantSlug}</span>
                        </div>
                      </td>
                      <td className="tiny num nowrap">
                        {dateOnly(payout.periodStart)}
                        <span className="dim"> – </span>
                        {dateOnly(payout.periodEnd)}
                      </td>
                      <td>
                        <Badge tone={PAYOUT_STATUS_TONE[payout.status]}>
                          {PAYOUT_STATUS_LABEL[payout.status]}
                        </Badge>
                      </td>
                      <td className="right num">{payout.orderCount}</td>
                      <td className="right num">{money(payout.grossSubtotalMinor)}</td>
                      <td className="right num">{money(payout.platformFeeMinor)}</td>
                      <td className="right num">{money(payout.paymentFeeMinor)}</td>
                      <td className="right num strong">{money(payout.netPayoutMinor)}</td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          {payout.status !== 'PAID' && (
                            <Button
                              size="sm"
                              variant="primary"
                              onClick={() => setAction({ payout, kind: 'paid' })}
                            >
                              標記已付款
                            </Button>
                          )}
                          {payout.status !== 'FAILED' && payout.status !== 'PAID' && (
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => setAction({ payout, kind: 'failed' })}
                            >
                              標記失敗
                            </Button>
                          )}
                          {payout.status === 'PAID' && (
                            <span className="tiny dim">
                              {payout.paidAt ? dateOnly(payout.paidAt) : '已付款'}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager
              total={list.data?.total ?? 0}
              limit={LIMIT}
              offset={offset}
              onChange={setOffset}
            />
          </>
        )}
      </Card>

      {action && (
        <PayoutActionDialog
          payout={action.payout}
          kind={action.kind}
          onClose={() => setAction(null)}
          onDone={async (message) => {
            setAction(null);
            toast.push(message, 'ok');
            await list.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}
    </div>
  );
}

function PayoutActionDialog({
  payout,
  kind,
  onClose,
  onDone,
  onError,
}: {
  payout: AdminPayout;
  kind: 'paid' | 'failed';
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (kind === 'paid') {
        await api.admin.finance.markPaid(payout.id, value.trim() || undefined);
        await onDone(`${payout.merchantName} ${money(payout.netPayoutMinor)} 已標記為已付款`);
      } else {
        await api.admin.finance.markFailed(payout.id, value.trim());
        await onDone(`${payout.merchantName} 的批次已標記為付款失敗`);
      }
    } catch (caught) {
      onError((caught as Error).message);
      setBusy(false);
    }
  }

  const isPaid = kind === 'paid';
  const ready = isPaid || value.trim().length > 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={isPaid ? '標記已付款' : '標記付款失敗'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant={isPaid ? 'primary' : 'danger'}
            loading={busy}
            disabled={!ready}
            onClick={() => void submit()}
          >
            確認
          </Button>
        </>
      }
    >
      <Banner tone={isPaid ? 'info' : 'warn'}>
        {payout.merchantName} · {dateOnly(payout.periodStart)} 至 {dateOnly(payout.periodEnd)} · 淨額{' '}
        <strong>{money(payout.netPayoutMinor)}</strong>
        {isPaid
          ? '。此操作只記錄付款結果，不會實際轉帳。'
          : '。失敗的批次不會自動重試，需要人手處理。'}
      </Banner>

      {isPaid ? (
        <Field label="付款參考編號" hint="選填，例如銀行轉帳編號">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="TRF-20260101-001"
          />
        </Field>
      ) : (
        <Field label="失敗原因 *" hint="會寫入稽核記錄，供日後追查">
          <Textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="例如：銀行帳戶資料有誤"
            maxLength={500}
          />
        </Field>
      )}
    </Modal>
  );
}

/* ==========================================================================
   Reconciliation
   ========================================================================== */

function ReconciliationView() {
  const initial = defaultWindow();
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  const report = useAsync(
    () => api.admin.finance.reconciliation({ from, to, limit: 200 }),
    [from, to],
  );

  const data = report.data;

  return (
    <div className="stack">
      <Card tight>
        <div className="grid-3">
          <Field label="由">
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </Field>
          <Field label="至">
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Button onClick={() => void report.reload()}>重新核對</Button>
          </div>
        </div>
      </Card>

      <Banner tone="info" title="對帳在做什麼">
        比較「訂單上記錄的平台費」與「入帳分錄上的平台費」，逐商戶逐服務日核對。
        差額不為零代表有訂單已收款但入帳分錄沒寫入 —— 通常源於 outbox 事件失敗。
      </Banner>

      {report.error ? (
        <ErrorBlock error={report.error} onRetry={() => void report.reload()} />
      ) : !data ? (
        <Loading rows={6} />
      ) : (
        <>
          <div className="grid-3">
            <Stat
              label="總差額"
              value={money(data.totalDeltaMinor)}
              tone={data.totalDeltaMinor === 0 ? 'ok' : 'danger'}
              hint={data.totalDeltaMinor === 0 ? '帳目相符' : '需要追查'}
            />
            <Stat
              label="不符的服務日"
              value={data.mismatchedDays}
              tone={data.mismatchedDays === 0 ? 'ok' : 'danger'}
            />
            <Stat label="核對筆數" value={data.rows.length} />
          </div>

          {data.totalDeltaMinor === 0 && data.rows.length > 0 && (
            <Banner tone="ok" title="此期間的帳目相符">
              {dateOnly(data.from)} 至 {dateOnly(data.to)} 之間，所有商戶的平台費紀錄與入帳分錄一致。
            </Banner>
          )}

          <Card flush>
            <div style={{ padding: 'var(--space-4)' }}>
              <CardHead title="逐日核對" subtitle={`${dateOnly(data.from)} – ${dateOnly(data.to)}`} />
            </div>

            {data.rows.length === 0 ? (
              <Empty icon="📊" title="此期間沒有可核對的資料">
                選擇包含已完成訂單的日期範圍。
              </Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>商戶</th>
                      <th>服務日</th>
                      <th className="right">訂單平台費</th>
                      <th className="right">入帳平台費</th>
                      <th className="right">差額</th>
                      <th className="right">未入帳訂單</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => {
                      const mismatch = row.deltaMinor !== 0;
                      return (
                        <tr
                          key={`${row.merchantId}-${row.serviceDate}`}
                          style={mismatch ? { background: 'var(--danger-soft)' } : undefined}
                        >
                          <td className="strong">{row.merchantName}</td>
                          <td className="tiny num">{dateOnly(row.serviceDate)}</td>
                          <td className="right num">{money(row.ordersPlatformFeeMinor)}</td>
                          <td className="right num">{money(row.payoutPlatformFeeMinor)}</td>
                          <td
                            className="right num strong"
                            style={mismatch ? { color: 'var(--danger)' } : undefined}
                          >
                            {money(row.deltaMinor)}
                          </td>
                          <td className="right num">
                            {row.unsettledOrders > 0 ? (
                              <span style={{ color: 'var(--danger)' }}>{row.unsettledOrders}</span>
                            ) : (
                              <span className="dim">0</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
