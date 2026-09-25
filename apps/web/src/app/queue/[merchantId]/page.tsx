'use client';

import { use, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CustomerNav } from '@/components/customer-nav';
import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Input,
  Loading,
  ErrorBlock,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync, useTicker } from '@/lib/use-async';
import {
  WAITLIST_STATUS_LABEL,
  WAITLIST_STATUS_TONE,
  countdown,
  dateTime,
  timeOnly,
  waitDuration,
  waitTone,
} from '@/lib/format';
import type { CustomerQueueEntryPoint, CustomerQueueTicket } from '@/lib/types';

/**
 * 現場候位 — the guest's take-a-number page. **Mobile-first, one-handed.**
 *
 * THE UI BRIEF, MADE CONCRETE
 * ---------------------------
 * This page is opened by somebody standing in a shop doorway, in daylight, on a
 * phone, with one free hand. Four consequences drive every decision here:
 *
 *   1. **The number is the page.** Once a ticket exists, the ticket number,
 *      the position and the estimate occupy the top of the screen at hero size.
 *      Everything else is below the fold. A guest who has to scroll to find
 *      their number will not trust it.
 *   2. **One column, one action.** No sidebars, no tabs, no tables. Every
 *      control is full width and at least 48px tall, because the tap targets
 *      are thumbs.
 *   3. **The form is three fields.** Party size (a stepper, not a text input),
 *      a name, a phone. Every extra field is a guest who walks away, and the
 *      phone is the one thing the shop needs — it is what the host rings.
 *   4. **It survives being closed.** The phone number is the key, so a guest
 *      who locks their screen and comes back re-reads the ticket from the API
 *      without an account. That is why there is no login on this page at all.
 *
 * The page polls only while a ticket is live, and only every 15 seconds: a
 * queue number changes slowly, and a phone in a pocket burning battery to
 * discover that nothing changed is a real cost the guest notices.
 */

/** How often the live ticket refreshes. A queue moves in tens of minutes. */
const POLL_MS = 15_000;

export default function TakeNumberPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = use(params);
  return <TakeNumber merchantId={merchantId} />;
}

function TakeNumber({ merchantId }: { merchantId: string }) {
  const toast = useToast();

  /**
   * The phone is persisted locally so a guest who closes the tab does not lose
   * their ticket. NOT an identity: it is the same string they typed, and the
   * API treats it as the ownership key on every read. localStorage rather than
   * a cookie, because this page is unauthenticated and a cookie would be sent
   * to every other route for no reason.
   */
  const [phone, setPhone] = useState('');
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(`takeout.queue.phone.${merchantId}`);
    if (stored) setPhone(stored);
    setRestored(true);
  }, [merchantId]);

  const entry = useAsync<CustomerQueueEntryPoint>(
    () => api.waitlist.entryPoint(merchantId, phone ? { phone } : {}),
    [merchantId, phone],
  );

  const ticket: CustomerQueueTicket | null = entry.data?.myTicket ?? null;

  /**
   * Poll the guest's own ticket, but only while one is live.
   *
   * `useTicker` fires on an interval; the guard inside makes the poll a no-op
   * when there is nothing to poll, so a guest who has not queued yet does not
   * generate a request every 15 seconds.
   */
  const tick = useTicker(POLL_MS);
  useEffect(() => {
    if (!ticket || !phone) return;
    if (ticket.status !== 'WAITING' && ticket.status !== 'CALLED') return;
    void entry.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, phone, ticket?.status]);

  const rememberPhone = (next: string) => {
    setPhone(next);
    if (next) window.localStorage.setItem(`takeout.queue.phone.${merchantId}`, next);
  };

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 560 }}>
        {entry.error && !entry.data ? (
          <ErrorBlock error={entry.error} onRetry={() => void entry.reload()} />
        ) : !restored || (entry.loading && !entry.data) ? (
          <Loading rows={4} />
        ) : !entry.data ? null : !entry.data.enabled ? (
          <Empty2 title="此餐廳未開放現場候位" />
        ) : ticket ? (
          <TicketCard
            ticket={ticket}
            /* The phone is NOT on the ticket view — deliberately, so a shared
               link cannot carry a guest's number. The page holds it locally and
               passes it down, which is also why cancelling works without a login. */
            phone={phone}
            merchantName={entry.data.merchantName}
            notice={entry.data.customerNotice}
            timezone={entry.data.timezone}
            onCancelled={async () => {
              toast.push('已取消候位', 'ok');
              await entry.reload();
            }}
            onError={(message) => toast.push(message, 'danger')}
          />
        ) : entry.data.closedReason === 'CLOSED' && !entry.data.acceptingNow ? (
          <Empty2 title="餐廳目前休息中" subtitle="營業時間內即可取號" />
        ) : (
          <JoinForm
            entry={entry.data}
            onJoined={async (ticketNo) => {
              toast.push(`已取號 ${ticketNo}`, 'ok');
              await entry.reload();
            }}
            onError={(message) => toast.push(message, 'danger')}
            rememberedPhone={phone}
            onPhone={rememberPhone}
          />
        )}
      </div>
    </>
  );

  function Empty2({ title, subtitle }: { title: string; subtitle?: string }) {
    return (
      <Card>
        <div className="stack" style={{ textAlign: 'center', padding: 'var(--space-5) 0' }}>
          <span style={{ fontSize: 40 }}>🎫</span>
          <span className="strong">{title}</span>
          {subtitle && <span className="tiny dim">{subtitle}</span>}
          <Link href={`/m/${entry.data?.merchantSlug ?? ''}`}>
            <Button variant="ghost" size="sm">
              回到餐廳
            </Button>
          </Link>
        </div>
      </Card>
    );
  }
}

/**
 * The join form.
 *
 * Party size is a stepper rather than a `<select>`: the guest is standing up,
 * the range is 1–10, and a native picker on a phone is a modal wheel that costs
 * two taps where a `+`/`−` costs one.
 */
function JoinForm({
  entry,
  onJoined,
  onError,
  rememberedPhone,
  onPhone,
}: {
  entry: CustomerQueueEntryPoint;
  onJoined: (ticketNo: string) => void | Promise<void>;
  onError: (message: string) => void;
  rememberedPhone: string;
  onPhone: (next: string) => void;
}) {
  const [partySize, setPartySize] = useState(Math.max(2, entry.policy.minPartySize));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState(rememberedPhone);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const canSubmit =
    name.trim().length > 0 && /^\+?[0-9]{8,15}$/.test(phone.trim()) && !busy;

  async function submit() {
    setBusy(true);
    try {
      const result = await api.waitlist.take(entry.merchantId, {
        partySize,
        guestName: name.trim(),
        contactPhone: phone.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onPhone(phone.trim());
      await onJoined(result.ticket.ticketNo);
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {/* ---- how long the queue is, BEFORE they commit ------------------ */}
      <Card tight>
        <div className="row-between">
          <div className="stack-sm" style={{ gap: 2 }}>
            <span className="strong">{entry.merchantName}</span>
            <span className="tiny muted">
              {entry.queueLength === 0
                ? '目前沒有人排隊'
                : `目前 ${entry.queueLength} 組在等`}
            </span>
          </div>
          <div className="stack-sm" style={{ gap: 2, alignItems: 'flex-end' }}>
            <span className="tiny dim">預計等候</span>
            <span className="strong" style={{ fontSize: 20 }}>
              {entry.queueLength === 0 ? '即時' : waitDuration(entry.estimatedWaitMinutes)}
            </span>
          </div>
        </div>
        {entry.customerNotice && (
          <p className="tiny muted" style={{ marginTop: 'var(--space-3)' }}>
            {entry.customerNotice}
          </p>
        )}
      </Card>

      <Card>
        <div className="stack">
          <Stepper
            label="用餐人數"
            value={partySize}
            min={entry.policy.minPartySize}
            max={entry.policy.maxPartySize}
            onChange={setPartySize}
          />

          <Field label="稱呼 *" hint="叫號時會喊這個名字">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="陳先生 / 2 位"
              maxLength={80}
              autoComplete="name"
            />
          </Field>

          <Field label="聯絡電話 *" hint="叫號時會以這個號碼通知你">
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+852 9000 0001"
              inputMode="tel"
              autoComplete="tel"
            />
          </Field>

          <Field label="備註" hint="例如：需要嬰兒椅、有位輪椅使用者">
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={300}
              rows={2}
            />
          </Field>

          <Button
            variant="primary"
            size="lg"
            block
            loading={busy}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            取號排隊
          </Button>

          <p className="tiny dim" style={{ textAlign: 'center' }}>
            叫號後 {entry.policy.callTimeoutMinutes} 分鐘內未到，會視為過號。
          </p>
        </div>
      </Card>
    </div>
  );
}

/** A big-tap-target `−` / value / `+`, sized for a thumb. */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      <span className="label">{label}</span>
      <div className="row" style={{ gap: 'var(--space-3)' }}>
        <button
          type="button"
          className="step-btn"
          onClick={() => onChange(Math.max(min, value - 1))}
          disabled={value <= min}
          aria-label="減少"
        >
          −
        </button>
        <span className="step-value">{value}</span>
        <button
          type="button"
          className="step-btn"
          onClick={() => onChange(Math.min(max, value + 1))}
          disabled={value >= max}
          aria-label="增加"
        >
          +
        </button>
        <span className="tiny dim" style={{ marginLeft: 'var(--space-2)' }}>
          位（{min}–{max}）
        </span>
      </div>
    </div>
  );
}

/**
 * The guest's live ticket.
 *
 * The hero is the NUMBER. Position and estimate are secondary, and the state
 * banner changes the whole card's emphasis: 候位中 is calm, 已叫號 is loud and
 * adds a countdown, 已入座 / 過號 / 已取消 is a settled card with no actions.
 */
function TicketCard({
  ticket,
  phone,
  merchantName,
  notice,
  timezone,
  onCancelled,
  onError,
}: {
  ticket: CustomerQueueTicket;
  /** Held by the page, not the view — the phone is the ownership key on every read. */
  phone: string;
  merchantName: string;
  notice: string | null;
  timezone: string;
  onCancelled: () => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // A 1-second tick ONLY while called, because the countdown is mm:ss and a
  // 15-second refresh would make it visibly wrong. Outside 已叫號 there is no
  // countdown, so there is no interval.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ticket.status !== 'CALLED') return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [ticket.status]);

  const remaining = useMemo(
    () => countdown(ticket.callDeadlineAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ticket.callDeadlineAt, now],
  );

  const isActive = ticket.status === 'WAITING' || ticket.status === 'CALLED';
  const called = ticket.status === 'CALLED';
  const overdue = called && remaining === null;

  async function cancel() {
    setBusy(true);
    try {
      await api.waitlist.cancelTicket(ticket.id, phone);
      await onCancelled();
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="stack">
      {/* ---- the number ------------------------------------------------ */}
      <div
        className="ticket-hero"
        data-state={called ? 'called' : isActive ? 'waiting' : 'ended'}
      >
        <span className="tiny" style={{ opacity: 0.75 }}>
          {merchantName}
        </span>
        <span className="ticket-no">{ticket.ticketNo}</span>
        <Badge tone={WAITLIST_STATUS_TONE[ticket.status]}>{WAITLIST_STATUS_LABEL[ticket.status]}</Badge>

        {isActive && ticket.position > 0 && (
          <div className="row" style={{ gap: 'var(--space-5)', marginTop: 'var(--space-2)' }}>
            <div className="stack-sm" style={{ gap: 0, alignItems: 'center' }}>
              <span className="tiny" style={{ opacity: 0.75 }}>
                目前順位
              </span>
              <span style={{ fontSize: 22, fontWeight: 700 }}>第 {ticket.position} 位</span>
            </div>
            <div className="stack-sm" style={{ gap: 0, alignItems: 'center' }}>
              <span className="tiny" style={{ opacity: 0.75 }}>
                前面還有
              </span>
              <span style={{ fontSize: 22, fontWeight: 700 }}>{ticket.ahead} 組</span>
            </div>
          </div>
        )}
      </div>

      {/* ---- the call state, which is the whole point of CALLED --------- */}
      {called && (
        <Banner tone={overdue ? 'danger' : 'warn'} title={overdue ? '已超過叫號時間' : '已經叫到你了'}>
          <div className="stack-sm" style={{ gap: 4 }}>
            {remaining ? (
              <span className="strong" style={{ fontSize: 20 }}>
                請於 {remaining} 內到櫃檯
              </span>
            ) : (
              <span className="strong" style={{ fontSize: 18 }}>
                請盡快到櫃檯，否則會視為過號
              </span>
            )}
            {ticket.calledAt && (
              <span className="tiny muted">
                叫號時間 {timeOnly(ticket.calledAt)}（{timezone === 'Asia/Hong_Kong' ? '香港時間' : timezone}）
              </span>
            )}
          </div>
        </Banner>
      )}

      {/* ---- the estimate ---------------------------------------------- */}
      {ticket.status === 'WAITING' && (
        <Card tight>
          <div className="row-between">
            <span className="small muted">預計等候</span>
            <span className="strong" style={{ fontSize: 18 }}>
              {ticket.estimatedWaitMinutes === null
                ? '—'
                : waitDuration(ticket.estimatedWaitMinutes)}
            </span>
          </div>
          {ticket.quotedMinutes !== null && (
            <p className="tiny dim" style={{ marginTop: 4 }}>
              取號時告知約 {waitDuration(ticket.quotedMinutes)}。這是估算，會隨現場情況變動。
            </p>
          )}
        </Card>
      )}

      {/* ---- the facts ------------------------------------------------- */}
      <Card tight>
        <div className="stack-sm">
          <Line label="號碼" value={ticket.ticketNo} />
          <Line label="人數" value={`${ticket.partySize} 位`} />
          <Line label="稱呼" value={ticket.guestName} />
          <Line label="取號時間" value={dateTime(ticket.joinedAt)} />
          {ticket.seatedAt && <Line label="入座時間" value={dateTime(ticket.seatedAt)} />}
          {ticket.cancelledAt && <Line label="取消時間" value={dateTime(ticket.cancelledAt)} />}
          {ticket.statusReason && <Line label="備註" value={reasonLabel(ticket.statusReason)} />}
        </div>
      </Card>

      {notice && <Banner tone="info">{notice}</Banner>}

      {/* ---- the one destructive action -------------------------------- */}
      {ticket.canCancel &&
        (confirming ? (
          <Card tight>
            <div className="stack-sm">
              <span className="small strong">確定要取消號碼 {ticket.ticketNo}？</span>
              <span className="tiny muted">
                取消後要重新排隊，順位會從最後開始。
              </span>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <Button
                  variant="danger"
                  block
                  loading={busy}
                  onClick={() => void cancel()}
                >
                  確定取消
                </Button>
                <Button variant="ghost" block onClick={() => setConfirming(false)}>
                  保留
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <Button
            variant="ghost"
            size="lg"
            block
            onClick={() => setConfirming(true)}
          >
            放棄排隊
          </Button>
        ))}

      {isActive && (
        <p className="tiny dim" style={{ textAlign: 'center' }}>
          這頁會自動更新。可以先去做別的事，叫號時會以你留下的電話通知。
        </p>
      )}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="tiny muted nowrap">{label}</span>
      <span className="small num truncate" style={{ textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

/**
 * Why a ticket ended, in the guest's language.
 *
 * The API stores an enum (`CALL_TIMEOUT`, `GUEST_CANCELLED`, …). A guest reading
 * "CALL_TIMEOUT" learns nothing; 「叫號後未在時限內出現」 at least closes the
 * loop. Unknown values fall through to the raw string rather than vanishing.
 */
function reasonLabel(reason: string): string {
  const LABELS: Record<string, string> = {
    GUEST_CANCELLED: '你已取消候位',
    QUEUE_CLOSED: '店家已結束候位',
    CALL_TIMEOUT: '叫號後未在時限內出現',
    HOST_MARKED_NO_SHOW: '店家標記為過號',
    SHOP_CLOSED: '店家已休息',
  };
  return LABELS[reason] ?? reason;
}
