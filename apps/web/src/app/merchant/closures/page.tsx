'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
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
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import type {
  ClosureReason,
  ClosureWriteResult,
  MerchantClosure,
} from '@/lib/types';
import { CLOSURE_REASON_LABELS } from '@/lib/types';

/**
 * 特別休息日 — the shop's dated rest days.
 *
 * The screen exists because the API's closure save has a side effect that must
 * not be silent: setting a rest day **cancels the bookings already in that
 * day**. So the flow is deliberately two-step —
 *
 *   1. The merchant picks a date and sees, up front, how many bookings that day
 *      currently holds. "Close this day" on a day with six tables is a decision
 *      that needs the number in front of it.
 *   2. The save reports back what happened (`cancelledReservations`,
 *      `remainingActive`), and a non-zero `remainingActive` is surfaced as a
 *      warning rather than swallowed. The API caps one sweep, so a shop with
 *      more bookings than the cap gets told to save again instead of believing
 *      the day is clear.
 *
 * Note what this page does NOT offer: a way to re-open a day and restore the
 * bookings it cancelled. That asymmetry is deliberate and is stated in the UI,
 * because a merchant who expected the parties to come back would be wrong.
 *
 * The weekly pattern (「每週一休息」) is NOT here — it lives in 商戶設定 →
 * 營業時間, as `isClosed` on a `dayOfWeek`. Two mechanisms for the same rule
 * would be two sources of truth, and they would disagree the first time a shop
 * used both.
 */
export default function MerchantClosuresPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const [rows, setRows] = useState<MerchantClosure[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busyDate, setBusyDate] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    if (!merchantId) return;
    setError(null);
    try {
      // No `from` — the API defaults it to today in the SHOP's timezone. Sending
      // the browser's date would hide the day a +08 shop most likely wants to
      // close, because at 17:00 UTC the server-side "today" is already tomorrow.
      setRows(await api.closures.list(merchantId));
    } catch (cause) {
      setError(cause as Error);
    }
  }, [merchantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Today, in the shop's timezone — the earliest date the API will accept. */
  const today = useMemo(() => localDateIn(merchant?.timezone ?? 'Asia/Hong_Kong'), [
    merchant?.timezone,
  ]);

  const upcoming = useMemo(
    () => (rows ?? []).filter((row) => row.serviceDate >= today),
    [rows, today],
  );
  const past = useMemo(
    () => (rows ?? []).filter((row) => row.serviceDate < today).reverse(),
    [rows, today],
  );

  async function remove(serviceDate: string) {
    if (!merchantId) return;
    setBusyDate(serviceDate);
    try {
      await api.closures.remove(merchantId, serviceDate);
      toast.push(`${serviceDate} 已重新開放`, 'ok');
      await load();
    } catch (cause) {
      toast.push((cause as Error).message, 'danger');
    } finally {
      setBusyDate(null);
    }
  }

  if (!merchant || !merchantId) return <Loading rows={4} />;

  return (
    <MerchantShell
      title="特別休息日"
      subtitle="設定特定日期休息。設定後當日不接新單，既有訂位會自動取消並通知顧客。"
      actions={
        <Button variant="primary" onClick={() => setPicking(true)}>
          新增休息日
        </Button>
      }
    >
      <MerchantStatusNotice merchant={merchant} />

      <Banner tone="info" title="關於每週固定休息">
        固定每週休息（例如逢星期一休息）請到{' '}
        <Link href="/merchant/settings">商戶設定 → 營業時間</Link> 設定，不需在此逐日新增。
      </Banner>

      {error ? (
        <ErrorBlock error={error} onRetry={() => void load()} />
      ) : rows === null ? (
        <Loading rows={4} />
      ) : (
        <>
          <Card>
            <CardHead
              title="即將休息"
              subtitle={
                upcoming.length === 0
                  ? '沒有已排定的休息日'
                  : `共 ${upcoming.length} 日`
              }
            />
            {upcoming.length === 0 ? (
              <Empty icon="🌤" title="沒有已排定的休息日">
                你的店目前每天照常營業。需要臨時休息時，按右上角「新增休息日」。
              </Empty>
            ) : (
              <div className="stack">
                {upcoming.map((row) => (
                  <ClosureRow
                    key={row.id}
                    row={row}
                    busy={busyDate === row.serviceDate}
                    onRemove={() => void remove(row.serviceDate)}
                  />
                ))}
              </div>
            )}
          </Card>

          {past.length > 0 && (
            <Card>
              <CardHead title="過去的休息日" subtitle="僅供查閱，不可修改或刪除" />
              <div className="stack">
                {past.map((row) => (
                  <ClosureRow key={row.id} row={row} busy={false} readOnly />
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {picking && merchantId && (
        <PickClosureModal
          merchantId={merchantId}
          today={today}
          existing={rows ?? []}
          onClose={() => setPicking(false)}
          onSaved={async () => {
            setPicking(false);
            await load();
          }}
        />
      )}
    </MerchantShell>
  );
}

function ClosureRow({
  row,
  busy,
  readOnly = false,
  onRemove,
}: {
  row: MerchantClosure;
  busy: boolean;
  readOnly?: boolean;
  onRemove?: () => void;
}) {
  const label =
    CLOSURE_REASON_LABELS.find((entry) => entry.value === row.reason)?.label ?? row.reason;

  return (
    <div className="row-between" style={{ gap: 'var(--space-3)' }}>
      <div className="stack-sm" style={{ gap: 2 }}>
        <div className="row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
          <strong>{row.serviceDate}</strong>
          <Badge>{label}</Badge>
          {row.cancelledReservationCount > 0 && (
            <Badge tone="warn">已取消 {row.cancelledReservationCount} 筆訂位</Badge>
          )}
          {row.cancelledReservationsAt === null && (
            // The latch is not set. For a future date that just means the sweep
            // has not run; for a past one it means it never completed, which is
            // worth the merchant knowing rather than a silent data gap.
            <Badge tone={row.serviceDate < todayIso() ? 'danger' : 'neutral'}>
              未執行取消
            </Badge>
          )}
        </div>
        {row.note && <span className="muted">{row.note}</span>}
      </div>
      {!readOnly && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={onRemove}
          title="重新開放此日。已取消的訂位不會自動恢復。"
        >
          {busy ? '處理中…' : '重新開放'}
        </Button>
      )}
    </div>
  );
}

function PickClosureModal({
  merchantId,
  today,
  existing,
  onClose,
  onSaved,
}: {
  merchantId: string;
  today: string;
  existing: MerchantClosure[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const [serviceDate, setServiceDate] = useState(today);
  const [reason, setReason] = useState<ClosureReason>('PUBLIC_HOLIDAY');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ClosureWriteResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /**
   * How many bookings the chosen day currently holds.
   *
   * Read from the reservation book rather than guessed, because "cancels
   * existing bookings" is the sentence that makes this operation consequential
   * and the merchant deserves the number before they commit, not after.
   */
  const [affected, setAffected] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAffected(null);
    api.bookings
      .list(merchantId, { date: serviceDate, status: 'ACTIVE', limit: 200 })
      .then((page) => {
        if (!cancelled) setAffected(page.data.length);
      })
      .catch(() => {
        // Not fatal — the count is advisory. The save still reports the truth.
        if (!cancelled) setAffected(null);
      });
    return () => {
      cancelled = true;
    };
  }, [merchantId, serviceDate]);

  const alreadyClosed = existing.some((row) => row.serviceDate === serviceDate);

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const write = await api.closures.set(merchantId, serviceDate, {
        reason,
        note: note.trim() ? note.trim() : null,
      });
      setResult(write);
      toast.push(write.message, write.remainingActive > 0 ? 'warn' : 'ok');
      await onSaved();
    } catch (cause) {
      setErr((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="新增休息日"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            關閉
          </Button>
          <Button
            variant="primary"
            disabled={saving || affected === null || alreadyClosed}
            onClick={() => void save()}
          >
            {saving ? '設定中…' : '設為休息日'}
          </Button>
        </>
      }
    >
      {result ? (
        <div className="stack">
          <Banner
            tone={result.remainingActive > 0 ? 'warn' : 'ok'}
            title={`${result.closure.serviceDate} 已設為休息日`}
          >
            {result.message}
          </Banner>
          <Detail
            rows={[
              ['已取消訂位', `${result.cancelledReservations} 筆`],
              ['重複儲存', result.alreadySwept ? '是（未重複取消）' : '否'],
              ['尚未取消', result.remainingActive > 0 ? `${result.remainingActive} 筆` : '0 筆'],
            ]}
          />
          <p className="muted">
            已取消的顧客會收到通知。若你要在該日恢復營業，請在列表按「重新開放」——但已取消的訂位
            <strong>不會</strong>自動回復，需要你自行聯絡客人。
          </p>
        </div>
      ) : (
        <div className="stack">
          <Field
            label="休息日期"
            hint={
              affected === null
                ? '查詢當日訂位中…'
                : affected === 0
                  ? '當日沒有有效訂位'
                  : `當日有 ${affected} 筆有效訂位，設定後會自動取消並通知顧客`
            }
            error={
              alreadyClosed
                ? '此日期已是休息日，請直接在上方列表修改'
                : serviceDate < today
                  ? '不能設定過去的日期'
                  : null
            }
          >
            <Input
              type="date"
              value={serviceDate}
              min={today}
              onChange={(event) => setServiceDate(event.target.value)}
            />
          </Field>

          <Field label="休息原因" hint="顯示給顧客看">
            <Select
              value={reason}
              onChange={(event) => setReason(event.target.value as ClosureReason)}
            >
              {CLOSURE_REASON_LABELS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="補充說明" hint="選填。填寫後會取代預設的休息說明。">
            <Textarea
              rows={3}
              value={note}
              maxLength={300}
              placeholder="例如：中秋節翌日休息，10 月 2 日正常營業"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>

          {affected !== null && affected > 0 && (
            <Banner tone="warn" title={`此日目前有 ${affected} 筆有效訂位`}>
              設定後這些訂位會立即取消，顧客會收到通知。此動作無法復原訂位。
            </Banner>
          )}

          {err && <Banner tone="danger" title="設定失敗">{err}</Banner>}
        </div>
      )}
    </Modal>
  );
}

function Detail({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="stack-sm" style={{ gap: 2 }}>
      {rows.map(([label, value]) => (
        <div key={label} className="row-between">
          <dt className="muted">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * `YYYY-MM-DD` for `at` in `timeZone`, without pulling in a date library.
 *
 * Only used to compute the shop's "today" for the date picker's `min`. The API
 * still validates the date server-side — this is purely so the picker does not
 * offer a day the server will refuse.
 */
function localDateIn(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The browser's today. Only for deciding how to badge a past row. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
