'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  ErrorBlock,
  Loading,
  Modal,
  Textarea,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TONE,
  PAYMENT_MODE_LABEL,
  PICKUP_PROGRESS,
  isTerminalOrder,
  money,
  progressIndex,
  timeOnly,
} from '@/lib/format';
import type { CustomerOrder, PaymentIntent } from '@/lib/types';
import { useAsync, useTicker } from '@/lib/use-async';
import { RefundRequestCard } from './refund-request-card';

function OrderDetail() {
  const params = useParams<{ orderId: string }>();
  const search = useSearchParams();
  const toast = useToast();
  const justPlaced = search.get('placed') === '1';

  const order = useAsync<CustomerOrder>(() => api.orders.get(params.orderId), [params.orderId]);
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  /**
   * Poll while the order can still move.
   *
   * There is no socket client in this app, so "live" updates come from here.
   * Without it the page showed whatever the status was on mount, and a customer
   * watching their order get accepted saw nothing change — the button-level
   * reloads only cover the actions *this* tab took.
   *
   * Stops on a terminal status: polling a finished order forever is just load.
   */
  const terminal = order.data ? isTerminalOrder(order.data.status) : false;
  useEffect(() => {
    if (terminal) return;
    const id = window.setInterval(() => void order.reload(), 5000);
    return () => window.clearInterval(id);
  }, [terminal, order.reload]);

  async function startPayment() {
    setBusy(true);
    setError(null);
    try {
      setIntent(await api.orders.paymentIntent(params.orderId));
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  async function simulatePayment() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.orders.simulatePayment(params.orderId);
      toast.push(result.notice, 'warn');
      await order.reload();
      setIntent(null);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setCancelling(true);
    try {
      await api.orders.cancel(params.orderId, cancelReason.trim() || '顧客取消');
      toast.push('訂單已取消', 'ok');
      setCancelOpen(false);
      await order.reload();
    } catch (caught) {
      toast.push(
        caught instanceof ApiError ? (caught.validationMessage ?? caught.message) : '取消失敗',
        'danger',
      );
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 780 }}>
        <div className="stack">
          {order.data?.pickupNotice && (
            <Banner
              // The notice carries the tone the API chose for this exact
              // status; `justPlaced` only upgrades it on arrival, because the
              // first thing a customer should see is "your order exists".
              tone={justPlaced ? 'ok' : order.data.pickupNotice.tone}
              title={
                justPlaced
                  ? `訂單已成立 · ${order.data.pickupNotice.title}`
                  : order.data.pickupNotice.title
              }
            >
              {order.data.pickupNotice.message}
            </Banner>
          )}

          {order.loading ? (
            <Loading rows={5} />
          ) : order.error ? (
            <ErrorBlock error={order.error} onRetry={() => void order.reload()} />
          ) : order.data ? (
            <OrderBody
              order={order.data}
              onPay={() => void startPayment()}
              onSimulate={() => void simulatePayment()}
              onCancel={() => setCancelOpen(true)}
              busy={busy}
              error={error}
              intent={intent}
            />
          ) : null}
        </div>
      </div>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="取消訂單"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              返回
            </Button>
            <Button variant="danger" loading={cancelling} onClick={() => void cancel()}>
              確認取消
            </Button>
          </>
        }
      >
        <p className="muted">
          已付款的訂單取消後會自動退款。廚房已開始製作後，取消需要商戶同意。
        </p>
        <Textarea
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
          placeholder="取消原因（選填）"
          maxLength={300}
        />
      </Modal>
    </>
  );
}

function OrderBody({
  order,
  onPay,
  onSimulate,
  onCancel,
  busy,
  error,
  intent,
}: {
  order: CustomerOrder;
  onPay: () => void;
  onSimulate: () => void;
  onCancel: () => void;
  busy: boolean;
  error: Error | null;
  intent: PaymentIntent | null;
}) {
  // Re-render every second while a payment is outstanding, so the "expires in"
  // line actually counts down instead of freezing at whatever it said on mount.
  useTicker(1000);

  const cancellable = ['PENDING_PAYMENT', 'PAID', 'ACCEPTED'].includes(order.status);
  const step = progressIndex(order.status);
  const terminal = isTerminalOrder(order.status);

  return (
    <>
      <Card>
        <div className="row-between">
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="tiny dim">訂單編號</span>
            <span className="mono strong">{order.orderNo}</span>
          </div>
          <Badge tone={ORDER_STATUS_TONE[order.status]} dot>
            {ORDER_STATUS_LABEL[order.status]}
          </Badge>
        </div>

        <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />

        <div className="row-between">
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="tiny dim">取餐碼</span>
            {order.pickupCode ? (
              <span className="pickup-code">{order.pickupCode}</span>
            ) : (
              <span className="muted">付款後產生</span>
            )}
          </div>
          <div className="stack-sm right" style={{ gap: 2 }}>
            <span className="tiny dim">
              {order.scheduledPickupAt ? '預約取餐' : '即時製作'}
            </span>
            <span className="strong">
              {order.scheduledPickupAt ? timeOnly(order.scheduledPickupAt) : '盡快'}
            </span>
          </div>
        </div>

        {/* The merchant's promise. Deliberately separate from 預約取餐 above:
            that is what the customer asked for, this is what the shop said it
            will actually do, and the two are allowed to differ. */}
        {order.estimatedReadyAt && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="row-between">
              <div className="stack-sm" style={{ gap: 2 }}>
                <span className="tiny dim">預計取餐時間</span>
                <span className="strong" style={{ fontSize: 18 }}>
                  {timeOnly(order.estimatedReadyAt, order.merchantTimezone)}
                </span>
              </div>
              <div className="stack-sm right" style={{ gap: 2 }}>
                <span className="tiny dim">店家預估</span>
                <span className="muted">
                  {order.readyInMinutes !== null ? `約 ${order.readyInMinutes} 分鐘` : '—'}
                </span>
              </div>
            </div>
          </>
        )}

        {/* The progress strip. Only for a live order — a cancelled one has no
            meaningful position on a fulfilment timeline. */}
        {!terminal && step >= 0 && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="row" style={{ gap: 4 }}>
              {PICKUP_PROGRESS.map((status, index) => (
                <div key={status} className="grow stack-sm" style={{ gap: 4, alignItems: 'center' }}>
                  <div
                    style={{
                      height: 4,
                      width: '100%',
                      borderRadius: 2,
                      background: index <= step ? 'var(--accent)' : 'var(--surface-3)',
                    }}
                  />
                  <span
                    className="tiny"
                    style={{ color: index <= step ? 'var(--accent)' : 'var(--text-dim)' }}
                  >
                    {ORDER_STATUS_LABEL[status]}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {order.status === 'PENDING_PAYMENT' && order.paymentMode === 'ONLINE' && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="stack">
              <Banner tone="warn" title="尚未付款">
                請完成付款。逾時未付款的訂單會自動取消並釋放名額。
              </Banner>

              {error && <ErrorBlock error={error} />}

              {intent ? (
                <div className="stack">
                  <Card tight>
                    <div className="stack-sm">
                      <div className="row-between tiny">
                        <span className="dim">支付服務</span>
                        <span className="mono">{intent.provider}</span>
                      </div>
                      <div className="row-between tiny">
                        <span className="dim">交易參考</span>
                        <span className="mono truncate">{intent.providerRef}</span>
                      </div>
                      <div className="row-between tiny">
                        <span className="dim">金額</span>
                        <span className="num strong">{money(intent.amountMinor)}</span>
                      </div>
                    </div>
                  </Card>

                  {intent.notice && (
                    <Banner tone="warn" title="模擬付款模式">
                      {intent.notice}
                    </Banner>
                  )}

                  {intent.clientSecret && (
                    <p className="tiny dim">
                      clientSecret 已備妥，正式環境會交予支付 SDK 完成 3-D Secure 驗證。
                    </p>
                  )}

                  {intent.notice && (
                    <Button variant="primary" loading={busy} onClick={onSimulate}>
                      模擬付款成功
                    </Button>
                  )}
                </div>
              ) : (
                <Button variant="primary" size="lg" loading={busy} onClick={onPay}>
                  前往付款 · {money(order.totalMinor)}
                </Button>
              )}
            </div>
          </>
        )}

        {/* Pay-at-store has no payment step to take. Showing a 前往付款 button
            here would send the customer into a flow the API rejects with
            409 PAYMENT_NOT_REQUIRED — the notice banner above already carries
            the instructions, this is just the reassurance that nothing is
            outstanding on their side. */}
        {order.status === 'PENDING_PAYMENT' && order.paymentMode === 'PAY_AT_STORE' && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="stack">
              <Banner tone="warn" title="到店付款">
                請到店付款。店家確認收到款項後，會提供預計取餐時間並開始製作。
              </Banner>
              <p className="tiny dim">
                你不需要在網上付款，也不必留在這個頁面。店家確認後，重新整理即可看到取餐時間。
              </p>
            </div>
          </>
        )}
      </Card>

      <Card>
        <CardHead title="餐點明細" subtitle={`${order.items.length} 項`} />
        <div className="stack-sm">
          {order.items.map((line, index) => (
            <div key={`${line.menuItemId}-${index}`} className="row-between">
              <div className="grow stack-sm" style={{ gap: 0 }}>
                <span className="truncate">{line.nameSnapshot}</span>
                <span className="tiny dim">
                  {money(line.unitPriceMinor)} × {line.quantity}
                  {line.isMainItem && ' · 主餐'}
                </span>
              </div>
              <span className="num">{money(line.lineTotalMinor)}</span>
            </div>
          ))}
        </div>

        <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />

        <div className="row-between">
          <span className="strong">應付總額</span>
          <span className="num strong" style={{ fontSize: 17 }}>
            {money(order.totalMinor)}
          </span>
        </div>

        <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />

        <div className="row-between">
          <span className="muted">付款方式</span>
          <span>{PAYMENT_MODE_LABEL[order.paymentMode] ?? order.paymentMode}</span>
        </div>

        {order.customerNote && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="stack-sm">
              <span className="label">你的備註</span>
              <span className="muted">{order.customerNote}</span>
            </div>
          </>
        )}

        {/* The kitchen's own words. Kept visually distinct from the customer's
            note so it is never mistaken for something they wrote. */}
        {order.merchantNote && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
            <div className="stack-sm">
              <span className="label">店家訊息</span>
              <span className="muted">{order.merchantNote}</span>
            </div>
          </>
        )}
      </Card>

      <RefundRequestCard
        orderId={order.id}
        orderNo={order.orderNo}
        orderTotalMinor={order.totalMinor}
        orderStatus={order.status}
        openTicketStatus={
          order.refundRequests.find(
            (ticket) => ticket.status === 'OPEN' || ticket.status === 'IN_DISCUSSION',
          )?.status ?? null
        }
        hasAnyTicket={order.refundRequests.length > 0}
      />

      <div className="row-wrap">
        <Link href="/orders">
          <Button variant="ghost">← 我的訂單</Button>
        </Link>
        {cancellable && (
          <Button variant="danger" onClick={onCancel}>
            取消訂單
          </Button>
        )}
      </div>
    </>
  );
}

export default function OrderDetailPage() {
  return (
    <Suspense fallback={null}>
      <OrderDetail />
    </Suspense>
  );
}
