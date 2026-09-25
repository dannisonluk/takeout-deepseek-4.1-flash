'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import { Badge, Button, Card, Empty, ErrorBlock, Loading, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ORDER_STATUS_LABEL, ORDER_STATUS_TONE, dateTime, money } from '@/lib/format';
import { useAsync } from '@/lib/use-async';

type Filter = 'ACTIVE' | 'ALL';

export default function MyOrdersPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [filter, setFilter] = useState<Filter>('ACTIVE');

  const orders = useAsync(() => api.orders.list({ status: filter, limit: 40 }), [filter]);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login?next=/orders');
  }, [authLoading, user, router]);

  const rows = orders.data?.data ?? [];

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 780 }}>
        <div className="stack">
          <h1>我的訂單</h1>

          <Tabs
            tabs={[
              { value: 'ACTIVE', label: '進行中' },
              { value: 'ALL', label: '全部' },
            ]}
            value={filter}
            onChange={setFilter}
          />

          {orders.loading ? (
            <Loading rows={4} />
          ) : orders.error ? (
            <ErrorBlock error={orders.error} onRetry={() => void orders.reload()} />
          ) : rows.length === 0 ? (
            <Card>
              <Empty
                icon="🧾"
                title={filter === 'ACTIVE' ? '沒有進行中的訂單' : '還沒有任何訂單'}
                action={
                  <Link href="/">
                    <Button size="sm" variant="primary">
                      去找餐廳
                    </Button>
                  </Link>
                }
              />
            </Card>
          ) : (
            <div className="stack-sm">
              {rows.map((order) => (
                <Link key={order.id} href={`/orders/${order.id}`}>
                  <Card className="card-hover" tight>
                    <div className="row-between">
                      <div className="stack-sm" style={{ gap: 2 }}>
                        <span className="mono strong">{order.orderNo}</span>
                        <span className="tiny dim">
                          {dateTime(order.createdAt)}
                          {order.scheduledPickupAt ? ' · 預約取餐' : ' · 即時製作'}
                        </span>
                        <span className="tiny muted">
                          {order.items.length} 項 · {order.items[0]?.nameSnapshot ?? ''}
                          {order.items.length > 1 ? ` 等 ${order.items.length} 款` : ''}
                        </span>
                      </div>

                      <div className="stack-sm right" style={{ gap: 4 }}>
                        <Badge tone={ORDER_STATUS_TONE[order.status]} dot>
                          {ORDER_STATUS_LABEL[order.status]}
                        </Badge>
                        <span className="num strong">{money(order.totalMinor)}</span>
                        {order.pickupCode && (
                          <span className="tiny dim mono">取餐碼 {order.pickupCode}</span>
                        )}
                      </div>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
