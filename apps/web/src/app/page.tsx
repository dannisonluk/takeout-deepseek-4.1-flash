'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import { Badge, Banner, Button, Card, Empty, ErrorBlock, Input, Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { MerchantSummary } from '@/lib/types';
import { useAsync, useDebounced } from '@/lib/use-async';

/**
 * Discovery.
 *
 * `acceptingOnly` is on by default: showing a customer a kitchen that is not
 * taking orders is showing them a dead end. The toggle exists because browsing
 * a closed favourite to see its menu is a legitimate thing to want.
 */
export default function HomePage() {
  const { user } = useAuth();
  const [district, setDistrict] = useState<string>('');
  const [query, setQuery] = useState('');
  const [acceptingOnly, setAcceptingOnly] = useState(true);
  const [sort, setSort] = useState<'default' | 'fast' | 'rating'>('default');

  const debouncedQuery = useDebounced(query, 300);

  const merchants = useAsync(
    () =>
      api.discovery.list({
        ...(district ? { district } : {}),
        ...(debouncedQuery ? { q: debouncedQuery } : {}),
        ...(acceptingOnly ? { acceptingOnly: true } : {}),
        limit: 60,
      }),
    [district, debouncedQuery, acceptingOnly],
  );

  const districts = useAsync(() => api.discovery.districts(), []);

  const list = useMemo(() => {
    const rows = [...(merchants.data?.data ?? [])];
    if (sort === 'fast') rows.sort((a, b) => a.prepTimeMinutes - b.prepTimeMinutes);
    if (sort === 'rating') rows.sort((a, b) => (b.ratingAvg ?? 0) - (a.ratingAvg ?? 0));
    return rows;
  }, [merchants.data, sort]);

  return (
    <>
      <CustomerNav />

      <div className="page" style={{ maxWidth: 980 }}>
        <section className="hero" style={{ marginBottom: 'var(--space-5)' }}>
          <Badge tone="accent">Phase 1 · 純自取</Badge>
          <h1 style={{ fontSize: 30, lineHeight: 1.25 }}>
            線上點餐，<span style={{ color: 'var(--accent)' }}>準時到店取餐</span>
          </h1>
          <p className="muted" style={{ maxWidth: 520 }}>
            免等位、免運費。廚房按你選的時間開始製作，到店即取。
          </p>

          <div className="row-wrap" style={{ marginTop: 'var(--space-2)' }}>
            <Input
              placeholder="搜尋餐廳或菜式…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ maxWidth: 320 }}
            />
            <Button
              variant={acceptingOnly ? 'primary' : 'default'}
              onClick={() => setAcceptingOnly((value) => !value)}
            >
              {acceptingOnly ? '只顯示接單中' : '顯示全部餐廳'}
            </Button>
          </div>

          {!user && (
            <Banner tone="info">
              使用手機號碼登入即可下單。示範帳號 <span className="mono">+85290000001</span>
              ，驗證碼會直接顯示在畫面上。
            </Banner>
          )}
        </section>

        <div className="row-between" style={{ marginBottom: 'var(--space-3)' }}>
          <div className="row-wrap">
            <button
              className="btn btn-sm"
              data-active={district === ''}
              style={district === '' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              onClick={() => setDistrict('')}
            >
              全部地區
            </button>
            {(districts.data ?? []).map((entry) => (
              <button
                key={entry.district}
                className="btn btn-sm"
                style={
                  district === entry.district
                    ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                    : undefined
                }
                onClick={() => setDistrict(entry.district)}
              >
                {entry.district}
                <span className="dim">{entry.count}</span>
              </button>
            ))}
          </div>

          <div className="segmented">
            {(
              [
                ['default', '推薦'],
                ['fast', '最快出餐'],
                ['rating', '評分'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} data-active={sort === value} onClick={() => setSort(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {merchants.loading ? (
          <Loading rows={4} />
        ) : merchants.error ? (
          <ErrorBlock error={merchants.error} onRetry={() => void merchants.reload()} />
        ) : list.length === 0 ? (
          <Card>
            <Empty
              icon="🍽"
              title="沒有符合的餐廳"
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setDistrict('');
                    setQuery('');
                    setAcceptingOnly(false);
                  }}
                >
                  清除篩選
                </Button>
              }
            >
              試試其他地區，或顯示暫停接單的餐廳。
            </Empty>
          </Card>
        ) : (
          <div className="grid-2">
            {list.map((merchant) => (
              <MerchantCard key={merchant.id} merchant={merchant} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function MerchantCard({ merchant }: { merchant: MerchantSummary }) {
  const closed = !merchant.acceptsOrders || merchant.status !== 'ACTIVE';

  return (
    <Link href={`/m/${merchant.slug}`}>
      <Card className="card-hover" tight>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div
            className="dish-thumb"
            style={{ width: 56, height: 56, fontSize: 22, borderRadius: 12 }}
            aria-hidden
          >
            {merchant.name.slice(0, 1)}
          </div>

          <div className="grow stack-sm" style={{ gap: 3 }}>
            <div className="row-between">
              <strong className="truncate">{merchant.name}</strong>
              {closed ? (
                <Badge tone="danger">暫停接單</Badge>
              ) : (
                <Badge tone="ok" dot>
                  接單中
                </Badge>
              )}
            </div>

            <span className="tiny muted truncate">
              {merchant.district ?? merchant.region} · {merchant.addressLine1}
            </span>

            <div className="row-wrap" style={{ gap: 6 }}>
              <Badge tone="neutral">約 {merchant.prepTimeMinutes} 分鐘</Badge>
              {merchant.ratingAvg !== null ? (
                <Badge tone="warn">
                  ★ {merchant.ratingAvg.toFixed(1)}
                  <span className="dim">({merchant.ratingCount})</span>
                </Badge>
              ) : (
                <Badge tone="neutral">暫無評價</Badge>
              )}
              {merchant.distanceKm !== null && (
                <Badge tone="info">{merchant.distanceKm.toFixed(1)} km</Badge>
              )}
            </div>

            {merchant.description && (
              <span className="tiny dim truncate" style={{ marginTop: 2 }}>
                {merchant.description}
              </span>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}
