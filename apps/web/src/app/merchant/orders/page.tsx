'use client';

import { useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
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
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { useAsync, useTicker } from '@/lib/use-async';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  countdown,
  money,
  timeOnly,
} from '@/lib/format';
import type { MerchantOrder, OrderStatus } from '@/lib/types';

type KitchenAction =
  | 'accept'
  | 'reject'
  | 'cancel'
  | 'start-preparing'
  | 'mark-ready'
  | 'complete';

interface ActionSpec {
  action: KitchenAction;
  label: string;
  variant: 'primary' | 'danger' | 'default';
  /** Opens the reason modal instead of firing straight away. */
  needsReason?: boolean;
}

/**
 * The kitchen's moves, keyed by the status they are legal from.
 *
 * The API's state machine is the authority — this table only decides which
 * buttons to draw, so a stale board cannot invent a transition. If the two ever
 * disagree, the API answers 409 and the board refreshes to the truth.
 *
 * `MerchantOrderView` does not carry an `allowedNextTransitions` list the way
 * `AdminOrder` does, so this is a mirror rather than a projection. That is the
 * one place in the front end where the lifecycle is duplicated, and it is
 * confined to this constant.
 *
 * Two statuses are absent on purpose:
 *   - `PENDING_PAYMENT` and `PAID` both lead with **確認訂單**, which is not a
 *     bare status change — it settles the counter payment *and* records the
 *     pickup promise in one call, so it is rendered separately from this table.
 *   - `PENDING_PAYMENT` may only be *declined*, and only for a pay-at-store
 *     order; the `MANUAL_SETTLEMENT_ALLOWED` guard is what enforces that, so
 *     the button exists but the API still has the final word.
 */
const ACTIONS_FROM: Partial<Record<OrderStatus, ActionSpec[]>> = {
  PENDING_PAYMENT: [
    { action: 'cancel', label: '無法接單', variant: 'danger', needsReason: true },
  ],
  PAID: [{ action: 'reject', label: '拒單', variant: 'danger', needsReason: true }],
  ACCEPTED: [
    { action: 'start-preparing', label: '開始製作', variant: 'primary' },
    { action: 'reject', label: '拒單', variant: 'danger', needsReason: true },
  ],
  PREPARING: [{ action: 'mark-ready', label: '完成製作', variant: 'primary' }],
  READY_FOR_PICKUP: [{ action: 'complete', label: '顧客已取餐', variant: 'primary' }],
};

/** Statuses where 確認訂單 is the primary move. */
const CONFIRMABLE: OrderStatus[] = ['PENDING_PAYMENT', 'PAID'];

type Tab = 'AWAITING_SETTLEMENT' | 'PAID' | 'IN_PROGRESS' | 'READY_FOR_PICKUP' | 'ALL';

const TAB_FILTER: Record<Tab, OrderStatus[]> = {
  AWAITING_SETTLEMENT: ['PENDING_PAYMENT'],
  PAID: ['PAID'],
  IN_PROGRESS: ['ACCEPTED', 'PREPARING'],
  READY_FOR_PICKUP: ['READY_FOR_PICKUP'],
  ALL: ['PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'],
};

/** Offered as one tap in the confirm modal, in the order a kitchen thinks. */
const QUICK_MINUTES = [10, 15, 20, 30, 45, 60];

/** The board re-reads the queue this often. Slow enough not to hammer the API. */
const POLL_MS = 15_000;

export default function MerchantOrdersPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('AWAITING_SETTLEMENT');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<MerchantOrder | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<MerchantOrder | null>(null);
  const [readyInMinutes, setReadyInMinutes] = useState<number | null>(null);
  const [customMinutes, setCustomMinutes] = useState('');
  const [confirmNote, setConfirmNote] = useState('');

  const poll = useTicker(POLL_MS);
  /** A 1s clock, kept out of the fetch deps so the countdown does not refetch. */
  useTicker(1000);

  const state = useAsync<{ data: MerchantOrder[] }>(
    () =>
      merchantId
        ? api.kitchen.list(merchantId, { status: 'ACTIVE', limit: 200 })
        : Promise.resolve({ data: [] }),
    [merchantId, poll],
  );

  if (!merchant || !merchantId) return null;

  const timeZone = merchant.timezone;
  const all = state.data?.data ?? [];
  const orders = all.filter((order) => TAB_FILTER[tab].includes(order.status));

  const countOf = (statuses: OrderStatus[]) =>
    all.filter((order) => statuses.includes(order.status)).length;

  async function run(order: MerchantOrder, action: KitchenAction, note?: string) {
    setPendingId(order.id);
    try {
      await api.kitchen.act(merchantId!, order.id, action, note);
      const labels: Record<KitchenAction, string> = {
        accept: '已接單',
        reject: '已拒單，系統將安排退款',
        cancel: '已取消，名額已釋放',
        'start-preparing': '已開始製作',
        'mark-ready': '已完成製作，顧客可取餐',
        complete: '訂單已完成',
      };
      const warn = action === 'reject' || action === 'cancel';
      toast.push(`${order.orderNo} ${labels[action]}`, warn ? 'warn' : 'ok');
      setRejecting(null);
      setReason('');
      await state.reload();
    } catch (caught) {
      // A 409 here means the board was stale — reload so the buttons match
      // reality before the operator tries again.
      toast.push((caught as Error).message, 'danger');
      await state.reload();
    } finally {
      setPendingId(null);
    }
  }

  function openConfirm(order: MerchantOrder) {
    setConfirming(order);
    setReadyInMinutes(null);
    setCustomMinutes('');
    setConfirmNote('');
  }

  /** A typed number wins over a quick pick; empty means "use the shop default". */
  const effectiveMinutes = (() => {
    const custom = Number.parseInt(customMinutes, 10);
    if (Number.isFinite(custom) && custom >= 1 && custom <= 240) return custom;
    return readyInMinutes;
  })();

  const promisedAt =
    effectiveMinutes !== null ? new Date(Date.now() + effectiveMinutes * 60_000) : null;

  async function confirmOrder() {
    const order = confirming;
    if (!order) return;
    setPendingId(order.id);
    try {
      const result = await api.kitchen.confirm(merchantId!, order.id, {
        ...(effectiveMinutes !== null ? { readyInMinutes: effectiveMinutes } : {}),
        ...(confirmNote.trim() ? { note: confirmNote.trim() } : {}),
      });
      const when = result.estimatedReadyAt
        ? `預計 ${timeOnly(result.estimatedReadyAt, timeZone)} 可取`
        : '已接單';
      toast.push(
        `${order.orderNo} ${result.settledOffline ? '已確認收款並接單' : '已接單'} · ${when}`,
        'ok',
      );
      setConfirming(null);
      await state.reload();
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
      await state.reload();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <MerchantShell
      title="訂單廚房板"
      subtitle={`${merchant.name} · 每 ${POLL_MS / 1000} 秒自動更新`}
      counts={{ activeOrders: all.length }}
      actions={
        <Button size="sm" onClick={() => void state.reload()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        {!merchant.acceptsOrders && merchant.status === 'ACTIVE' && (
          <Banner tone="warn" title="接單已暫停">
            你可以處理已存在的訂單，但新的訂單會被系統自動拒單。要恢復接單請到「今日概況」。
          </Banner>
        )}

        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            {
              value: 'AWAITING_SETTLEMENT',
              label: '待確認收款',
              count: countOf(['PENDING_PAYMENT']),
            },
            { value: 'PAID', label: '待接單', count: countOf(['PAID']) },
            { value: 'IN_PROGRESS', label: '製作中', count: countOf(['ACCEPTED', 'PREPARING']) },
            {
              value: 'READY_FOR_PICKUP',
              label: '可取餐',
              count: countOf(['READY_FOR_PICKUP']),
            },
            { value: 'ALL', label: '全部', count: all.length },
          ]}
        />

        {state.error ? (
          <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
        ) : state.loading && all.length === 0 ? (
          <Loading rows={4} />
        ) : orders.length === 0 ? (
          <Card>
            <Empty icon="✓" title="這個分類沒有訂單">
              {tab === 'AWAITING_SETTLEMENT'
                ? '有顧客選擇到店付款時，訂單會出現在這裡等你確認收款。'
                : tab === 'PAID'
                  ? '新訂單進來時會自動出現在這裡。'
                  : '切換上方分類查看其他訂單。'}
            </Empty>
          </Card>
        ) : (
          <div className="grid-2">
            {orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                timeZone={timeZone}
                busy={pendingId === order.id}
                onAct={(action) => {
                  if (action === 'reject' || action === 'cancel') {
                    setRejecting(order);
                    setReason('');
                    return;
                  }
                  void run(order, action);
                }}
                onConfirm={() => openConfirm(order)}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={`確認訂單 ${confirming?.orderNo ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              返回
            </Button>
            <Button
              variant="primary"
              loading={pendingId === confirming?.id}
              onClick={() => void confirmOrder()}
            >
              確認並接單
            </Button>
          </>
        }
      >
        {confirming && (
          <div className="stack">
            {confirming.status === 'PENDING_PAYMENT' ? (
              <Banner tone="warn" title="確認已收到款項">
                按「確認並接單」即代表你已收到 {money(confirming.totalMinor)}。
                系統會為這張訂單記錄一筆手動收款，顧客端會立即看到你提供的取餐時間。
              </Banner>
            ) : (
              <Banner tone="info" title="款項已由線上支付收取">
                你只需確認接單，並告訴顧客預計何時可以取餐。
              </Banner>
            )}

            <div className="stack-sm">
              <span className="label">預計取餐時間</span>
              <div className="slot-grid">
                {QUICK_MINUTES.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className="slot"
                    data-active={effectiveMinutes === minutes}
                    onClick={() => {
                      setReadyInMinutes(minutes);
                      setCustomMinutes('');
                    }}
                  >
                    {minutes} 分鐘
                  </button>
                ))}
              </div>
              <Field
                label="自訂分鐘"
                hint={`留空則用店家預設的 ${merchant.prepTimeMinutes} 分鐘`}
              >
                <Input
                  type="number"
                  min={1}
                  max={240}
                  inputMode="numeric"
                  value={customMinutes}
                  onChange={(event) => setCustomMinutes(event.target.value)}
                  placeholder={String(merchant.prepTimeMinutes)}
                />
              </Field>
              {promisedAt && (
                <p className="tiny dim">
                  顧客會看到「約 {effectiveMinutes} 分鐘」＝
                  {timeOnly(promisedAt.toISOString(), timeZone)} 可取。
                </p>
              )}
            </div>

            <Field label="給顧客的訊息" hint="選填。會直接顯示在顧客的訂單頁">
              <Textarea
                value={confirmNote}
                onChange={(event) => setConfirmNote(event.target.value)}
                placeholder="例如：飲品已放雪櫃，到櫃檯報取餐碼即可"
                maxLength={300}
              />
            </Field>
          </div>
        )}
      </Modal>

      <Modal
        open={rejecting !== null}
        onClose={() => setRejecting(null)}
        title={`${rejecting?.status === 'PENDING_PAYMENT' ? '無法接單' : '拒單'} ${
          rejecting?.orderNo ?? ''
        }`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={reason.trim().length === 0}
              loading={pendingId === rejecting?.id}
              onClick={() =>
                rejecting &&
                void run(rejecting, rejecting.status === 'PENDING_PAYMENT' ? 'cancel' : 'reject', reason.trim())
              }
            >
              {rejecting?.status === 'PENDING_PAYMENT' ? '確認取消訂單' : '確認拒單'}
            </Button>
          </>
        }
      >
        {rejecting?.status === 'PENDING_PAYMENT' ? (
          <Banner tone="warn">
            這張訂單還沒收到款項，取消不會產生退款。名額會立即釋放，顧客會看到你填寫的原因。
          </Banner>
        ) : (
          <Banner tone="warn">
            拒單會觸發全額退款，並記錄在訂單歷程中。顧客會看到你填寫的原因，請具體說明。
          </Banner>
        )}
        <Field
          label={rejecting?.status === 'PENDING_PAYMENT' ? '取消原因 *' : '拒單原因 *'}
          hint="例如：今日食材售罄 / 設備故障"
        >
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="今日已售罄，抱歉"
            maxLength={500}
          />
        </Field>
      </Modal>
    </MerchantShell>
  );
}

function OrderCard({
  order,
  timeZone,
  busy,
  onAct,
  onConfirm,
}: {
  order: MerchantOrder;
  timeZone: string;
  busy: boolean;
  onAct: (action: KitchenAction) => void;
  onConfirm: () => void;
}) {
  const actions = ACTIONS_FROM[order.status] ?? [];
  const confirmable = CONFIRMABLE.includes(order.status);
  const remaining = countdown(order.acceptDeadlineAt);
  const overdue = order.status === 'PAID' && order.acceptDeadlineAt !== null && remaining === null;
  const itemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <Card>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <strong className="mono">{order.orderNo}</strong>
            <Badge tone={ORDER_STATUS_TONE[order.status]}>
              {ORDER_STATUS_LABEL[order.status]}
            </Badge>
            {order.paymentMode === 'PAY_AT_STORE' && (
              <Badge tone={order.status === 'PENDING_PAYMENT' ? 'warn' : 'neutral'}>
                到店付款
              </Badge>
            )}
          </div>
          <span className="tiny muted">
            下單 {timeOnly(order.createdAt, timeZone)} · 取餐{' '}
            {order.scheduledPickupAt ? timeOnly(order.scheduledPickupAt, timeZone) : '即時'}
          </span>
        </div>

        {order.status === 'READY_FOR_PICKUP' && order.pickupCode && (
          <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
            <span className="tiny dim">取餐碼</span>
            <span className="pickup-code" style={{ fontSize: 22 }}>
              {order.pickupCode}
            </span>
          </div>
        )}
      </div>

      {order.status === 'PAID' && order.acceptDeadlineAt && (
        <div
          className="row-between"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: overdue ? 'var(--danger-soft)' : 'var(--warn-soft)',
            color: overdue ? 'var(--danger)' : 'var(--warn)',
          }}
        >
          <span className="tiny strong">{overdue ? '已逾接單時限' : '接單倒數'}</span>
          <span className="num strong">{remaining ?? '00:00'}</span>
        </div>
      )}

      {order.status === 'PENDING_PAYMENT' && (
        <div
          className="row-between"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--warn-soft)',
            color: 'var(--warn)',
          }}
        >
          <span className="tiny strong">等待確認收款</span>
          <span className="num strong">{money(order.totalMinor)}</span>
        </div>
      )}

      <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

      <div className="stack-sm">
        {order.items.map((item, index) => (
          <div className="row-between" key={`${item.nameSnapshot}-${index}`}>
            <span>
              <span className="strong">{item.nameSnapshot}</span>
              {item.isMainItem && (
                <span className="tiny dim" style={{ marginLeft: 6 }}>
                  主餐
                </span>
              )}
            </span>
            <span className="num muted">×{item.quantity}</span>
          </div>
        ))}
      </div>

      {order.customerNote && (
        <div
          className="tiny"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span className="dim">備註：</span>
          {order.customerNote}
        </div>
      )}

      {/* Only shown once the promise exists. Before 確認訂單 there is nothing to
          echo back, and a "—" here would read as "we do not know". */}
      {order.estimatedReadyAt && (
        <div
          className="tiny"
          style={{
            marginTop: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span className="dim">已承諾顧客：</span>
          {timeOnly(order.estimatedReadyAt, timeZone)}
          {order.readyInMinutes !== null && (
            <span className="dim"> · 約 {order.readyInMinutes} 分鐘</span>
          )}
        </div>
      )}

      <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

      <div className="row-between">
        <div className="stack-sm" style={{ gap: 0 }}>
          <span className="tiny muted">
            共 {itemCount} 件 · 主餐 {order.mainItemCount} 件
          </span>
          <span className="tiny dim">
            顧客付 {money(order.totalMinor)} · 你入帳 {money(order.merchantPayoutMinor)}
          </span>
        </div>

        <div className="row-wrap">
          {confirmable && (
            <Button variant="primary" size="sm" loading={busy} onClick={onConfirm}>
              確認訂單
            </Button>
          )}
          {actions.map((spec) => (
            <Button
              key={spec.action}
              variant={spec.variant}
              size="sm"
              loading={busy}
              onClick={() => onAct(spec.action)}
            >
              {spec.label}
            </Button>
          ))}
        </div>
      </div>
    </Card>
  );
}
