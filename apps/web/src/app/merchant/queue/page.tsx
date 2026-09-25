'use client';

import { useEffect, useState } from 'react';
import { MerchantShell } from '@/components/merchant-shell';
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
  Stat,
  Textarea,
  Toggle,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { useAsync, useTicker } from '@/lib/use-async';
import {
  ACTIVE_WAITLIST_STATUSES,
  WAITLIST_ACTION_LABEL,
  WAITLIST_ACTION_NEEDS_CONFIRM,
  WAITLIST_STATUS_SHORT_LABEL,
  WAITLIST_STATUS_TONE,
  phone as formatPhone,
  timeOnly,
  waitDuration,
  waitTone,
} from '@/lib/format';
import type { MerchantQueue, MerchantQueueEntry, WaitlistStatus } from '@/lib/types';

/**
 * 現場候位 — the host board. **Dark, large type, tablet on a counter.**
 *
 * THE UI BRIEF, MADE CONCRETE
 * ---------------------------
 * This screen is not the customer page rotated. The reading conditions are
 * opposite: a tablet lying on a host's counter, in a dim dining room, glanced at
 * from a metre away while also talking to somebody. That drives four decisions:
 *
 *   1. **Cards, not a table.** A tablet on a counter is usually landscape and
 *      30–40cm from the eye, but it is read in a *glance*. Each waiting party is
 *      a tile with the number at large size; the number is what the host calls,
 *      so it is what must be legible without leaning in.
 *   2. **Buttons come from the API.** Every row carries
 *      `allowedNextTransitions`, computed by the same state machine the write
 *      path uses. The board renders exactly those. A board that offers a button
 *      the server will refuse is a board that looks broken, and the host stops
 *      trusting it on the first refusal.
 *   3. **The happy path is one tap.** 叫號 and 入座 are single taps with no
 *      dialog — a host with a guest in front of them must not be made to fill in
 *      a form. Only the two irreversible verdicts (過號, 取消) ask for a confirm.
 *   4. **It tells you what changed.** A new ticket or a newly-called guest is
 *      the reason this screen exists, so the poll is fast (10s) and the counts
 *      are always on screen. A board you have to refresh is a board the host
 *      stops looking at.
 *
 * The whole day arrives in ONE request (`api.waitlist.board`), including today's
 * log, the counts and `nextTicketNo` — a board that fetched "active" and "log"
 * separately would show a ticket in neither list for the half-second between
 * the two responses, and a host tapping in that window is the failure mode.
 */

/** 10s. A walk-in queue moves on a human timescale, but a *call* must land fast. */
const POLL_MS = 10_000;

export default function MerchantQueuePage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const [view, setView] = useState<'active' | 'completed'>('active');
  const [settingsOpen, setSettingsOpen] = useState(false);

  const board = useAsync<MerchantQueue>(() => api.waitlist.board(merchantId!), [merchantId]);

  /**
   * Poll while the board is on screen.
   *
   * Suppressed while the settings modal is open: a reload replaces the board
   * object, and a modal that re-renders its parent mid-edit would let an
   * incoming ticket reset a half-typed form.
   */
  const tick = useTicker(POLL_MS);
  const reload = board.reload;
  useEffect(() => {
    if (settingsOpen) return;
    void reload();
  }, [tick, settingsOpen, reload]);

  if (!merchant || !merchantId) return null;

  const data = board.data;

  async function act(entry: MerchantQueueEntry, to: WaitlistStatus, reason?: string) {
    try {
      await api.waitlist.transition(merchantId!, entry.id, to, reason);
      toast.push(`${entry.ticketNo}：${WAITLIST_ACTION_LABEL[to]} 完成`, 'ok');
      await board.reload();
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
      // A 409 means the board is stale (another host moved it, or the sweep
      // fired). Refetch so the buttons match reality again.
      await board.reload();
    }
  }

  async function sweep(dryRun: boolean) {
    try {
      const result = await api.waitlist.sweep(merchantId!, dryRun);
      toast.push(result.message, dryRun ? 'info' : 'ok');
      if (!dryRun) await board.reload();
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
    }
  }

  const rows = data ? (view === 'active' ? data.active : data.completed) : [];

  return (
    <MerchantShell
      title="現場候位"
      subtitle={
        data
          ? `${data.serviceDate} · 下一張號碼 ${data.nextTicketNo} · 每 ${POLL_MS / 1000} 秒更新`
          : undefined
      }
      /*
       * The live queue length feeds the sidebar badge, so a host working the
       * kitchen board sees the queue growing without navigating back.
       */
      counts={data ? { waitingGuests: data.counts.waiting + data.counts.called } : undefined}
      actions={
        <div className="row">
          <Button size="sm" onClick={() => void board.reload()}>
            重新整理
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            候位設定
          </Button>
        </div>
      }
    >
      <div className="stack">
        {board.error ? (
          <ErrorBlock error={board.error} onRetry={() => void board.reload()} />
        ) : !data ? (
          <Loading rows={5} />
        ) : !data.enabled ? (
          <Banner tone="warn" title="現場候位目前未開放">
            <div className="stack-sm">
              <span className="tiny">
                開啟後顧客即可在餐廳頁取號。目前在後台的「候位設定」中可以開啟。
              </span>
              <div>
                <Button size="sm" variant="primary" onClick={() => setSettingsOpen(true)}>
                  前往開啟
                </Button>
              </div>
            </div>
          </Banner>
        ) : (
          <>
            {/* ---- the counts, always visible ----------------------------- */}
            <div className="board-stats">
              <Stat label="候位中" value={data.counts.waiting} tone={data.counts.waiting > 0 ? 'info' : undefined} />
              <Stat label="已叫號" value={data.counts.called} tone={data.counts.called > 0 ? 'warn' : undefined} />
              <Stat label="已入座" value={data.counts.seated} tone="ok" />
              <Stat label="過號" value={data.counts.noShow} />
              <Stat label="已取消" value={data.counts.cancelled} />
            </div>

            {!data.acceptingNow && (
              <Banner tone="warn">
                餐廳目前不在營業時間，但仍可接受候位號碼（設定為允許）。若要停止收號，請關閉候位功能。
              </Banner>
            )}

            {/* ---- the board ---------------------------------------------- */}
            <Card
              flush
              className="board-card"
            >
              <CardHead
                title={
                  <div className="row" style={{ gap: 'var(--space-3)' }}>
                    <span>{view === 'active' ? '現場輪候' : '今日紀錄'}</span>
                    <Button size="sm" variant={view === 'active' ? 'primary' : 'ghost'} onClick={() => setView('active')}>
                      輪候 {data.active.length}
                    </Button>
                    <Button
                      size="sm"
                      variant={view === 'completed' ? 'primary' : 'ghost'}
                      onClick={() => setView('completed')}
                    >
                      紀錄 {data.completed.length}
                    </Button>
                  </div>
                }
                action={
                  <div className="row">
                    {view === 'active' && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void sweep(true)}
                          title="先看看有哪些會變成過號，不會真的執行"
                        >
                          預覽逾時
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void sweep(false)}>
                          清理逾時
                        </Button>
                      </>
                    )}
                  </div>
                }
              />

              {rows.length === 0 ? (
                <Empty
                  icon={view === 'active' ? '🎫' : '📋'}
                  title={view === 'active' ? '目前沒有人排隊' : '今天還沒有紀錄'}
                />
              ) : view === 'active' ? (
                <div className="board-grid">
                  {rows.map((entry) => (
                    <TicketTile key={entry.id} entry={entry} onAct={act} />
                  ))}
                </div>
              ) : (
                <div className="board-grid">
                  {rows.map((entry) => (
                    <LogTile key={entry.id} entry={entry} onAct={act} />
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>

      {settingsOpen && merchantId && (
        <QueueSettings
          merchantId={merchantId}
          onClose={() => setSettingsOpen(false)}
          onSaved={async () => {
            await board.reload();
          }}
        />
      )}
    </MerchantShell>
  );
}

/**
 * One waiting party, as a tile.
 *
 * The layout is deliberately hierarchical rather than dense: number first (what
 * the host calls out), then party size, then the wait, then the actions. A host
 * scanning three tiles needs to answer "who is next" before "how long have they
 * waited", so the number is the top-left and the largest thing on the tile.
 */
function TicketTile({
  entry,
  onAct,
}: {
  entry: MerchantQueueEntry;
  onAct: (entry: MerchantQueueEntry, to: WaitlistStatus, reason?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState<WaitlistStatus | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const called = entry.status === 'CALLED';

  async function go(to: WaitlistStatus) {
    if (WAITLIST_ACTION_NEEDS_CONFIRM.includes(to)) {
      setPending(to);
      setReason('');
      return;
    }
    setBusy(true);
    await onAct(entry, to);
    setBusy(false);
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    await onAct(entry, pending, reason.trim() || undefined);
    setBusy(false);
    setPending(null);
  }

  return (
    <div className="tile" data-state={called ? 'called' : 'waiting'}>
      {/* ---- number + status ------------------------------------------- */}
      <div className="tile-head">
        <span className="tile-no">{entry.ticketNo}</span>
        <div className="stack-sm" style={{ gap: 3, alignItems: 'flex-end' }}>
          <Badge tone={WAITLIST_STATUS_TONE[entry.status]} dot>
            {WAITLIST_STATUS_SHORT_LABEL[entry.status]}
          </Badge>
          {entry.position > 0 && (
            <span className="tiny dim">第 {entry.position} 位</span>
          )}
        </div>
      </div>

      {/* ---- party + wait ---------------------------------------------- */}
      <div className="tile-body">
        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <span className="tile-party">{entry.partySize}</span>
          <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 4 }}>
            位
          </span>
          <span className="grow" />
          <div className="stack-sm" style={{ gap: 1, alignItems: 'flex-end' }}>
            <span className="tiny dim">已等候</span>
            <Badge tone={waitTone(entry.waitedMinutes)}>{waitDuration(entry.waitedMinutes)}</Badge>
          </div>
        </div>

        <span className="small strong truncate">{entry.guestName}</span>

        <div className="row-between">
          <a className="small num" href={`tel:${entry.contactPhone}`}>
            {formatPhone(entry.contactPhone)}
          </a>
          <span className="tiny dim">{timeOnly(entry.joinedAt)} 取號</span>
        </div>

        {entry.note && <span className="tiny muted">備註：{entry.note}</span>}

        {called && entry.callDeadlineAt && (
          <span className="tiny" style={{ color: 'var(--warn)' }}>
            叫號中 · 限時至 {timeOnly(entry.callDeadlineAt)}
          </span>
        )}
      </div>

      {/* ---- the actions the API says are legal ------------------------ */}
      <div className="tile-actions">
        {entry.allowedNextTransitions.length === 0 ? (
          <span className="tiny dim">沒有可執行的操作</span>
        ) : (
          <>
            {entry.allowedNextTransitions.map((to) => (
              <Button
                key={to}
                size="lg"
                block
                variant={
                  to === 'SEATED' ? 'primary' : to === 'CALLED' ? 'default' : 'danger'
                }
                loading={busy && pending === null && to === 'SEATED'}
                disabled={busy}
                onClick={() => void go(to)}
              >
                {WAITLIST_ACTION_LABEL[to]}
              </Button>
            ))}
            {entry.allowedNextTransitions.filter((to) => ACTIVE_WAITLIST_STATUSES.includes(to)).length >
              0 &&
              entry.status === 'CALLED' && (
                <Button
                  size="lg"
                  block
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void go('WAITING')}
                >
                  放回候位
                </Button>
              )}
          </>
        )}
      </div>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? `${entry.ticketNo}：${WAITLIST_ACTION_LABEL[pending]}` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void confirm()}>
              確定
            </Button>
          </>
        }
      >
        <Banner tone="warn">
          {pending === 'NO_SHOW'
            ? '標記過號後就不會再叫這位客人。若他稍後出現，需要重新取號。'
            : '取消號碼後這位客人會離開隊伍，需要重新取號。'}
        </Banner>
        <Field label="原因（選填）" hint="會記錄在今日紀錄中">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              pending === 'NO_SHOW' ? '例如：叫號三次無人回應' : '例如：客人自行離去'
            }
            maxLength={300}
            rows={2}
          />
        </Field>
      </Modal>
    </div>
  );
}

/** One ended ticket. No actions — the log is a record, not a control surface. */
function LogTile({
  entry,
  onAct,
}: {
  entry: MerchantQueueEntry;
  onAct: (entry: MerchantQueueEntry, to: WaitlistStatus, reason?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="tile" data-state="ended">
      <div className="tile-head">
        <span className="tile-no" style={{ opacity: 0.75 }}>
          {entry.ticketNo}
        </span>
        <Badge tone={WAITLIST_STATUS_TONE[entry.status]}>{WAITLIST_STATUS_SHORT_LABEL[entry.status]}</Badge>
      </div>
      <div className="tile-body">
        <div className="row" style={{ gap: 'var(--space-3)' }}>
          <span className="tile-party" style={{ fontSize: 26 }}>
            {entry.partySize}
          </span>
          <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 2 }}>
            位
          </span>
          <span className="grow" />
          <span className="tiny dim">{waitDuration(entry.waitedMinutes)}</span>
        </div>
        <span className="small strong truncate">{entry.guestName}</span>
        <span className="tiny dim">
          {timeOnly(entry.joinedAt)} 取號
          {entry.seatedAt && ` · ${timeOnly(entry.seatedAt)} 入座`}
        </span>
        {entry.statusReason && <span className="tiny muted">{entry.statusReason}</span>}
      </div>
      {/* A guest who was marked 過號 by mistake is the one recoverable case, and
          the machine allows SEATED or WAITING from NO_SHOW — so the log offers
          exactly those, rather than being read-only. */}
      {entry.allowedNextTransitions.length > 0 && (
        <div className="tile-actions">
          {entry.allowedNextTransitions
            .filter((to) => to === 'SEATED' || to === 'WAITING')
            .map((to) => (
              <Button
                key={to}
                size="sm"
                block
                variant={to === 'SEATED' ? 'default' : 'ghost'}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onAct(entry, to);
                  setBusy(false);
                }}
              >
                {to === 'SEATED' ? '補記入座' : '放回候位'}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}

/** The queue settings, in a modal so the board stays on screen behind it. */
function QueueSettings({
  merchantId,
  onClose,
  onSaved,
}: {
  merchantId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const toast = useToast();
  const settings = useAsync(() => api.waitlist.settings(merchantId), [merchantId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<{
    enabled: boolean;
    acceptWhenClosed: boolean;
    minPartySize: string;
    maxPartySize: string;
    averageTurnMinutes: string;
    callTimeoutMinutes: string;
    customerNotice: string;
  } | null>(null);

  const data = settings.data;
  if (data && form === null) {
    setForm({
      enabled: data.policy.enabled,
      acceptWhenClosed: data.policy.acceptWhenClosed,
      minPartySize: String(data.policy.minPartySize),
      maxPartySize: String(data.policy.maxPartySize),
      averageTurnMinutes: String(data.policy.averageTurnMinutes),
      callTimeoutMinutes: String(data.policy.callTimeoutMinutes),
      customerNotice: data.customerNotice ?? '',
    });
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      await api.waitlist.updateSettings(merchantId, {
        enabled: form.enabled,
        acceptWhenClosed: form.acceptWhenClosed,
        minPartySize: Number(form.minPartySize),
        maxPartySize: Number(form.maxPartySize),
        averageTurnMinutes: Number(form.averageTurnMinutes),
        callTimeoutMinutes: Number(form.callTimeoutMinutes),
        customerNotice: form.customerNotice.trim() || null,
      });
      toast.push('候位設定已儲存', 'ok');
      await onSaved();
      onClose();
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      toast.push(message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="候位設定"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!form || settings.loading}
            onClick={() => void save()}
          >
            儲存
          </Button>
        </>
      }
    >
      {settings.error ? (
        <ErrorBlock error={settings.error} onRetry={() => void settings.reload()} />
      ) : !form ? (
        <Loading rows={4} />
      ) : (
        <div className="stack">
          {error && <Banner tone="danger">{error}</Banner>}

          <Toggle
            checked={form.enabled}
            onChange={(next) => setForm({ ...form, enabled: next })}
            disabled={busy}
            onLabel="候位開放中"
            offLabel="候位已關閉"
          />

          <div className="stack-sm">
            <span className="tiny dim">營業時間外是否仍可取號</span>
            <Toggle
              checked={form.acceptWhenClosed}
              onChange={(next) => setForm({ ...form, acceptWhenClosed: next })}
              disabled={busy || !form.enabled}
              onLabel="休息時也可取號"
              offLabel="只在營業時間收號"
            />
            <span className="tiny dim">
              關閉時，顧客在休息時間只會看到「營業時間內即可取號」，不會拿到號碼。
            </span>
          </div>

          <div className="grid-2">
            <Field label="最少人數" hint="1–30">
              <Input
                value={form.minPartySize}
                onChange={(event) => setForm({ ...form, minPartySize: event.target.value })}
                inputMode="numeric"
                disabled={busy || !form.enabled}
              />
            </Field>
            <Field label="最多人數" hint="1–50">
              <Input
                value={form.maxPartySize}
                onChange={(event) => setForm({ ...form, maxPartySize: event.target.value })}
                inputMode="numeric"
                disabled={busy || !form.enabled}
              />
            </Field>
          </div>

          <div className="grid-2">
            <Field label="平均翻桌時間（分鐘）" hint="5–240。用於估算等候時間">
              <Input
                value={form.averageTurnMinutes}
                onChange={(event) => setForm({ ...form, averageTurnMinutes: event.target.value })}
                inputMode="numeric"
                disabled={busy || !form.enabled}
              />
            </Field>
            <Field label="叫號等候上限（分鐘）" hint="1–120。逾時自動標記過號">
              <Input
                value={form.callTimeoutMinutes}
                onChange={(event) => setForm({ ...form, callTimeoutMinutes: event.target.value })}
                inputMode="numeric"
                disabled={busy || !form.enabled}
              />
            </Field>
          </div>

          <Field label="給顧客的提示" hint="顯示在顧客取號頁。例如：請在門口等候">
            <Textarea
              value={form.customerNotice}
              onChange={(event) => setForm({ ...form, customerNotice: event.target.value })}
              maxLength={500}
              rows={2}
              disabled={busy || !form.enabled}
            />
          </Field>

          <span className="tiny dim">
            {data?.openNow ? '餐廳目前營業中。' : '餐廳目前不在營業時間。'}
          </span>
        </div>
      )}
    </Modal>
  );
}
