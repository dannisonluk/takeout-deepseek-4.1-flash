import { notFound } from 'next/navigation';
import { API_BASE } from '@/lib/api';
import type { MerchantDetail } from '@/lib/types';
import { ReserveBooking } from './reserve-booking';

/**
 * 預約訂位 — the booking page.
 *
 * A server component for the same reason `/m/[slug]` is: the shop's name and
 * slug have to be in the first byte for a shared link to preview properly. The
 * client half then owns the interactive part — day picker, party size, the slot
 * grid — and refetches availability itself.
 *
 * The merchant is fetched directly here rather than through `api.discovery`:
 * this is a cold render with no token, and going through the client's fetch
 * wrapper would drag the refresh-token machinery into a page that has none.
 */
export default async function ReservePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const response = await fetch(`${API_BASE}/merchants/${encodeURIComponent(slug)}`, {
    cache: 'no-store',
  }).catch(() => null);

  if (!response) {
    return <ReserveUnavailable slug={slug} />;
  }
  if (response.status === 404) notFound();
  if (!response.ok) {
    return <ReserveUnavailable slug={slug} />;
  }

  const merchant = (await response.json()) as MerchantDetail;
  return <ReserveBooking merchant={merchant} />;
}

/**
 * The API being down must not look like the shop not existing.
 *
 * `notFound()` is reserved for a real 404 — a shop that was closed or renamed.
 * Everything else gets a retryable message, because a customer who came here
 * from a link did nothing wrong and should not be told the restaurant is gone.
 */
function ReserveUnavailable({ slug }: { slug: string }) {
  return (
    <div className="stack" style={{ maxWidth: 560, margin: '0 auto', padding: 'var(--space-8) var(--space-4)' }}>
      <h1>暫時無法載入訂位資料</h1>
      <p className="muted">請稍後再試，或直接向店家查詢。</p>
      <a className="btn" href={`/m/${encodeURIComponent(slug)}`}>
        返回店家頁
      </a>
    </div>
  );
}
