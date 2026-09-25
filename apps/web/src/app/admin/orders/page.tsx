'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AdminShell, Pager } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorBlock,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync, useDebounced } from '@/lib/use-async';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  PAYMENT_STATUS_LABEL,
  REFUND_STATUS_LABEL,
  dateTime,
  money,
  moneyBare,
  timeOnly,
} from '@/lib/format';
import type { AdminOrder, AdminOrderSummary, OrderStatus } from '@/lib/types';

const LIMIT = 25;

const ALL_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
];

/**
 * `useSearchParams` needs a Suspense boundary in the App Router, because the
 * page is prerendered at build time and the query string is not known then.
 * Without it `next build` fails the route rather than degrading it.
 */
export default function AdminOrdersPage() {
  return (
    <Suspense fallback={<div className="page"><Loading rows={5} /></div>}>
      <OrdersView />
    </Suspense>
  );
}

function OrdersView() {
  const search = useSearchParams();
  const toast = useToast();

  const [status, setStatus] = useState<string>(search.get('status') ?? '');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const debouncedQuery = useDebounced(query, 350);

  const list = useAsync(
    () =>
      api.admin.orders.list({
        ...(status ? { status } : {}),
        ...(debouncedQuery ? { q: debouncedQuery } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        limit: LIMIT,
        offset,
      }),
    [status, debouncedQuery, from, to, offset],
  );

  const reset = () => {
    setOffset(0);
  };

  return (
    <AdminShell
      title="訂單"
      subtitle={list.data ? `共 ${list.data.total} 張` : undefined}
      actions={
        <Button size="sm" onClick={() => void list.reload()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <Card tight>
          <div className="grid-4">
            <Field label="狀態">
              <Select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  reset();
                }}
              >
                <option value="">全部（進行中優先）</option>
                {ALL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {ORDER_STATUS_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="搜尋" hint="訂單號、取餐碼、顧客電話">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  reset();
                }}
                placeholder="ORD-…"
              />
            </Field>
            <Field label="由">
              <Input
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value);
                  reset();
                }}
              />
            </Field>
            <Field label="至">
              <Input
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.target.value);
                  reset();
                }}
              />
            </Field>
          </div>
        </Card>

        <Card flush>
          {list.error ? (
            <ErrorBlock error={list.error} onRetry={() => void list.reload()} />
          ) : list.loading && !list.data ? (
            <Loading rows={6} />
          ) : (list.data?.data.length ?? 0) === 0 ? (
            <Empty icon="🧾" title="沒有符合條件的訂單">
              調整篩選條件或日期範圍再試。
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>訂單</th>
                      <th>狀態</th>
                      <th>商戶</th>
                      <th>顧客</th>
                      <th>取餐</th>
                      <th className="right">總額</th>
                      <th className="right">平台費</th>
                      <th className="right">入帳</th>
                      <th className="right">已退款</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data?.data.map((order) => (
                      <OrderRow key={order.id} order={order} onOpen={() => setOpenId(order.id)} />
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
      </div>

      {openId && (
        <OrderDetail
          orderId={openId}
          onClose={() => setOpenId(null)}
          onChanged={async (message) => {
            toast.push(message, 'ok');
            await list.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}
    </AdminShell>
  );
}

function OrderRow({ order, onOpen }: { order: AdminOrderSummary; onOpen: () => void }) {
  return (
    <tr data-clickable="true" onClick={onOpen}>
      <td>
        <div className="stack-sm" style={{ gap: 1 }}>
          <span className="mono strong">{order.orderNo}</span>
          <span className="tiny dim">
            {dateTime(order.createdAt)}
            {order.pickupCode ? ` · 取餐碼 ${order.pickupCode}` : ''}
          </span>
        </div>
      </td>
      <td>
        <Badge tone={ORDER_STATUS_TONE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</Badge>
      </td>
      <td className="truncate" style={{ maxWidth: 160 }}>
        {order.merchant?.name ?? <span className="dim">—</span>}
      </td>
      <td className="truncate" style={{ maxWidth: 140 }}>
        {order.customer?.displayName ?? <span className="dim">—</span>}
      </td>
      <td className="num tiny">
        {order.scheduledPickupAt ? timeOnly(order.scheduledPickupAt) : '即時'}
      </td>
      <td className="right num strong">{money(order.totalMinor)}</td>
      <td className="right num">{money(order.platformFeeMinor)}</td>
      <td className="right num">{money(order.merchantPayoutMinor)}</td>
      <td className="right num">
        {order.refundedMinor > 0 ? (
          <span style={{ color: 'var(--danger)' }}>{money(order.refundedMinor)}</span>
        ) : (
          <span className="dim">—</span>
        )}
      </td>
    </tr>
  );
}

/* ==========================================================================
   Detail
   ========================================================================== */

function OrderDetail({
  orderId,
  onClose,
  onChanged,
  onError,
}: {
  orderId: string;
  onClose: () => void;
  onChanged: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const state = useAsync<AdminOrder>(() => api.admin.orders.get(orderId), [orderId]);
  const [transitionTo, setTransitionTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

  const order = state.data;

  async function runTransition() {
    if (!order || !transitionTo) return;
    setBusy(true);
    try {
      const result = await api.admin.orders.transition(order.id, transitionTo, reason.trim());
      onChanged(
        `${order.orderNo}：${ORDER_STATUS_LABEL[result.fromStatus as OrderStatus]} → ${
          ORDER_STATUS_LABEL[result.toStatus as OrderStatus]
        }`,
      );
      setTransitionTo('');
      setReason('');
      await state.reload();
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={order ? `${order.orderNo}` : '載入中…'}
      footer={
        <Button variant="ghost" onClick={onClose}>
          關閉
        </Button>
      }
    >
      {state.error ? (
        <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
      ) : !order ? (
        <Loading rows={5} />
      ) : (
        <div className="stack">
          <div className="row-wrap">
            <Badge tone={ORDER_STATUS_TONE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</Badge>
            <span className="tiny muted">
              {order.merchant?.name ?? '—'} · {dateTime(order.createdAt)}
            </span>
            {order.pickupCode && (
              <span className="tiny">
                取餐碼 <span className="mono strong">{order.pickupCode}</span>
              </span>
            )}
          </div>

          {/* ---- items ---------------------------------------------------- */}
          <div className="stack-sm">
            {order.items.map((item, index) => (
              <div className="row-between" key={`${item.nameSnapshot}-${index}`}>
                <span>
                  {item.nameSnapshot}
                  {item.isMainItem && <span className="tiny dim"> · 主餐</span>}
                </span>
                <span className="num muted">
                  ×{item.quantity} · {moneyBare(item.lineTotalMinor)}
                </span>
              </div>
            ))}
          </div>

          <hr className="divider" />

          {/* ---- pricing snapshot ----------------------------------------- */}
          <div className="stack-sm">
            <span className="tiny dim">下單時的計費快照</span>
            <div className="row-between">
              <span className="tiny muted">小計</span>
              <span className="num">{money(order.subtotalMinor)}</span>
            </div>
            <div className="row-between">
              <span className="tiny muted">
                平台費（主餐 {order.mainItemCount} 件 ×{' '}
                {money(order.pricingSnapshot.appliedPolicy.feePerMainItemMinor)}）
              </span>
              <span className="num">{money(order.platformFeeMinor)}</span>
            </div>
            <div className="row-between">
              <span className="tiny muted">支付手續費</span>
              <span className="num">{money(order.paymentFeeMinor)}</span>
            </div>
            <div className="row-between">
              <span className="tiny muted">顧客服務費</span>
              <span className="num">{money(order.customerServiceFeeMinor)}</span>
            </div>
            <div className="row-between strong">
              <span>顧客支付</span>
              <span className="num">{money(order.totalMinor)}</span>
            </div>
            <div className="row-between">
              <span className="tiny muted">商戶入帳</span>
              <span className="num strong">{money(order.merchantPayoutMinor)}</span>
            </div>
          </div>

          <Banner tone="info" title="這筆訂單的金額不會隨平台設定改變">
            上表來自下單當時的計費快照（每件 {money(order.pricingSnapshot.appliedPolicy.feePerMainItemMinor)}
            、手續費 {money(order.pricingSnapshot.appliedPolicy.paymentFeeFixedMinor)} +{' '}
            {order.pricingSnapshot.appliedPolicy.paymentFeeRateBps / 100}%）。
            之後調整平台設定只影響新訂單。
          </Banner>

          {/* ---- payments + refunds -------------------------------------- */}
          {order.payments.length > 0 && (
            <div className="stack-sm">
              <span className="tiny dim">付款</span>
              {order.payments.map((payment) => (
                <div className="row-between" key={payment.id}>
                  <span className="tiny">
                    {payment.provider} · {PAYMENT_STATUS_LABEL[payment.status] ?? payment.status}
                  </span>
                  <span className="num tiny">
                    {money(payment.amountMinor)}
                    {payment.refundedMinor > 0 ? ` · 已退 ${money(payment.refundedMinor)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {order.refunds.length > 0 && (
            <div className="stack-sm">
              <span className="tiny dim">退款</span>
              {order.refunds.map((refund) => (
                <div className="row-between" key={refund.id}>
                  <span className="tiny">
                    {REFUND_STATUS_LABEL[refund.status] ?? refund.status} · {refund.reason}
                  </span>
                  <span className="num tiny">{money(refund.amountMinor)}</span>
                </div>
              ))}
            </div>
          )}

          {/* ---- timeline ------------------------------------------------ */}
          {order.statusEvents.length > 0 && (
            <div className="stack-sm">
              <span className="tiny dim">狀態歷程</span>
              {order.statusEvents.map((event) => (
                <div className="row-between" key={event.id}>
                  <span className="tiny">
                    {event.fromStatus
                      ? `${ORDER_STATUS_LABEL[event.fromStatus]} → `
                      : ''}
                    <strong>{ORDER_STATUS_LABEL[event.toStatus]}</strong>
                    <span className="dim">
                      {' '}
                      · {event.actorName ?? event.actor}
                      {event.reason ? ` · ${event.reason}` : ''}
                    </span>
                  </span>
                  <span className="tiny dim nowrap">{timeOnly(event.createdAt)}</span>
                </div>
              ))}
            </div>
          )}

          <hr className="divider" />

          {/* ---- admin actions -------------------------------------------- */}
          {order.allowedAdminTransitions.length === 0 ? (
            <Banner tone="info">此訂單已進入終態，沒有可執行的管理操作。</Banner>
          ) : (
            <div className="stack">
              <span className="tiny dim">管理操作</span>
              <div className="row-wrap">
                {order.allowedAdminTransitions.map((target) => (
                  <Button
                    key={target}
                    size="sm"
                    variant={transitionTo === target ? 'primary' : 'default'}
                    onClick={() => setTransitionTo(target)}
                  >
                    改為「{ORDER_STATUS_LABEL[target]}」
                  </Button>
                ))}
              </div>

              {transitionTo && (
                <>
                  <Field
                    label="操作原因 *"
                    hint="會寫入訂單歷程與稽核記錄，顧客可見的部分會顯示此原因"
                  >
                    <Textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="例如：顧客來電取消"
                      maxLength={500}
                    />
                  </Field>
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button variant="ghost" size="sm" onClick={() => setTransitionTo('')}>
                      取消
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy}
                      disabled={reason.trim().length === 0}
                      onClick={() => void runTransition()}
                    >
                      確認改為「{ORDER_STATUS_LABEL[transitionTo as OrderStatus]}」
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <Button size="sm" variant="danger" onClick={() => setRefundOpen(true)}>
              退款
            </Button>
          </div>
        </div>
      )}

      {order && refundOpen && (
        <RefundDialog
          order={order}
          onClose={() => setRefundOpen(false)}
          onDone={async (message) => {
            setRefundOpen(false);
            onChanged(message);
            await state.reload();
          }}
          onError={onError}
        />
      )}
    </Modal>
  );
}

function RefundDialog({
  order,
  onClose,
  onDone,
  onError,
}: {
  order: AdminOrder;
  onClose: () => void;
  onDone: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const paid = order.payments.reduce((sum, payment) => sum + payment.amountMinor, 0);
  const alreadyRefunded = order.payments.reduce((sum, payment) => sum + payment.refundedMinor, 0);
  const refundable = Math.max(0, paid - alreadyRefunded);

  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState((refundable / 100).toFixed(2));
  const [busy, setBusy] = useState(false);

  const parsed = Math.round(Number.parseFloat(amount) * 100);
  const valid = Number.isFinite(parsed) && parsed > 0 && parsed <= refundable;

  async function submit() {
    setBusy(true);
    try {
      const result = await api.admin.orders.refund(order.id, reason.trim(), parsed);
      onDone(
        result.notice
          ? `${order.orderNo} 已退款 ${money(result.refund.amountMinor)}（${result.notice}）`
          : `${order.orderNo} 已退款 ${money(result.refund.amountMinor)}`,
      );
    } catch (caught) {
      onError((caught as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`退款 ${order.orderNo}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!valid || reason.trim().length === 0}
            onClick={() => void submit()}
          >
            確認退款
          </Button>
        </>
      }
    >
      <Banner tone="warn">
        可退款上限 {money(refundable)}
        {alreadyRefunded > 0 ? `（已退 ${money(alreadyRefunded)}）` : ''}。
        退款會寫入稽核記錄，且不會自動改變訂單狀態。
      </Banner>

      <Field label="退款金額（HK$）*">
        <Input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          className={valid ? '' : 'input-error'}
        />
      </Field>

      <Field label="退款原因 *" hint="會記錄在退款單與稽核記錄中">
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="例如：商戶無法出餐，全額退款"
          maxLength={500}
        />
      </Field>
    </Modal>
  );
}
