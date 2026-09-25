'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import { Badge, Button, Card, Empty, ErrorBlock, Loading, Tabs } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  REFUND_REASON_LABEL,
  REFUND_REQUEST_SHORT_LABEL,
  REFUND_REQUEST_STATUS_LABEL,
  REFUND_REQUEST_STATUS_TONE,
  isActiveRefundRequest,
  money,
  relative,
} from '@/lib/format';
import type { CustomerRefundRequest } from '@/lib/types';
import { useAsync } from '@/lib/use-async';

type Filter = 'ACTIVE' | 'ALL';

/**
 * 我的退款申請 — the customer's refund tickets.
 *
 * A flat feed, oldest-ticket-first only within a day, because unlike a booking
 * a ticket is not defined by *when* it is: "the one about the cold siu mai" is
 * how a person remembers it, and the thing they need is the shop's reply. So
 * each row leads with the order number and the status, not a date heading.
 *
 * The whole page is a record of a conversation the platform is not party to.
 * It says so at the top, because the single most likely misreading is that
 * filing a ticket here makes the platform issue the refund.
 */
export default function MyRefundsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [filter, setFilter] = useState<Filter>('ACTIVE');

  const tickets = useAsync(() => api.refunds.mine({ limit: 50 }), []);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login?next=/refunds');
  }, [authLoading, user, router]);

  const all = tickets.data?.data ?? [];
  const rows = filter === 'ACTIVE' ? all.filter((row) => isActiveRefundRequest(row.status)) : all;

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 780 }}>
        <div className="stack">
          <div className="stack-sm" style={{ gap: 4 }}>
            <h1>退款申請</h1>
            <p className="tiny dim">
              你的申請會直接送到店家。平台只負責轉達，退款金額與方式由你與店家自行商議。
            </p>
          </div>

          <Tabs
            tabs={[
              { value: 'ACTIVE', label: '處理中', count: all.filter((row) => isActiveRefundRequest(row.status)).length },
              { value: 'ALL', label: '全部', count: all.length },
            ]}
            value={filter}
            onChange={setFilter}
          />

          {tickets.loading ? (
            <Loading rows={4} />
          ) : tickets.error ? (
            <ErrorBlock error={tickets.error} onRetry={() => void tickets.reload()} />
          ) : rows.length === 0 ? (
            <Card>
              <Empty
                icon="💬"
                title={filter === 'ACTIVE' ? '沒有處理中的退款申請' : '還沒有任何退款申請'}
                action={
                  <Link href="/orders">
                    <Button size="sm" variant="primary">
                      查看我的訂單
                    </Button>
                  </Link>
                }
              >
                在訂單詳情頁按「申請退款」，即可向店家提出。
              </Empty>
            </Card>
          ) : (
            <div className="stack">
              {rows.map((row) => (
                <RefundCard key={row.id} ticket={row} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function RefundCard({ ticket }: { ticket: CustomerRefundRequest }) {
  return (
    <Link href={`/refunds/${ticket.id}`}>
      <Card className="card-hover" tight>
        <div className="row-between">
          <div className="stack-sm" style={{ gap: 3 }}>
            <span className="strong">{REFUND_REASON_LABEL[ticket.reasonCode]}</span>
            <span className="tiny dim">
              <span className="mono">{ticket.orderNo}</span>
              {' · '}
              {relative(ticket.createdAt)}
            </span>
            {ticket.requestedAmountMinor !== null && (
              <span className="tiny dim">
                要求金額 <span className="num">{money(ticket.requestedAmountMinor)}</span>
                {' · '}
                訂單 <span className="num">{money(ticket.orderTotalMinor)}</span>
              </span>
            )}
          </div>

          <div className="stack-sm right" style={{ gap: 4 }}>
            <Badge tone={REFUND_REQUEST_STATUS_TONE[ticket.status]} dot>
              {REFUND_REQUEST_STATUS_LABEL[ticket.status]}
            </Badge>
            {ticket.merchantNote && (
              <span className="tiny dim truncate" style={{ maxWidth: 200 }}>
                店家：{ticket.merchantNote}
              </span>
            )}
          </div>
        </div>

        {ticket.status === 'RESOLVED_OFFLINE' && (
          <>
            <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />
            <div className="tiny dim">
              店家表示已線下處理
              {ticket.settledAmountMinor !== null && (
                <>
                  {' · '}
                  <span className="num">{money(ticket.settledAmountMinor)}</span>
                </>
              )}
              {ticket.settlementReference && (
                <>
                  {' · '}
                  參考 <span className="mono">{ticket.settlementReference}</span>
                </>
              )}
            </div>
          </>
        )}
      </Card>
    </Link>
  );
}
