'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Badge, Banner, Button, Card, Empty, Tabs } from '@/components/ui';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, money } from '@/lib/format';
import { useCart } from '@/lib/cart';
import { useAuth } from '@/lib/auth';
import type { MenuItem, MerchantDetail } from '@/lib/types';

/**
 * The menu and the basket.
 *
 * Takes the already-fetched merchant as a prop rather than fetching again —
 * the server component above has the data, and re-requesting it here would
 * produce a visible flash of empty menu on every navigation.
 *
 * The pickup time is deliberately NOT chosen here. It belongs to checkout,
 * where it can be validated against the lead time at the moment of ordering;
 * a slot picked ten minutes ago may already be too soon.
 */
export function MenuOrdering({ merchant }: { merchant: MerchantDetail }) {
  const router = useRouter();
  const { user } = useAuth();
  const { cart, add, setQuantity, quantityOf, totalMinor, itemCount } = useCart();

  const [activeCategory, setActiveCategory] = useState<string>(
    merchant.categories[0]?.id ?? 'none',
  );

  const categories = useMemo(() => {
    const rows = merchant.categories
      .filter((category) => category.isActive)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return rows;
  }, [merchant.categories]);

  const active = categories.find((category) => category.id === activeCategory) ?? categories[0];
  const orderable = merchant.acceptsOrders && merchant.status === 'ACTIVE';

  // The basket may belong to a different kitchen. Say so rather than silently
  // dropping it, because the customer did put that food in a basket.
  const foreignBasket = cart !== null && cart.merchantId !== merchant.id;

  return (
    <div className="stack">
      {!orderable && (
        <Banner tone="danger" title="此餐廳暫時停止接單">
          你仍可瀏覽菜單，但暫時無法下單。
        </Banner>
      )}

      {foreignBasket && (
        <Banner tone="warn" title="你的購物車屬於另一間餐廳">
          {cart?.merchantName} 的 {cart?.lines.length} 項餐點仍在購物車。加入這裡的餐點會取代它。
        </Banner>
      )}

      {categories.length === 0 ? (
        <Card>
          <Empty icon="📋" title="此餐廳尚未上架菜單">
            請稍後再來，或選擇其他餐廳。
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
            {active?.items.length === 0 ? (
              <Empty icon="○" title="此分類暫無菜式" />
            ) : (
              active?.items
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((item) => (
                  <Dish
                    key={item.id}
                    item={item}
                    quantity={quantityOf(item.id)}
                    disabled={!orderable || item.availability !== 'AVAILABLE'}
                    onAdd={() => {
                      if (!user) {
                        router.push(`/login?next=/m/${merchant.slug}`);
                        return;
                      }
                      add({ id: merchant.id, slug: merchant.slug, name: merchant.name }, item, 1);
                    }}
                    onSetQuantity={(quantity) => setQuantity(item.id, quantity)}
                  />
                ))
            )}
          </Card>
        </>
      )}

      {itemCount > 0 && cart && (
        <div className="cart-bar">
          <div className="stack-sm" style={{ gap: 1 }}>
            <span className="strong">{money(totalMinor)}</span>
            <span className="tiny dim">{itemCount} 件餐點</span>
          </div>
          <Link href="/checkout">
            <Button variant="primary" size="lg">
              前往結帳 →
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}

function Dish({
  item,
  quantity,
  disabled,
  onAdd,
  onSetQuantity,
}: {
  item: MenuItem;
  quantity: number;
  disabled: boolean;
  onAdd: () => void;
  onSetQuantity: (quantity: number) => void;
}) {
  const soldOut = item.availability !== 'AVAILABLE';
  const exhausted = item.remainingToday !== null && item.remainingToday <= 0;
  const unavailable = soldOut || exhausted;

  return (
    <div className="dish" style={{ borderBottom: '1px solid var(--border)', borderRadius: 0 }}>
      <div className="dish-body">
        <div className="row-wrap" style={{ gap: 6 }}>
          <strong>{item.name}</strong>
          {item.isMainItem && <Badge tone="accent">主餐</Badge>}
          {unavailable && (
            <Badge tone={AVAILABILITY_TONE[item.availability] ?? 'neutral'}>
              {exhausted ? '今日售罄' : AVAILABILITY_LABEL[item.availability]}
            </Badge>
          )}
        </div>

        {item.nameEn && <span className="tiny dim">{item.nameEn}</span>}
        {item.description && <span className="tiny muted">{item.description}</span>}

        <div className="row-wrap" style={{ gap: 8, marginTop: 2 }}>
          <span className="strong num">{money(item.priceMinor)}</span>
          {item.remainingToday !== null && !exhausted && (
            <span className="tiny dim">今日尚餘 {item.remainingToday} 份</span>
          )}
          {item.prepTimeMinutes !== null && (
            <span className="tiny dim">約 {item.prepTimeMinutes} 分鐘</span>
          )}
        </div>
      </div>

      {quantity > 0 ? (
        <div className="qty" style={{ alignSelf: 'center' }}>
          <button type="button" onClick={() => onSetQuantity(quantity - 1)} aria-label="減少">
            −
          </button>
          <span>{quantity}</span>
          <button
            type="button"
            onClick={() => onSetQuantity(quantity + 1)}
            disabled={item.remainingToday !== null && quantity >= item.remainingToday}
            aria-label="增加"
          >
            +
          </button>
        </div>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={disabled}
          onClick={onAdd}
          style={{ alignSelf: 'center' }}
        >
          {unavailable ? '已售罄' : '加入'}
        </Button>
      )}
    </div>
  );
}
