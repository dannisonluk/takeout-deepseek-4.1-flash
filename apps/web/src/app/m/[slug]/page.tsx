import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomerNav } from '@/components/customer-nav';
import { Badge, Banner, Card } from '@/components/ui';
import { API_BASE } from '@/lib/api';
import { minuteOfDay, weekday } from '@/lib/format';
import type { MerchantDetail, PickupSlots } from '@/lib/types';
import { MenuOrdering } from './menu-ordering';

/**
 * The one server-rendered route in the app.
 *
 * A restaurant page is the only page here with an audience that arrives from
 * outside — a shared link, a search result, a map listing. Rendering it on the
 * server means the menu is in the HTML before any JavaScript runs, which is the
 * difference between being indexed and not.
 *
 * Everything interactive (the basket, the slot picker) lives in the client
 * child, so this component stays a pure read.
 */

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      // Menu and hours change rarely; a minute of staleness is invisible and
      // saves a round trip on every share-link open.
      next: { revalidate: 60 },
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // A dead API must render a page that says so, not a 500.
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const merchant = await fetchJson<MerchantDetail>(`/merchants/${encodeURIComponent(slug)}`);
  if (!merchant) return { title: '找不到餐廳' };

  const where = merchant.district ?? merchant.region;
  return {
    title: merchant.name,
    description:
      merchant.description ??
      `${merchant.name}（${where}）外賣自取，約 ${merchant.prepTimeMinutes} 分鐘出餐。`,
    openGraph: {
      title: `${merchant.name} — 外賣自取`,
      description: merchant.description ?? undefined,
      type: 'website',
    },
  };
}

export default async function MerchantPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const merchant = await fetchJson<MerchantDetail>(`/merchants/${encodeURIComponent(slug)}`);

  if (!merchant) notFound();

  const slots = await fetchJson<PickupSlots>(`/merchants/${encodeURIComponent(slug)}/pickup-slots`);

  const today = new Date().getDay();
  const todayHours = merchant.hours.find((hour) => hour.dayOfWeek === today);

  return (
    <>
      <CustomerNav />

      <div className="page" style={{ maxWidth: 980 }}>
        <header className="hero" style={{ marginBottom: 'var(--space-5)' }}>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div
              className="dish-thumb"
              style={{ width: 64, height: 64, fontSize: 26, borderRadius: 14 }}
              aria-hidden
            >
              {merchant.name.slice(0, 1)}
            </div>
            <div className="grow stack-sm" style={{ gap: 4 }}>
              <div className="row-between">
                <h1>{merchant.name}</h1>
                {merchant.acceptsOrders ? (
                  <Badge tone="ok" dot>
                    接單中
                  </Badge>
                ) : (
                  <Badge tone="danger">暫停接單</Badge>
                )}
              </div>
              {merchant.nameEn && <span className="tiny dim">{merchant.nameEn}</span>}
              <span className="tiny muted">
                {merchant.addressLine1}
                {merchant.addressLine2 ? `, ${merchant.addressLine2}` : ''}
                {merchant.district ? ` · ${merchant.district}` : ''}
              </span>
              <div className="row-wrap" style={{ gap: 6 }}>
                <Badge tone="neutral">約 {merchant.prepTimeMinutes} 分鐘出餐</Badge>
                <Badge tone="neutral">取餐保留 {merchant.pickupWindowMinutes} 分鐘</Badge>
                {merchant.ratingAvg !== null && (
                  <Badge tone="warn">
                    ★ {merchant.ratingAvg.toFixed(1)} ({merchant.ratingCount})
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {merchant.description && <p className="muted">{merchant.description}</p>}

          <div className="tiny dim">
            今日營業：
            {todayHours?.isClosed
              ? '休息'
              : todayHours
                ? `${minuteOfDay(todayHours.opensAtMinute)}–${minuteOfDay(todayHours.closesAtMinute)}`
                : '未設定'}
          </div>
        </header>

        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stack" style={{ gridColumn: 'span 1' }}>
            <MenuOrdering merchant={merchant} />
          </div>

          <aside className="stack">
            {/*
              The reservation entry point.

              Rendered unconditionally rather than behind a "does this shop take
              bookings" probe: the availability endpoint is the authority, and it
              explains itself when the book is closed. A shop page that silently
              hides the link is a page where a customer never learns the option
              exists — and a shop that just switched it on would stay invisible
              until their next deploy.
            */}
            <Card tight flush>
              <div className="stack-sm" style={{ padding: 'var(--space-3)' }}>
                <div className="row-between">
                  <strong>預約訂位</strong>
                  <Badge tone="accent">訂位</Badge>
                </div>
                <p className="tiny muted" style={{ margin: 0 }}>
                  想在店內用餐？選好日期與人數，即時查看可訂時段。
                </p>
                <Link href={`/m/${merchant.slug}/reserve`} className="btn btn-primary btn-block">
                  立即訂位
                </Link>
              </div>
            </Card>

            {/*
              現場候位. Rendered unconditionally for the same reason as 訂位
              above: the queue endpoint is the authority and it explains itself
              when the shop has the feature off ("此餐廳未開放現場候位") or is
              shut. Probing here would need a second request per storefront
              render, and a shop that just enabled it would stay invisible.
            */}
            <Card tight flush>
              <div className="stack-sm" style={{ padding: 'var(--space-3)' }}>
                <div className="row-between">
                  <strong>現場候位</strong>
                  <Badge tone="info">取號</Badge>
                </div>
                <p className="tiny muted" style={{ margin: 0 }}>
                  沒有訂位？可以先取號，輪到你的時候會通知你。
                </p>
                <Link
                  href={`/queue/${merchant.id}`}
                  className="btn btn-primary btn-block"
                >
                  現場取號
                </Link>
              </div>
            </Card>

            {slots ? (
              <Card tight>
                <div className="stack-sm">
                  <strong>取餐時間</strong>
                  {/*
                    The reason is shown, not just the fact. A rest day the shop
                    planned and simply being past closing time are the same
                    refusal but very different messages — collapsing them into
                    「非營業時間」 makes a shop that took a holiday look broken.
                  */}
                  <span className="tiny muted">
                    {slots.closedReason === 'CLOSED_FOR_CLOSURE' && slots.closureDate
                      ? `店家於 ${slots.closureDate} 休息，暫停接單`
                      : slots.acceptingNow
                        ? `現正營業 · 最快 ${slots.slots[0]?.label ?? '—'} 可取`
                        : '現時非營業時間，可預約下一個營業時段'}
                  </span>
                  <span className="tiny dim">
                    共 {slots.slots.length} 個可選時段（每 {slots.stepMinutes} 分鐘一格）
                  </span>
                </div>
              </Card>
            ) : (
              <Banner tone="warn">暫時無法取得取餐時段，結帳時將再嘗試。</Banner>
            )}

            <Card tight>
              <div className="stack-sm">
                <strong>營業時間</strong>
                {merchant.hours
                  .slice()
                  .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
                  .map((hour) => (
                    <div
                      key={hour.dayOfWeek}
                      className="row-between tiny"
                      style={hour.dayOfWeek === today ? { color: 'var(--accent)' } : undefined}
                    >
                      <span>{weekday(hour.dayOfWeek)}</span>
                      <span className="mono">
                        {hour.isClosed
                          ? '休息'
                          : `${minuteOfDay(hour.opensAtMinute)}–${minuteOfDay(hour.closesAtMinute)}`}
                      </span>
                    </div>
                  ))}
              </div>
            </Card>

            <Card tight>
              <div className="stack-sm">
                <strong>收費說明</strong>
                <p className="tiny muted">
                  餐點費用於線上支付。平台按主餐件數收取中介費，已包含在顯示價格中，
                  不會另外向顧客加收。
                </p>
              </div>
            </Card>
          </aside>
        </div>
      </div>
    </>
  );
}
