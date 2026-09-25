'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
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
import { useAuth } from '@/lib/auth';
import {
  RESERVATION_PROGRESS,
  RESERVATION_STATUS_LABEL,
  RESERVATION_STATUS_TONE,
  dateTime,
  isActiveReservation,
  relative,
  reservationProgressIndex,
  timeOnly,
} from '@/lib/format';
import { useAsync } from '@/lib/use-async';
import type { CustomerReservation } from '@/lib/types';

/**
 * One booking, for the customer.
 *
 * The Cancel button is gated on `canCancel` from the API, not on the status
 * string. The state machine is the only thing that knows whether a customer may
 * still cancel — a page that re-derived it here would drift the first time a
 * rule changed, and the drift would show up as "the button is there but the
 * server refuses", which reads as a bug rather than a policy.
 */
export default function ReservationDetailPage() {
  const params = useParams<{ reservationId: string }>();
  const router = useRouter();
  const toast = useToast();
  const { user, loading: authLoading } = useAuth();

  const reservation = useAsync<CustomerReservation>(
    () => api.reservations.get(params.reservationId),
    [params.reservationId],
  );

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`/login?next=/reservations/${params.reservationId}`);
    }
  }, [authLoading, user, router, params.reservationId]);

  /**
   * Poll while the booking is still active — the shop confirming or seating the
   * party is exactly what the customer is sitting on this page to see, and
   * nothing else will tell them. Stops once the reservation is terminal.
   */
  const settled = reservation.data ? !isActiveReservation(reservation.data.status) : false;
  useEffect(() => {
    if (settled) return;
    const id = window.setInterval(() => void reservation.reload(), 15000);
    return () => window.clearInterval(id);
  }, [settled, reservation.reload]);

  async function cancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await api.reservations.cancel(params.reservationId, {
        ...(cancelReason.trim() ? { reason: cancelReason.trim() } : {}),
      });
      toast.push('訂位已取消', 'ok');
      setCancelOpen(false);
      reservation.reload();
    } catch (caught) {
      setCancelError(describeCancelError(caught));
    } finally {
      setCancelling(false);
    }
  }

  const row = reservation.data;

  if (reservation.loading && !row) return <Shell><Loading rows={5} /></Shell>;
  if (reservation.error) {
    return (
      <Shell>
        <ErrorBlock error={reservation.error} onRetry={() => void reservation.reload()} />
      </Shell>
    );
  }
  if (!row) return <Shell><Loading /></Shell>;

  const timezone = row.merchantTimezone;
  const active = isActiveReservation(row.status);
  const step = reservationProgressIndex(row.status);

  return (
    <Shell>
      <div className="stack">
        <div className="stack-sm">
          <Link href="/reservations" className="tiny muted">
            ← 我的訂位
          </Link>
          <div className="row-between">
            <h1 style={{ margin: 0 }}>{row.merchantName}</h1>
            <Badge tone={RESERVATION_STATUS_TONE[row.status]} dot>
              {RESERVATION_STATUS_LABEL[row.status]}
            </Badge>
          </div>
          <span className="tiny dim mono">{row.reservationNo}</span>
        </div>

        {row.status === 'DECLINED' && (
          <Banner tone="danger" title="店家未能接受這次訂位">
            {row.statusReason ?? row.merchantNote ?? '請選擇其他時段，或直接聯絡店家。'}
          </Banner>
        )}

        {row.status === 'NO_SHOW' && (
          <Banner tone="warn" title="已標記為未出席">
            如需改期，請重新訂位或直接聯絡店家。
          </Banner>
        )}

        <Card>
          <CardHead title="訂位詳情" />
          <div className="stack-sm">
            <DetailRow label="日期">
              {dateTime(row.startsAt, timezone).slice(0, 10)}
              <span className="tiny dim" style={{ marginLeft: 8 }}>
                {relative(row.startsAt) === '剛剛' ? '即將開始' : relative(row.startsAt)}
              </span>
            </DetailRow>
            <DetailRow label="時間">
              <span className="mono strong">{timeOnly(row.startsAt, timezone)}</span>
            </DetailRow>
            <DetailRow label="人數">{row.partySize} 位</DetailRow>
            <DetailRow label="訂位人">{row.customerName}</DetailRow>
            {row.customerNote && <DetailRow label="備註">{row.customerNote}</DetailRow>}
            {row.merchantNote && <DetailRow label="店家回覆">{row.merchantNote}</DetailRow>}
            <DetailRow label="建立時間">
              <span className="tiny dim">{dateTime(row.createdAt, timezone)}</span>
            </DetailRow>
          </div>
        </Card>

        {active && step >= 0 && (
          <Card>
            <CardHead title="進度" />
            <div className="row" style={{ gap: 4 }}>
              {RESERVATION_PROGRESS.map((status, index) => (
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
                    {RESERVATION_STATUS_LABEL[status]}
                  </span>
                </div>
              ))}
            </div>
            <span className="tiny dim" style={{ marginTop: 'var(--space-2)', display: 'block' }}>
              {row.confirmedAt
                ? `店家已於 ${dateTime(row.confirmedAt, timezone)} 確認`
                : '等待店家確認，確認後會在此顯示。'}
            </span>
          </Card>
        )}

        {!active && (
          <Card>
            <CardHead title="結果" />
            <span className="muted">
              {row.status === 'COMPLETED' && `已於 ${dateTime(row.completedAt, timezone)} 完成用餐。`}
              {row.status === 'CANCELLED' && `已於 ${dateTime(row.cancelledAt, timezone)} 取消。`}
              {row.status === 'DECLINED' && '店家婉拒了這次訂位。'}
              {row.status === 'NO_SHOW' && '店家標記為未出席。'}
            </span>
          </Card>
        )}

        <div className="row-wrap">
          <Link href="/reservations">
            <Button variant="ghost">← 我的訂位</Button>
          </Link>
          <Link href={`/m/${row.merchantSlug}`}>
            <Button variant="ghost">查看店家</Button>
          </Link>
          <Link href={`/m/${row.merchantSlug}/reserve`}>
            <Button variant="ghost">再訂一次</Button>
          </Link>
          {row.canCancel && (
            <Button variant="danger" onClick={() => setCancelOpen(true)}>
              取消訂位
            </Button>
          )}
        </div>

        {!row.canCancel && active && (
          <span className="tiny dim">
            這個訂位已無法自行取消。如需協助，請直接聯絡 {row.merchantName}。
          </span>
        )}
      </div>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="取消訂位"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              保留訂位
            </Button>
            <Button variant="danger" loading={cancelling} onClick={() => void cancel()}>
              確定取消
            </Button>
          </>
        }
      >
        <p className="muted">
          取消後時段會立即釋出給其他顧客，無法復原。如只是遲到，建議先致電店家。
        </p>
        {cancelError && <Banner tone="danger">{cancelError}</Banner>}
        <Textarea
          placeholder="取消原因（選填）"
          value={cancelReason}
          maxLength={300}
          rows={2}
          onChange={(event) => setCancelReason(event.target.value)}
        />
      </Modal>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 780 }}>
        {children}
      </div>
    </>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row-between" style={{ alignItems: 'flex-start' }}>
      <span className="tiny dim" style={{ minWidth: 68 }}>
        {label}
      </span>
      <span className="grow right" style={{ textAlign: 'right' }}>
        {children}
      </span>
    </div>
  );
}

/**
 * A cancel that the server refused means the booking moved under us — the party
 * was already seated, or the shop ended it. The page reloads so the customer
 * sees the real state rather than retrying a request that cannot succeed.
 */
function describeCancelError(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return caught instanceof Error ? caught.message : '取消失敗，請再試一次。';
  }
  switch (caught.code) {
    case 'RESERVATION_NOT_PERMITTED':
      return '這個訂位已無法取消（可能已入座或已結束）。請重新載入頁面查看最新狀態。';
    case 'RESERVATION_ALREADY_TERMINAL':
      return '這個訂位已經結束了。';
    case 'RESERVATION_NOT_FOUND':
      return '找不到這筆訂位。';
    default:
      return caught.validationMessage ?? caught.message;
  }
}
