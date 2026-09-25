'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
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
  Segmented,
  Textarea,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCart } from '@/lib/cart';
import { money, phone as formatPhone, timeOnly } from '@/lib/format';
import type { PaymentMode, PickupSlots } from '@/lib/types';
import { useAsync } from '@/lib/use-async';

/**
 * Checkout.
 *
 * The pickup time is chosen HERE rather than on the menu, because the lead-time
 * rule has to be evaluated at the moment of ordering: a slot that was valid
 * when the customer opened the menu may already be inside the 5-minute lead
 * window. The slot list is re-fetched on arrival for the same reason.
 *
 * The pricing shown before submitting is the customer's own arithmetic
 * (subtotal only). The authoritative breakdown — including the commission
 * split — comes back from `POST /orders` and is what the confirmation renders.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { cart, ready, clear, setQuantity } = useCart();
  const toast = useToast();

  const [slot, setSlot] = useState<string | null>(null);
  /**
   * How the customer intends to pay.
   *
   * Defaults to ONLINE so nothing changes for the existing flow, but it is a
   * real choice: `PAY_AT_STORE` skips the payment step entirely and makes the
   * merchant's counter confirmation the thing that advances the order.
   */
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('ONLINE');
  const [note, setNote] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const slots = useAsync<PickupSlots | null>(
    async () => (cart ? api.discovery.pickupSlots(cart.merchantSlug) : null),
    [cart?.merchantSlug],
  );

  useEffect(() => {
    if (user?.phone && !contactPhone) setContactPhone(user.phone);
  }, [user?.phone, contactPhone]);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login?next=/checkout');
  }, [authLoading, user, router]);

  /** Group the flat slot list by day, so "明天 12:30" is not just a bare time. */
  const slotGroups = useMemo(() => {
    const groups = new Map<number, PickupSlots['slots']>();
    for (const entry of slots.data?.slots ?? []) {
      const bucket = groups.get(entry.dayOffset) ?? [];
      bucket.push(entry);
      groups.set(entry.dayOffset, bucket);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [slots.data]);

  // Default to the earliest slot once they load — the common case is "as soon
  // as possible", and making the customer click through 40 slots to say so is
  // friction for nothing.
  useEffect(() => {
    if (slot === null && slots.data?.slots.length) setSlot(slots.data.slots[0]!.startAt);
  }, [slots.data, slot]);

  const subtotalMinor = cart?.lines.reduce((sum, l) => sum + l.unitPriceMinor * l.quantity, 0) ?? 0;

  async function placeOrder() {
    if (!cart) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api.orders.place(
        {
          merchantId: cart.merchantId,
          items: cart.lines.map((line) => ({
            menuItemId: line.menuItemId,
            quantity: line.quantity,
          })),
          ...(slot ? { scheduledPickupAt: slot } : {}),
          paymentMode,
          ...(note.trim() ? { customerNote: note.trim() } : {}),
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
        },
        // A double-tap must not create two orders. The API rejects a replayed
        // key rather than returning the original body, so the key is minted
        // once per submit attempt and never reused.
        crypto.randomUUID(),
      );

      clear();
      toast.push(`訂單 ${order.orderNo} 已建立`, 'ok');
      router.replace(`/orders/${order.id}?placed=1`);
    } catch (caught) {
      setError(caught as Error);
      setBusy(false);
    }
  }

  if (!ready || authLoading) {
    return (
      <>
        <CustomerNav />
        <div className="page">
          <Loading rows={4} />
        </div>
      </>
    );
  }

  if (!cart || cart.lines.length === 0) {
    return (
      <>
        <CustomerNav />
        <div className="page" style={{ maxWidth: 640 }}>
          <Card>
            <Empty
              icon="🛒"
              title="購物車是空的"
              action={
                <Link href="/">
                  <Button size="sm">去找餐廳</Button>
                </Link>
              }
            />
          </Card>
        </div>
      </>
    );
  }

  const orderable = slots.data?.slots.length ?? 0;

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 900 }}>
        <div className="stack">
          <div className="stack-sm" style={{ gap: 2 }}>
            <h1>確認訂單</h1>
            <span className="tiny muted">
              <Link href={`/m/${cart.merchantSlug}`}>{cart.merchantName}</Link> · 自取
            </span>
          </div>

          <div className="grid-2" style={{ alignItems: 'start' }}>
            <div className="stack">
              <Card>
                <CardHead
                  title="取餐時間"
                  subtitle="廚房會在你選的時間前開始製作"
                  action={
                    slots.data?.closedReason === 'CLOSED_FOR_CLOSURE' ? (
                      <Badge tone="warn" dot>
                        休息日
                      </Badge>
                    ) : slots.data?.acceptingNow ? (
                      <Badge tone="ok" dot>
                        現正營業
                      </Badge>
                    ) : (
                      <Badge tone="warn">非營業時間</Badge>
                    )
                  }
                />

                {slots.loading ? (
                  <Loading rows={2} />
                ) : slots.error ? (
                  <ErrorBlock error={slots.error} onRetry={() => void slots.reload()} />
                ) : orderable === 0 ? (
                  <Banner tone="warn">
                    此餐廳目前沒有可預約的取餐時段。可能是已打烊或今日已約滿，請稍後再試。
                  </Banner>
                ) : (
                  <div className="stack">
                    {slotGroups.map(([dayOffset, entries]) => (
                      <div key={dayOffset} className="stack-sm">
                        <span className="label">
                          {dayOffset === 0 ? '今天' : dayOffset === 1 ? '明天' : `${dayOffset} 日後`}
                        </span>
                        <div className="slot-grid">
                          {entries.map((entry) => (
                            <button
                              key={entry.startAt}
                              type="button"
                              className="slot"
                              data-active={slot === entry.startAt}
                              onClick={() => setSlot(entry.startAt)}
                            >
                              {entry.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {slot && (
                  <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
                    已選：{timeOnly(slot, slots.data?.timezone)}（
                    {new Intl.DateTimeFormat('zh-HK', {
                      timeZone: slots.data?.timezone,
                      month: 'long',
                      day: 'numeric',
                    }).format(new Date(slot))}
                    ）
                  </p>
                )}
              </Card>

              <Card>
                <CardHead
                  title="付款方式"
                  subtitle={
                    paymentMode === 'PAY_AT_STORE'
                      ? '下單後到店付款，店家確認收款後才會開始製作'
                      : '下單後在線上完成付款，廚房收到款項才開始製作'
                  }
                />
                <Segmented<PaymentMode>
                  value={paymentMode}
                  onChange={setPaymentMode}
                  options={[
                    { value: 'ONLINE', label: '線上付款' },
                    { value: 'PAY_AT_STORE', label: '到店付款' },
                  ]}
                />
                <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
                  {paymentMode === 'PAY_AT_STORE'
                    ? '到店付款不需預先付款。店家確認收到款項後，會提供預計取餐時間，屆時請依訂單頁顯示的時間到店取餐。'
                    : '下單後會進入付款步驟。逾時未付款的訂單會自動取消並釋放名額。'}
                </p>
              </Card>

              <Card>
                <CardHead title="訂單備註" subtitle="選填。廚房會看到這一段" />
                <div className="stack">
                  <Textarea
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="例如：少甜、走蔥、不要餐具"
                    maxLength={500}
                  />
                  <Field label="聯絡電話" hint="如訂單有問題，我們會以此號碼聯絡你">
                    <Input
                      type="tel"
                      value={contactPhone}
                      onChange={(event) => setContactPhone(event.target.value)}
                      placeholder="+85290000001"
                    />
                  </Field>
                  {user?.phone && (
                    <span className="tiny dim">
                      帳號登記號碼：{formatPhone(user.phone)}
                    </span>
                  )}
                </div>
              </Card>
            </div>

            <div className="stack">
              <Card>
                <CardHead title="餐點" subtitle={`${cart.lines.length} 項`} />
                <div className="stack-sm">
                  {cart.lines.map((line) => (
                    <div key={line.menuItemId} className="row-between">
                      <div className="grow stack-sm" style={{ gap: 0 }}>
                        <span className="truncate">{line.name}</span>
                        <span className="tiny dim">
                          {money(line.unitPriceMinor)} × {line.quantity}
                        </span>
                      </div>
                      <div className="qty">
                        <button
                          type="button"
                          onClick={() => setQuantity(line.menuItemId, line.quantity - 1)}
                          aria-label="減少"
                        >
                          −
                        </button>
                        <span>{line.quantity}</span>
                        <button
                          type="button"
                          onClick={() => setQuantity(line.menuItemId, line.quantity + 1)}
                          aria-label="增加"
                        >
                          +
                        </button>
                      </div>
                      <span className="num strong" style={{ minWidth: 66, textAlign: 'right' }}>
                        {money(line.unitPriceMinor * line.quantity)}
                      </span>
                    </div>
                  ))}
                </div>

                <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />

                <div className="stack-sm">
                  <div className="row-between">
                    <span className="muted">小計</span>
                    <span className="num">{money(subtotalMinor)}</span>
                  </div>
                  <div className="row-between">
                    <span className="muted">平台服務費</span>
                    <span className="num dim">HK$0.00</span>
                  </div>
                  <div className="row-between">
                    <span className="strong">應付總額</span>
                    <span className="num strong" style={{ fontSize: 17 }}>
                      {money(subtotalMinor)}
                    </span>
                  </div>
                </div>

                <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />

                {error && <ErrorBlock error={error} />}

                <Button
                  variant="primary"
                  size="lg"
                  block
                  loading={busy}
                  disabled={orderable === 0}
                  onClick={() => void placeOrder()}
                  style={{ marginTop: 'var(--space-3)' }}
                >
                  確認下單 · {money(subtotalMinor)}
                </Button>

                <p className="tiny dim center" style={{ marginTop: 'var(--space-2)' }}>
                  {paymentMode === 'PAY_AT_STORE'
                    ? '下單後請到店付款。店家確認收款並提供預計取餐時間後，廚房才會開始製作。'
                    : '下單後會進入付款步驟。逾時未付款的訂單會自動釋放。'}
                </p>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
