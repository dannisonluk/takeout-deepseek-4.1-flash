'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorBlock,
  Field,
  Loading,
  Modal,
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import {
  RESERVATION_STATUS_LABEL,
  RESERVATION_STATUS_TONE,
  dateTime,
  localDateKey,
  localDateLabel,
  phone,
  timeOnly,
} from '@/lib/format';
import { useAsync, useTicker } from '@/lib/use-async';
import type { MerchantReservation, ReservationStatus } from '@/lib/types';

/**
 * 訂位簿 — the shop's reservation book.
 *
 * The design rule that separates this from the kitchen board: **the buttons are
 * a projection, not a mirror.**
 *
 * `merchant/orders` carries a hard-coded `ACTIONS_FROM` table, because
 * `MerchantOrderView` has no transition list. A reservation view deliberately
 * does — `allowedNextTransitions.merchant` — so this board renders buttons FROM
 * that list. There is no lifecycle table in this file, which means a rule change
 * (say, allowing a no-show from `SEATED`) shows up here without a frontend
 * deploy and can never offer a move the server would refuse.
 */

type Tab = 'PENDING' | 'CONFIRMED' | 'SEATED' | 'ALL';

const TAB_FILTER: Record<Tab, ReservationStatus[]> = {
  PENDING: ['PENDING'],
  CONFIRMED: ['CONFIRMED'],
  SEATED: ['SEATED'],
  ALL: ['PENDING', 'CONFIRMED', 'SEATED'],
};

/** How a target status is labelled and toned when it becomes a button. */
const ACTION_SPEC: Record<
  ReservationStatus,
  { label: string; variant: 'primary' | 'danger' | 'default'; needsReason: boolean; success: string }
> = {
  CONFIRMED: { label: '確認訂位', variant: 'primary', needsReason: false, success: '已確認' },
  DECLINED: { label: '婉拒', variant: 'danger', needsReason: true, success: '已婉拒，時段已釋出' },
  SEATED: { label: '安排入座', variant: 'primary', needsReason: false, success: '已標記入座' },
  COMPLETED: { label: '完成用餐', variant: 'primary', needsReason: false, success: '已完成' },
  NO_SHOW: { label: '標記未出席', variant: 'danger', needsReason: true, success: '已標記未出席' },
  CANCELLED: { label: '取消訂位', variant: 'danger', needsReason: true, success: '已取消，時段已釋出' },
  // Not reachable from the merchant side — the actor list never offers it.
  PENDING: { label: '待確認', variant: 'default', needsReason: false, success: '已更新' },
};

/** Maps a target status onto the named action the API exposes. */
const ACTION_PATH: Record<Exclude<ReservationStatus, 'PENDING'>, 'confirm' | 'decline' | 'seat' | 'complete' | 'no-show' | 'cancel'> = {
  CONFIRMED: 'confirm',
  DECLINED: 'decline',
  SEATED: 'seat',
  COMPLETED: 'complete',
  NO_SHOW: 'no-show',
  CANCELLED: 'cancel',
};

/** The board re-reads the book this often. */
const POLL_MS = 20_000;

export default function MerchantReservationsPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>('PENDING');
  const [showAllDates, setShowAllDates] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  /** The action awaiting a reason (or a confirmation) in the modal. */
  const [acting, setActing] = useState<{
    reservation: MerchantReservation;
    target: ReservationStatus;
  } | null>(null);
  const [reason, setReason] = useState('');
  const [merchantNote, setMerchantNote] = useState('');

  const poll = useTicker(POLL_MS);

  const today = useMemo(
    () => localDateKey(new Date(), merchant?.timezone ?? 'Asia/Hong_Kong'),
    [merchant?.timezone],
  );

  /**
   * Today's book by default, the whole active book on request.
   *
   * A book is a day-shape artefact: a shop opens this screen in the morning to
   * see tonight. `showAllDates` is the escape hatch for "who is coming
   * tomorrow", and it is an explicit toggle rather than a date picker because
   * the overwhelming majority of visits want exactly one answer.
   */
  const state = useAsync<{ data: MerchantReservation[] }>(
    () =>
      merchantId
        ? api.bookings.list(merchantId, {
            status: 'ACTIVE',
            ...(showAllDates ? {} : { date: today }),
            limit: 200,
          })
        : Promise.resolve({ data: [] }),
    [merchantId, today, showAllDates, poll],
  );

  /** Settings, for the "book is off" banner. Not polled — it changes rarely. */
  const settings = useAsync(
    () => (merchantId ? api.bookings.settings(merchantId) : Promise.resolve(null)),
    [merchantId],
  );

  if (!merchant || !merchantId) return null;

  const timezone = merchant.timezone || 'Asia/Hong_Kong';
  const all = state.data?.data ?? [];
  const rows = all.filter((row) => TAB_FILTER[tab].includes(row.status));

  const countOf = (statuses: ReservationStatus[]) =>
    all.filter((row) => statuses.includes(row.status)).length;

  const policyEnabled = settings.data?.policy.enabled ?? null;

  async function run(reservation: MerchantReservation, target: ReservationStatus, note?: string, why?: string) {
    if (target === 'PENDING') return;
    setPendingId(reservation.id);
    try {
      const result = await api.bookings.act(merchantId!, reservation.id, ACTION_PATH[target], {
        ...(why?.trim() ? { reason: why.trim() } : {}),
        ...(note?.trim() ? { merchantNote: note.trim() } : {}),
      });
      const spec = ACTION_SPEC[target];
      toast.push(`${reservation.reservationNo} ${spec.success}`, target === 'CONFIRMED' || target === 'SEATED' || target === 'COMPLETED' ? 'ok' : 'warn');
      if (result.sideEffects.length > 0) {
        // Worth surfacing: RELEASE_SLOT_SEATS is the merchant's evidence that
        // the seats actually came back, which is the thing they were told.
        toast.push(`系統動作：${result.sideEffects.join('、')}`, 'info');
      }
      setActing(null);
      setReason('');
      setMerchantNote('');
      await state.reload();
    } catch (caught) {
      // A 409 means the book moved under us — reload so the buttons match the
      // truth before the operator retries.
      toast.push((caught as Error).message, 'danger');
      await state.reload();
    } finally {
      setPendingId(null);
    }
  }

  return (
    <MerchantShell
      title="訂位簿"
      subtitle={`${merchant.name} · ${showAllDates ? '全部日子' : localDateLabel(today)} · 每 ${POLL_MS / 1000} 秒更新`}
      counts={{ pendingReservations: countOf(['PENDING']) }}
      actions={
        <>
          <Button size="sm" onClick={() => setShowAllDates((current) => !current)}>
            {showAllDates ? '只看今日' : '查看全部日子'}
          </Button>
          <Link href="/merchant/reservations/settings">
            <Button size="sm">訂位設定</Button>
          </Link>
          <Button size="sm" onClick={() => void state.reload()}>
            重新整理
          </Button>
        </>
      }
    >
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        {policyEnabled === false && (
          <Banner
            tone="warn"
            title="線上訂位尚未開啟"
            action={
              <Link href="/merchant/reservations/settings">
                <Button size="sm" variant="primary">
                  前往開啟
                </Button>
              </Link>
            }
          >
            顧客目前看不到你的訂位時段。開啟後，顧客即可在店家頁面預約。
          </Banner>
        )}

        {settings.data && policyEnabled && settings.data.acceptingNew === false && (
          <Banner tone="warn" title="已暫停接受新訂位">
            你仍可處理現有訂位，但新的預約不會進來。可在訂位設定中恢復。
          </Banner>
        )}

        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'PENDING', label: '待確認', count: countOf(['PENDING']) },
            { value: 'CONFIRMED', label: '已確認', count: countOf(['CONFIRMED']) },
            { value: 'SEATED', label: '已入座', count: countOf(['SEATED']) },
            { value: 'ALL', label: '全部', count: all.length },
          ]}
        />

        {state.error ? (
          <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
        ) : state.loading && all.length === 0 ? (
          <Loading rows={4} />
        ) : rows.length === 0 ? (
          <Card>
            <Empty icon="📖" title={tab === 'PENDING' ? '沒有待確認的訂位' : '這個分類沒有訂位'}>
              {showAllDates
                ? '切換上方分類查看其他訂位。'
                : '只顯示今日。如要看其他日子，請按右上角「查看全部日子」。'}
            </Empty>
          </Card>
        ) : (
          <div className="grid-2">
            {rows.map((row) => (
              <ReservationBookCard
                key={row.id}
                reservation={row}
                timezone={timezone}
                busy={pendingId === row.id}
                onAct={(target) => {
                  const spec = ACTION_SPEC[target];
                  // Anything irreversible, or anything that hands the table to
                  // somebody else, goes through the modal so a reason can be
                  // written. A bare confirm fires immediately — it is the one
                  // move with nothing to explain and nothing to lose.
                  if (spec.needsReason) {
                    setActing({ reservation: row, target });
                    setReason('');
                    setMerchantNote('');
                    return;
                  }
                  void run(row, target);
                }}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={acting !== null}
        onClose={() => setActing(null)}
        title={acting ? `${ACTION_SPEC[acting.target].label} ${acting.reservation.reservationNo}` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setActing(null)}>
              返回
            </Button>
            <Button
              variant={ACTION_SPEC[acting?.target ?? 'CONFIRMED'].variant}
              disabled={
                // A decline without a reason leaves the customer with no idea
                // what to do next; the API would accept it, but the shop should
                // not be able to do it by accident.
                (acting?.target === 'DECLINED' || acting?.target === 'CANCELLED') &&
                reason.trim().length === 0
              }
              loading={pendingId === acting?.reservation.id}
              onClick={() =>
                acting && void run(acting.reservation, acting.target, merchantNote, reason)
              }
            >
              確定{ACTION_SPEC[acting?.target ?? 'CONFIRMED'].label}
            </Button>
          </>
        }
      >
        {acting && (
          <div className="stack">
            <ActingBanner target={acting.target} reservation={acting.reservation} timezone={timezone} />

            {(acting.target === 'DECLINED' || acting.target === 'CANCELLED') && (
              <Field label="原因 *" hint="顧客會看到這段文字，請具體說明">
                <Textarea
                  value={reason}
                  maxLength={300}
                  rows={2}
                  placeholder="抱歉，這個時段已經滿座了"
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
            )}

            <Field label="給顧客的訊息（選填）" hint="例如：已為你保留窗邊座位">
              <Textarea
                value={merchantNote}
                maxLength={1000}
                rows={2}
                onChange={(event) => setMerchantNote(event.target.value)}
              />
            </Field>
          </div>
        )}
      </Modal>
    </MerchantShell>
  );
}

/** The risk note for the move about to be taken. */
function ActingBanner({
  target,
  reservation,
  timezone,
}: {
  target: ReservationStatus;
  reservation: MerchantReservation;
  timezone: string;
}) {
  const when = `${dateTime(reservation.startsAt, timezone).slice(0, 10)} ${timeOnly(reservation.startsAt, timezone)}`;

  switch (target) {
    case 'DECLINED':
      return (
        <Banner tone="warn" title="婉拒後時段會立即釋出">
          {when} · {reservation.partySize} 位的座位會還給系統，其他顧客可以即時訂走。
          顧客會看到你填寫的原因。
        </Banner>
      );
    case 'CANCELLED':
      return (
        <Banner tone="warn" title="取消後時段會立即釋出">
          這是店家主動取消 {when} · {reservation.partySize} 位的訂位。座位會還給系統，
          顧客會看到你填寫的原因。
        </Banner>
      );
    case 'NO_SHOW':
      return (
        <Banner tone="info" title="標記為未出席">
          只適用於已過訂位時間的訂位。標記後座位會釋出，可在忙碌時段讓給現場顧客。
        </Banner>
      );
    default:
      return null;
  }
}

function ReservationBookCard({
  reservation,
  timezone,
  busy,
  onAct,
}: {
  reservation: MerchantReservation;
  timezone: string;
  busy: boolean;
  onAct: (target: ReservationStatus) => void;
}) {
  // THE whole point: the buttons are whatever the server said is legal next.
  const targets = reservation.allowedNextTransitions.merchant;

  return (
    <Card>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <strong className="mono" style={{ fontSize: 16 }}>
              {timeOnly(reservation.startsAt, timezone)}
            </strong>
            <Badge tone={RESERVATION_STATUS_TONE[reservation.status]}>
              {RESERVATION_STATUS_LABEL[reservation.status]}
            </Badge>
          </div>
          <span className="tiny dim mono">{reservation.reservationNo}</span>
        </div>

        <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
          <span className="tiny dim">人數</span>
          <span className="num strong" style={{ fontSize: 20 }}>
            {reservation.partySize}
          </span>
        </div>
      </div>

      <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

      <div className="stack-sm">
        <div className="row-between">
          <span className="strong">{reservation.customerName}</span>
          <a className="mono tiny" href={`tel:${reservation.contactPhone}`}>
            {phone(reservation.contactPhone)}
          </a>
        </div>
        <div className="row-between tiny dim">
          <span>用餐長度</span>
          <span className="num">{reservation.turnMinutes} 分鐘</span>
        </div>
        {reservation.customerNote && (
          <div
            className="tiny"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <span className="dim">顧客備註：</span>
            {reservation.customerNote}
          </div>
        )}
        <div className="row-between tiny dim">
          <span>訂於</span>
          <span>{dateTime(reservation.createdAt, timezone)}</span>
        </div>
      </div>

      <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

      <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
        {targets.length === 0 ? (
          <span className="tiny dim">沒有可執行的動作</span>
        ) : (
          targets
            .filter((target) => target !== 'PENDING')
            .map((target) => {
              const spec = ACTION_SPEC[target];
              return (
                <Button
                  key={target}
                  variant={spec.variant}
                  size="sm"
                  loading={busy}
                  onClick={() => onAct(target)}
                >
                  {spec.label}
                </Button>
              );
            })
        )}
      </div>
    </Card>
  );
}
