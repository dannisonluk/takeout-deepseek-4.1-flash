'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import { Badge, Button, Card, Empty, ErrorBlock, Loading, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  RESERVATION_STATUS_LABEL,
  RESERVATION_STATUS_TONE,
  localDateKey,
  localDateLabel,
  timeOnly,
} from '@/lib/format';
import { useAsync } from '@/lib/use-async';
import type { CustomerReservation } from '@/lib/types';

type Filter = 'ACTIVE' | 'ALL';

/**
 * 我的訂位 — the customer's reservation list.
 *
 * Grouped by service date rather than a flat feed, because a reservation is
 * defined by *when* it is: "Friday 19:00" is how a person remembers it, and a
 * list that made them read each card's timestamp to work that out would be
 * worse than the calendar it is replacing.
 *
 * `serviceDate` is the merchant-local calendar date the API computed, so the
 * grouping is correct for a shop in another zone without this page doing any
 * timezone maths of its own.
 */
export default function MyReservationsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [filter, setFilter] = useState<Filter>('ACTIVE');

  const reservations = useAsync(() => api.reservations.list({ status: filter, limit: 50 }), [filter]);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login?next=/reservations');
  }, [authLoading, user, router]);

  const rows = reservations.data?.data ?? [];

  /**
   * Buckets keyed by `serviceDate`, ordered the way a person reads a diary:
   * soonest first for what is coming, most recent first for what happened.
   */
  const groups = useMemo(() => {
    const today = localDateKey(new Date(), rows[0]?.merchantTimezone ?? 'Asia/Hong_Kong');
    const byDate = new Map<string, CustomerReservation[]>();
    for (const row of rows) {
      const bucket = byDate.get(row.serviceDate);
      if (bucket) bucket.push(row);
      else byDate.set(row.serviceDate, [row]);
    }

    const keys = [...byDate.keys()].sort();
    if (filter === 'ALL') keys.reverse();

    return keys.map((date) => ({
      date,
      relative: date === today ? '今天' : date < today ? '已過去' : '',
      rows: (byDate.get(date) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    }));
  }, [rows, filter]);

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 780 }}>
        <div className="stack">
          <h1>我的訂位</h1>

          <Tabs
            tabs={[
              { value: 'ACTIVE', label: '即將到來' },
              { value: 'ALL', label: '全部' },
            ]}
            value={filter}
            onChange={setFilter}
          />

          {reservations.loading ? (
            <Loading rows={4} />
          ) : reservations.error ? (
            <ErrorBlock error={reservations.error} onRetry={() => void reservations.reload()} />
          ) : rows.length === 0 ? (
            <Card>
              <Empty
                icon="📅"
                title={filter === 'ACTIVE' ? '沒有即將到來的訂位' : '還沒有任何訂位'}
                action={
                  <Link href="/">
                    <Button size="sm" variant="primary">
                      去找餐廳訂位
                    </Button>
                  </Link>
                }
              >
                在店家頁面按「預約訂位」即可選擇時段。
              </Empty>
            </Card>
          ) : (
            <div className="stack">
              {groups.map((group) => (
                <div className="stack-sm" key={group.date}>
                  <div className="row" style={{ gap: 'var(--space-2)' }}>
                    <span className="strong">{localDateLabel(group.date)}</span>
                    {group.relative && <span className="tiny dim">{group.relative}</span>}
                    <span className="tiny dim">{group.rows.length} 筆</span>
                  </div>
                  {group.rows.map((row) => (
                    <ReservationCard key={row.id} reservation={row} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ReservationCard({ reservation }: { reservation: CustomerReservation }) {
  const timezone = reservation.merchantTimezone;
  return (
    <Link href={`/reservations/${reservation.id}`}>
      <Card className="card-hover" tight>
        <div className="row-between">
          <div className="stack-sm" style={{ gap: 3 }}>
            <span className="strong">{reservation.merchantName}</span>
            <span className="tiny dim">
              <span className="mono">{timeOnly(reservation.startsAt, timezone)}</span>
              {' · '}
              {reservation.partySize} 位
              {' · '}
              <span className="mono">{reservation.reservationNo}</span>
            </span>
            {reservation.customerNote && (
              <span className="tiny muted truncate" style={{ maxWidth: 360 }}>
                備註：{reservation.customerNote}
              </span>
            )}
          </div>

          <div className="stack-sm right" style={{ gap: 4 }}>
            <Badge tone={RESERVATION_STATUS_TONE[reservation.status]} dot>
              {RESERVATION_STATUS_LABEL[reservation.status]}
            </Badge>
            {reservation.merchantNote && (
              <span className="tiny dim truncate" style={{ maxWidth: 180 }}>
                店家回覆：{reservation.merchantNote}
              </span>
            )}
          </div>
        </div>
      </Card>
    </Link>
  );
}
