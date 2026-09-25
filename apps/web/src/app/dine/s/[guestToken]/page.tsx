'use client';

import { use, useMemo, useState } from 'react';
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
  Tabs,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, money } from '@/lib/format';
import type { MenuItem } from '@/lib/types';

// ---------------------------------------------------------------------------
//  The ordering page
// ---------------------------------------------------------------------------

/**
 * The menu and the basket, for one sitting. **Mobile-first.**
 *
 * Deliberately a separate route from the landing page: once a sitting is open
 * the guest's URL carries the one-time token, and every subsequent action is
 * keyed on it. That is what makes a reload or a lock-screen harmless — there is
 * no in-memory session to lose, and no login.
 *
 * A round is a separate order (the same `Order` row the checkout creates), so
 * the guest can order twice and the kitchen sees two tickets. The tab is the sum.
 *
 * WHY THE TAB IS READ BEFORE THE MENU
 * -----------------------------------
 * The tab decides whether ordering is allowed at all. Rendering a menu and a
 * basket at a table that has already settled, and only discovering it on submit,
 * is the worst version of this page. So the tab leads, and a settled sitting
 * short-circuits to the bill.
 */
export default function DineOrderPage({
  params,
}: {
  params: Promise<{ guestToken: string }>;
}) {
  const { guestToken } = use(params);
  return <Ordering guestToken={guestToken} />;
}

function Ordering({ guestToken }: { guestToken: string }) {
  const toast = useToast();

  const tab = useAsync(() => api.dining.tab(guestToken), [guestToken]);
  const [basket, setBasket] = useState<Record<string, number>>({});
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The menu comes from the public discovery route, keyed on the merchant id.
   *
   * The tab response carries `merchantId` but not the slug, and the discovery
   * route matches on either — so the id goes straight through. Fetching the menu
   * only once the tab has resolved is deliberate; see the note above.
   */
  const menu = useAsync(
    () => (tab.data ? api.discovery.bySlug(tab.data.merchantId) : Promise.resolve(null)),
    [tab.data?.merchantId],
  );

  const categories = useMemo(
    () =>
      (menu.data?.categories ?? [])
        .filter((category) => category.isActive)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [menu.data],
  );

  const active = categories.find((category) => category.id === activeCategory) ?? categories[0];

  const lines = useMemo(
    () =>
      Object.entries(basket)
        .map(([menuItemId, quantity]) => ({ menuItemId, quantity }))
        .filter((line) => line.quantity > 0),
    [basket],
  );

  const itemsById = useMemo(() => {
    const map = new Map<string, MenuItem>();
    for (const category of categories) {
      for (const item of category.items) map.set(item.id, item);
    }
    return map;
  }, [categories]);

  const basketTotal = lines.reduce((sum, line) => {
    const item = itemsById.get(line.menuItemId);
    return sum + (item ? item.priceMinor * line.quantity : 0);
  }, 0);

  const basketCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  function bump(menuItemId: string, delta: number) {
    setBasket((current) => {
      const next = Math.max(0, (current[menuItemId] ?? 0) + delta);
      const copy = { ...current };
      if (next === 0) delete copy[menuItemId];
      else copy[menuItemId] = next;
      return copy;
    });
  }

  async function send() {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // An idempotency key, because in-store Wi-Fi is flaky and a guest WILL tap
      // twice. A duplicate dine-in round is real food the kitchen cooks twice.
      const key = `dine-${guestToken}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await api.dining.sendRound(guestToken, {
        items: lines,
        ...(note.trim() ? { customerNote: note.trim() } : {}),
        idempotencyKey: key,
      });
      toast.push(result.message, 'ok');
      setBasket({});
      setNote('');
      await tab.reload();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      toast.push(message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (tab.error) {
    return (
      <Shell>
        <ErrorBlock error={tab.error} onRetry={() => void tab.reload()} />
        <p className="tiny dim" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
          如果這一桌已經結帳，這一頁就會失效。請重新掃描桌上的 QR code。
        </p>
      </Shell>
    );
  }

  if (!tab.data) {
    return (
      <Shell>
        <Loading rows={5} />
      </Shell>
    );
  }

  const session = tab.data.session;
  const settled = !tab.data.canOrderMore;

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 520, paddingBottom: basketCount > 0 ? 96 : undefined }}>
        {/* ---- the table header + running total ------------------------- */}
        <Card tight>
          <div className="row-between row-wrap" style={{ gap: 'var(--space-2)' }}>
            <div className="stack-sm" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <Badge tone={settled ? 'neutral' : 'ok'}>
                  {settled ? '已結帳' : '用餐中'}
                </Badge>
                <span className="small strong">{tab.data.merchantName}</span>
              </div>
              <span className="tiny dim">
                {session.tableCode} · 已入座 {session.seatedMinutes} 分鐘 · {session.orderCount} 輪
              </span>
            </div>
            <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
              <span className="tiny dim">目前帳單</span>
              <span className="strong" style={{ fontSize: 22 }}>
                {money(tab.data.totalMinor)}
              </span>
            </div>
          </div>
        </Card>

        {/* ---- the tab so far ------------------------------------------ */}
        {tab.data.lines.length > 0 && (
          <Card flush>
            <CardHead title="已點的餐點" subtitle={`${tab.data.lines.length} 輪`} />
            <div className="stack-sm" style={{ padding: 'var(--space-3)' }}>
              {tab.data.lines.map((line) => (
                <div
                  key={line.orderId}
                  className="row-between"
                  style={{ opacity: line.countsTowardTotal ? 1 : 0.5 }}
                >
                  <div className="stack-sm" style={{ gap: 1 }}>
                    <span className="small">
                      <span className="dim num">{line.orderNo}</span> · {line.quantity} 件
                    </span>
                    <span className="tiny dim">{line.statusLabel}</span>
                  </div>
                  <span className="small num">
                    {line.countsTowardTotal ? money(line.lineTotalMinor) : '已取消'}
                  </span>
                </div>
              ))}
              <div className="divider" />
              <div className="row-between">
                <span className="small strong">合計</span>
                <span className="strong num">{money(tab.data.totalMinor)}</span>
              </div>
            </div>
          </Card>
        )}

        {/* ---- the settled state --------------------------------------- */}
        {settled ? (
          <Banner tone="info" title="這一桌已經結帳">
            帳單合計 {money(tab.data.totalMinor)}。若要繼續點餐，請重新掃描桌上的 QR code 開始新的一桌。
          </Banner>
        ) : (
          <>
            {error && <Banner tone="danger">{error}</Banner>}

            {/* ---- the menu ------------------------------------------- */}
            {menu.error ? (
              <ErrorBlock error={menu.error} onRetry={() => void menu.reload()} />
            ) : !menu.data ? (
              <Loading rows={5} />
            ) : categories.length === 0 ? (
              <Card>
                <Empty icon="📋" title="此餐廳尚未上架菜單">
                  請直接向店員點餐。
                </Empty>
              </Card>
            ) : (
              <>
                <Tabs
                  tabs={categories.map((category) => ({
                    value: category.id,
                    label: category.name,
                    count: category.items.length,
                  }))}
                  value={active?.id ?? ''}
                  onChange={setActiveCategory}
                />

                <Card flush>
                  {(active?.items ?? []).length === 0 ? (
                    <Empty icon="🍽️" title="這個分類暫時沒有餐點" />
                  ) : (
                    <div className="stack-sm" style={{ padding: 'var(--space-3)' }}>
                      {(active?.items ?? []).map((item) => (
                        <DishRow
                          key={item.id}
                          item={item}
                          quantity={basket[item.id] ?? 0}
                          onBump={(delta) => bump(item.id, delta)}
                        />
                      ))}
                    </div>
                  )}
                </Card>

                <Card>
                  <Field label="這一輪的備註" hint="給廚房，例如：走冰、少辣">
                    <Input
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      maxLength={300}
                      placeholder="例如：白飯分開上"
                    />
                  </Field>
                </Card>
              </>
            )}
          </>
        )}
      </div>

      {/* ---- the sticky basket bar, above the thumb zone ---------------- */}
      {!settled && basketCount > 0 && (
        <div className="cart-bar">
          <div className="row-between" style={{ maxWidth: 520, margin: '0 auto', gap: 'var(--space-3)' }}>
            <div className="stack-sm" style={{ gap: 0 }}>
              <span className="tiny dim">{basketCount} 件 · 這一輪</span>
              <span className="strong num">{money(basketTotal)}</span>
            </div>
            <Button variant="primary" size="lg" loading={busy} onClick={() => void send()}>
              送出這一輪
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The narrow, phone-shaped frame the guest's own pages share.
 *
 * 520px rather than the desktop `.page` width: this page is only ever a phone
 * held in one hand, so a wider column would just move the buttons further from
 * the thumb. The same frame is used for the "still loading" and "no session"
 * states, so the page does not jump when the content arrives.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 520 }}>
        {children}
      </div>
    </>
  );
}

/**
 * One dish and its quantity control.
 *
 * The `+` is on the right and larger than the `−`, because the guest's thumb
 * reaches the right edge more easily on a phone held in one hand, and adding is
 * the overwhelmingly common action.
 */
function DishRow({
  item,
  quantity,
  onBump,
}: {
  item: MenuItem;
  quantity: number;
  onBump: (delta: number) => void;
}) {
  const soldOut = item.availability !== 'AVAILABLE' || item.remainingToday === 0;

  return (
    <div className="dish">
      <div className="dish-body">
        <div className="stack-sm" style={{ gap: 3 }}>
          <span className="small strong">{item.name}</span>
          {item.nameEn && <span className="tiny dim">{item.nameEn}</span>}
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <span className="small num">{money(item.priceMinor)}</span>
            {item.isMainItem && <Badge tone="info">主菜</Badge>}
            {soldOut && (
              <Badge tone={AVAILABILITY_TONE[item.availability]}>
                {item.availability === 'AVAILABLE' ? '今日售完' : AVAILABILITY_LABEL[item.availability]}
              </Badge>
            )}
          </div>
          {item.description && <span className="tiny muted">{item.description}</span>}
        </div>
      </div>

      {soldOut ? (
        <span className="tiny dim nowrap">暫停供應</span>
      ) : quantity === 0 ? (
        <Button size="sm" variant="primary" onClick={() => onBump(1)}>
          加入
        </Button>
      ) : (
        <div className="qty">
          <button type="button" className="qty-btn" onClick={() => onBump(-1)} aria-label="減少">
            −
          </button>
          <span className="qty-value">{quantity}</span>
          <button type="button" className="qty-btn" onClick={() => onBump(1)} aria-label="增加">
            +
          </button>
        </div>
      )}
    </div>
  );
}
