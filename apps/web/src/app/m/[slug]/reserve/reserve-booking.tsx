'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import { Banner, Button, Card, CardHead, Empty, Field, Input, Textarea, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  addDays,
  dateTime,
  localDateKey,
  localDateLabel,
  timeOnly,
} from '@/lib/format';
import { useAsync } from '@/lib/use-async';
import type { MerchantDetail, ReservationAvailability, ReservationCreated } from '@/lib/types';

/**
 * The booking flow.
 *
 * One screen, three decisions — day, party size, time — then a short form. The
 * two rules that shape the code:
 *
 *   1. The grid is the server's. `bookable` is computed against the party size
 *      the caller sent, so changing the party size refetches rather than
 *      re-filtering locally. A client that decided "six fits at 19:00" from
 *      `remaining >= 6` would be right until a concurrent booking landed
 *      between the render and the tap.
 *   2. The instant booked is the slot's `startsAt`, verbatim. The page never
 *      rebuilds a local time from the clock digits — that is how a booking
 *      lands an hour out across a DST change, which is exactly why the DTO
 *      demands an ISO instant.
 */
export function ReserveBooking({ merchant }: { merchant: MerchantDetail }) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { push } = useToast();

  const timezone = merchant.timezone || 'Asia/Hong_Kong';
  const today = useMemo(() => localDateKey(new Date(), timezone), [timezone]);

  const [dateKey, setDateKey] = useState(today);
  const [partySize, setPartySize] = useState(2);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);

  /**
   * Fetched once, without a party size.
   *
   * The `bookable` flag is only a hint here — the chosen party size is applied
   * client-side for the grid's disabled state, and the real authority is the
   * booking call itself, which re-validates against live counters. Fetching per
   * party-size change would make the stepper feel laggy for no correctness gain.
   */
  const availability = useAsync<ReservationAvailability>(
    () => api.reservations.availability(merchant.id, { from: dateKey, to: dateKey }),
    [merchant.id, dateKey],
  );

  // A new day means the previously selected instant is meaningless.
  useEffect(() => {
    setSelectedSlot(null);
  }, [dateKey]);

  const selected = useMemo(
    () => availability.data?.slots.find((slot) => slot.startsAt === selectedSlot) ?? null,
    [availability.data, selectedSlot],
  );

  const policy = availability.data?.policy;
  const minParty = policy?.minPartySize ?? 1;
  const maxParty = policy?.maxPartySize ?? 8;
  const canBook = availability.data?.enabled === true && availability.data?.acceptingNew === true;

  return (
    <>
      <CustomerNav />
      <div className="stack" style={{ maxWidth: 760, margin: '0 auto', padding: 'var(--space-5) var(--space-4) var(--space-8)' }}>
        <div className="stack-sm">
          <Link href={`/m/${merchant.slug}`} className="tiny muted">
            ← 返回 {merchant.name}
          </Link>
          <h1>預約訂位</h1>
          <span className="tiny dim">
            {merchant.name} · {dateTime(availability.data?.windowStart ?? null, timezone)} 起
          </span>
        </div>

        {availability.loading && !availability.data ? (
          <Card>
            <Empty icon="◌" title="讀取可訂時段…" />
          </Card>
        ) : availability.error ? (
          <Banner
            tone="danger"
            title="無法讀取訂位資料"
            action={<Button size="sm" onClick={() => availability.reload()}>重試</Button>}
          >
            {availability.error.message}
          </Banner>
        ) : availability.data ? (
          <>
            <ReservationNotice data={availability.data} />

            {canBook && (
              <>
                <PartySizeStepper
                  value={partySize}
                  min={minParty}
                  max={maxParty}
                  onChange={(next) => {
                    setPartySize(next);
                    // The chosen slot may no longer fit the new party size.
                    setSelectedSlot(null);
                  }}
                />

                <DayPicker
                  today={today}
                  advanceDays={policy?.advanceDays ?? 14}
                  value={dateKey}
                  onChange={setDateKey}
                />

                <SlotGrid
                  slots={availability.data.slots}
                  partySize={partySize}
                  timezone={timezone}
                  selected={selectedSlot}
                  onSelect={setSelectedSlot}
                />

                {selected && (
                  <BookingForm
                    merchant={merchant}
                    timezone={timezone}
                    startsAt={selected.startsAt}
                    partySize={partySize}
                    user={user}
                    authLoading={authLoading}
                    onBooked={(created) => {
                      push(created.autoConfirmed ? '訂位已確認' : '訂位已送出，等待店家確認', 'ok');
                      router.push(`/reservations/${created.id}`);
                    }}
                  />
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}

/**
 * The shop's own sentence, plus anything the platform needs to add.
 *
 * Ordered so the shop's prose is never buried: when they enabled the book and
 * wrote a notice, that notice is what a customer reads first, and the platform
 * only speaks up to explain why booking is unavailable.
 */
function ReservationNotice({ data }: { data: ReservationAvailability }) {
  if (!data.enabled) {
    return (
      <Banner tone="warn" title="此店家暫未開放線上訂位">
        歡迎直接致電店家查詢。
      </Banner>
    );
  }

  // The rest days inside the window, named. `notice` already explains the
  // generic case; this is the one that needs a date, because "no bookable
  // slots" without a reason reads as a broken page rather than "we are shut".
  const closed = data.closedDates ?? [];

  return (
    <div className="stack-sm">
      <Banner tone={data.acceptingNew ? 'info' : 'warn'}>{data.notice}</Banner>
      {closed.length > 0 && (
        <Banner tone="warn" title="店家休息日">
          {closed.join('、')}
          {closed.length === 1 ? ' 暫停營業。' : ' 暫停營業。'}
          請選擇其他日期。
        </Banner>
      )}
      {data.customerNotice && (
        <Card tight>
          <div className="stack-sm">
            <span className="tiny dim">店家提示</span>
            <span>{data.customerNotice}</span>
          </div>
        </Card>
      )}
    </div>
  );
}

function PartySizeStepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  return (
    <Card>
      <div className="row-between">
        <div className="stack-sm" style={{ gap: 2 }}>
          <span className="strong">用餐人數</span>
          <span className="tiny dim">
            每桌 {min}–{max} 位
          </span>
        </div>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <Button
            size="sm"
            onClick={() => onChange(Math.max(min, value - 1))}
            disabled={value <= min}
            aria-label="減少人數"
          >
            −
          </Button>
          <span className="num strong" style={{ minWidth: 34, textAlign: 'center', fontSize: 18 }}>
            {value}
          </span>
          <Button
            size="sm"
            onClick={() => onChange(Math.min(max, value + 1))}
            disabled={value >= max}
            aria-label="增加人數"
          >
            ＋
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The next `advanceDays` local dates, as tabs.
 *
 * Capped at the shop's own advance window rather than an arbitrary 14 — the
 * server would refuse a date past `advanceDays`, so offering one would be a
 * button that always fails. Ten tabs at a time, scrolled by day offset.
 */
function DayPicker({
  today,
  advanceDays,
  value,
  onChange,
}: {
  today: string;
  advanceDays: number;
  value: string;
  onChange: (next: string) => void;
}) {
  const count = Math.min(advanceDays, 30);
  const days = Array.from({ length: Math.max(count, 1) }, (_, index) => addDays(today, index));

  return (
    <Card>
      <CardHead title="日期" subtitle={`最多可預訂 ${advanceDays} 日內`} />
      <div className="row-wrap" style={{ gap: 'var(--space-2)' }}>
        {days.map((day, index) => (
          <button
            key={day}
            type="button"
            className="slot"
            data-active={day === value}
            onClick={() => onChange(day)}
            style={{ minWidth: 74 }}
          >
            {index === 0 ? '今日' : index === 1 ? '明日' : localDateLabel(day).replace(/（.*）/, '')}
            <span className="tiny dim" style={{ display: 'block', fontWeight: 500 }}>
              {localDateLabel(day).replace(/^\d+月\d+日/, '')}
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/**
 * The slot grid.
 *
 * `bookable` from the server is kept as a floor — a slot the shop already knows
 * is too full stays disabled — but the party size is applied on top, so the
 * grid explains *why* a time is out (「剩 2 位」) rather than silently dropping
 * it. A disabled slot with a reason is a better page than a shorter list.
 */
function SlotGrid({
  slots,
  partySize,
  timezone,
  selected,
  onSelect,
}: {
  slots: ReservationAvailability['slots'];
  partySize: number;
  timezone: string;
  selected: string | null;
  onSelect: (startsAt: string) => void;
}) {
  if (slots.length === 0) {
    return (
      <Card>
        <CardHead title="可選時段" />
        <Empty icon="○" title="這天沒有可訂時段">
          請選擇其他日期。
        </Empty>
      </Card>
    );
  }

  const fits = slots.filter((slot) => slot.remaining >= partySize).length;

  return (
    <Card>
      <CardHead
        title="可選時段"
        subtitle={fits > 0 ? `${fits} 個時段可容納 ${partySize} 位` : `沒有時段可容納 ${partySize} 位`}
      />
      <div className="slot-grid">
        {slots.map((slot) => {
          const enough = slot.remaining >= partySize;
          const disabled = !slot.bookable || !enough;
          return (
            <button
              key={slot.startsAt}
              type="button"
              className="slot"
              disabled={disabled}
              data-active={slot.startsAt === selected}
              onClick={() => onSelect(slot.startsAt)}
              title={disabled ? `僅剩 ${slot.remaining} 位` : `剩 ${slot.remaining} 位`}
              style={disabled ? { opacity: 0.38, cursor: 'not-allowed', fontWeight: 500 } : undefined}
            >
              {timeOnly(slot.startsAt, timezone)}
              {!disabled && (
                <span className="tiny dim" style={{ display: 'block', fontWeight: 500 }}>
                  剩 {slot.remaining}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The form that turns a chosen slot into a booking.
 *
 * Prefilled from the session — the name and phone are already known, and making
 * a customer retype their own number to book a table is friction with no
 * security value, since the shop is going to ring it anyway.
 *
 * The idempotency key is minted once per form mount and reused across retries of
 * the same submission, so a double-tap or a flaky network cannot book two
 * tables. It is deliberately NOT regenerated on a failed validation — that is
 * the same logical booking attempt.
 */
function BookingForm({
  merchant,
  timezone,
  startsAt,
  partySize,
  user,
  authLoading,
  onBooked,
}: {
  merchant: MerchantDetail;
  timezone: string;
  startsAt: string;
  partySize: number;
  user: { displayName: string; phone: string | null } | null;
  authLoading: boolean;
  onBooked: (created: ReservationCreated) => void;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // Fill from the session once it resolves. Guarded so a customer who has
  // already started typing is not overwritten by a late `me` response.
  useEffect(() => {
    if (!user) return;
    setName((current) => current || user.displayName || '');
    setPhone((current) => current || user.phone || '');
  }, [user]);

  const contactFilled = name.trim().length > 0 && phone.trim().length >= 5;

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const created = await api.reservations.place(
        {
          merchantId: merchant.id,
          startsAt,
          partySize,
          customerName: name.trim(),
          contactPhone: phone.trim(),
          ...(note.trim() ? { customerNote: note.trim() } : {}),
          merchantSlug: merchant.slug,
        },
        idempotencyKey,
      );
      onBooked(created);
    } catch (caught) {
      setError(describeBookingError(caught));
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHead
        title="確認訂位"
        subtitle={`${localDateLabel(localDateKey(startsAt, timezone), timezone)} ${timeOnly(startsAt, timezone)} · ${partySize} 位`}
      />

      {authLoading ? null : !user ? (
        <Banner
          tone="warn"
          title="請先登入"
          action={
            <Link href={`/login?next=/m/${merchant.slug}/reserve`}>
              <Button variant="primary" size="sm">
                登入
              </Button>
            </Link>
          }
        >
          訂位需要綁定一組電話號碼，登入後即可送出。
        </Banner>
      ) : (
        <div className="stack">
          <div className="grid-2">
            <Field label="訂位人姓名" htmlFor="res-name">
              <Input
                id="res-name"
                value={name}
                maxLength={80}
                placeholder="陳大文"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="聯絡電話" hint="店家會在需要時致電" htmlFor="res-phone">
              <Input
                id="res-phone"
                value={phone}
                maxLength={32}
                inputMode="tel"
                placeholder="+852 9000 0001"
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
          </div>

          <Field label="備註（選填）" hint="例如：需要兒童座椅、食物敏感" htmlFor="res-note">
            <Textarea
              id="res-note"
              value={note}
              maxLength={500}
              rows={2}
              placeholder="有咩想店家預先準備？"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>

          {error && <Banner tone="danger">{error}</Banner>}

          <Button
            variant="primary"
            block
            loading={saving}
            disabled={!contactFilled}
            onClick={() => void submit()}
          >
            送出訂位
          </Button>
          <span className="tiny dim">
            送出後{merchant.name}會盡快確認，你可以在「我的訂位」查看狀態。
          </span>
        </div>
      )}
    </Card>
  );
}

/**
 * Turn a booking failure into the sentence the customer actually needs.
 *
 * The API already names the reason in `code`; the value here is deciding what
 * the reader should DO about it. 「這個時段剛剛被訂滿」 tells them to pick
 * another time; a generic 422 leaves them staring at the page.
 */
function describeBookingError(caught: unknown): string {
  if (!(caught instanceof ApiError)) {
    return caught instanceof Error ? caught.message : '送出失敗，請再試一次';
  }

  switch (caught.code) {
    case 'RESERVATION_SLOT_UNAVAILABLE':
      return '這個時段剛剛被訂滿了，請選擇其他時間。';
    case 'RESERVATION_SLOT_MISALIGNED':
      return '這個時段的起點不在店家的訂位格線上，請重新選擇。';
    case 'RESERVATION_TOO_SOON':
      return '距離用餐時間太近，店家需要更多準備時間。請選擇較晚的時段。';
    case 'RESERVATION_TOO_FAR_AHEAD':
      return '這個日期超出店家可接受的預訂範圍。';
    case 'PARTY_SIZE_NOT_ALLOWED':
      return caught.message || '這個人數不符合店家的訂位規則。';
    case 'RESERVATIONS_DISABLED':
      return '店家暫停了線上訂位。';
    case 'RESERVATIONS_PAUSED':
      return '店家暫時停止接受新訂位，請稍後再試。';
    case 'IDEMPOTENCY_KEY_REUSED':
      return '這筆訂位已經送出過了，請勿重複提交。';
    default:
      return caught.validationMessage ?? caught.message;
  }
}
