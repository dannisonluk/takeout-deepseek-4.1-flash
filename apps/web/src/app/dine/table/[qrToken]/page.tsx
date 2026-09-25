'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CustomerNav } from '@/components/customer-nav';
import {
  Badge,
  Banner,
  Button,
  Card,
  ErrorBlock,
  Loading,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { money } from '@/lib/format';
import type { ScannedTable } from '@/lib/types';

/**
 * 店內點餐 — the guest's QR landing page. **Mobile-first.**
 *
 * WHAT THIS PAGE IS FOR
 * ---------------------
 * A phone camera resolves a table's QR. The guest is standing at the table, one
 * hand on the phone, and the page has exactly one job: get them from "code
 * scanned" to "food ordered" in as few taps as possible, without an account.
 *
 * So this page is a **router with a decision**, not a menu:
 *
 *   - The table is free → show 開始用餐 (party size), open a sitting, hand off
 *     to the ordering page with the one-time token.
 *   - A sitting is already open here → the guest is joining a table that is
 *     already eating. Say so plainly ("加入之後點的東西會記在同一張帳單") and
 *     hand off, because silently starting a second sitting at an occupied table
 *     would split one meal across two bills.
 *   - 店內點餐 is off, or the shop is shut → say WHICH, and stop. A single
 *     "unavailable" would send a guest looking for a waiter who is not at fault.
 *
 * WHY THE HANDOFF IS A REDIRECT WITH THE TOKEN IN THE URL
 * ------------------------------------------------------
 * Once a sitting exists, the one-time token lives in the address bar. That is
 * what makes the ordering page survive a lock-screen or a reload: the phone
 * holds the credential, so there is no login and no localStorage to lose. It
 * also means a guest who scans twice lands on the same tab rather than
 * accidentally opening a second one.
 */
export default function DineTablePage({
  params,
}: {
  params: Promise<{ qrToken: string }>;
}) {
  const { qrToken } = use(params);
  return <ResolveTable qrToken={qrToken} />;
}

function ResolveTable({ qrToken }: { qrToken: string }) {
  const router = useRouter();
  const toast = useToast();

  const scanned = useAsync<ScannedTable>(() => api.dining.scan(qrToken), [qrToken]);
  const [partySize, setPartySize] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A token this device already holds for this table, if any.
   *
   * `sessionStorage` rather than `localStorage`: the credential is scoped to the
   * browsing session, so handing the phone to a friend to look at the menu does
   * not leave an ordering credential on the device afterwards. It is a
   * convenience only — every real request re-validates server-side.
   */
  const remembered = useRememberedToken(qrToken);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.dining.openSession(qrToken, partySize);
      window.sessionStorage.setItem(`takeout.dine.${qrToken}`, result.guestToken);
      router.replace(`/dine/s/${encodeURIComponent(result.guestToken)}`);
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      toast.push(message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (scanned.error) {
    return (
      <Shell>
        <ErrorBlock error={scanned.error} onRetry={() => void scanned.reload()} />
        <p className="tiny dim" style={{ textAlign: 'center', marginTop: 'var(--space-3)' }}>
          如果這是舊的桌貼，請向店員索取新的 QR code。
        </p>
      </Shell>
    );
  }

  if (!scanned.data) {
    return (
      <Shell>
        <Loading rows={4} />
      </Shell>
    );
  }

  const table = scanned.data;

  if (!table.diningEnabled) {
    return (
      <Shell>
        <Stopped
          icon="🚫"
          title="此餐廳未開放掃碼點餐"
          subtitle="請直接向店員點餐。"
          slug={table.merchantSlug}
        />
      </Shell>
    );
  }

  if (!table.openNow) {
    return (
      <Shell>
        <Stopped
          icon="🕐"
          title="餐廳目前休息中"
          subtitle="營業時間內即可掃碼點餐。"
          slug={table.merchantSlug}
        />
      </Shell>
    );
  }

  // This device opened the sitting: offer to go back to it.
  if (table.session && remembered) {
    return (
      <Shell>
        <JoinExisting
          table={table}
          onContinue={() => router.replace(`/dine/s/${encodeURIComponent(remembered)}`)}
          onStartFresh={() => {
            window.sessionStorage.removeItem(`takeout.dine.${qrToken}`);
            void scanned.reload();
          }}
        />
      </Shell>
    );
  }

  // Somebody at this table is already eating: offer to join that bill.
  if (table.session) {
    return (
      <Shell>
        <JoinOpen
          table={table}
          partySize={partySize}
          onPartySize={setPartySize}
          busy={busy}
          error={error}
          onJoin={() => void open()}
        />
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="stack">
        <Card>
          <div className="stack" style={{ textAlign: 'center' }}>
            <span style={{ fontSize: 40 }}>🍽️</span>
            <span className="strong" style={{ fontSize: 18 }}>
              {table.merchantName}
            </span>
            <div className="row" style={{ justifyContent: 'center', gap: 'var(--space-2)' }}>
              <Badge tone="accent">{table.tableCode}</Badge>
              {table.tableLabel && <span className="tiny dim">{table.tableLabel}</span>}
            </div>
            <span className="tiny muted">
              這一桌還沒有人開始用餐。按下面開始，之後點的每一輪都會記在同一張帳單上。
            </span>
          </div>
        </Card>

        {error && <Banner tone="danger">{error}</Banner>}

        <Card>
          <div className="stack">
            <PartySize value={partySize} onChange={setPartySize} max={table.seats * 2} />
            <Button variant="primary" size="lg" block loading={busy} onClick={() => void open()}>
              開始用餐並點餐
            </Button>
            <p className="tiny dim" style={{ textAlign: 'center' }}>
              不需要登入。入座後這一桌會拿到一個一次性的點餐碼。
            </p>
          </div>
        </Card>
      </div>
    </Shell>
  );
}

/** Read the remembered one-time token for this table, if this device has one. */
function useRememberedToken(qrToken: string): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    setToken(window.sessionStorage.getItem(`takeout.dine.${qrToken}`));
  }, [qrToken]);
  return token;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 520 }}>
        {children}
      </div>
    </>
  );
}

function Stopped({
  icon,
  title,
  subtitle,
  slug,
}: {
  icon: string;
  title: string;
  subtitle: string;
  slug: string;
}) {
  return (
    <Card>
      <div className="stack" style={{ textAlign: 'center', padding: 'var(--space-5) 0' }}>
        <span style={{ fontSize: 40 }}>{icon}</span>
        <span className="strong">{title}</span>
        <span className="tiny dim">{subtitle}</span>
        <Link href={`/m/${slug}`}>
          <Button variant="ghost" size="sm">
            查看餐廳菜單
          </Button>
        </Link>
      </div>
    </Card>
  );
}

/** This device already holds a token for a live sitting here. */
function JoinExisting({
  table,
  onContinue,
  onStartFresh,
}: {
  table: ScannedTable;
  onContinue: () => void;
  onStartFresh: () => void;
}) {
  const session = table.session!;
  return (
    <div className="stack">
      <Card>
        <div className="stack" style={{ textAlign: 'center' }}>
          <span style={{ fontSize: 36 }}>✅</span>
          <span className="strong" style={{ fontSize: 18 }}>
            你已經在 {table.tableCode} 用餐中
          </span>
          <span className="tiny muted">
            這一桌已經開始 {session.seatedMinutes} 分鐘，合共 {money(session.totalMinor)}。
            繼續點餐會加到同一張帳單。
          </span>
          <Button variant="primary" size="lg" block onClick={onContinue}>
            繼續點餐
          </Button>
        </div>
      </Card>
      <Button variant="ghost" block onClick={onStartFresh}>
        這不是我這一桌 / 重新掃碼
      </Button>
    </div>
  );
}

/** Somebody else at this table opened the sitting. Offer to join it. */
function JoinOpen({
  table,
  partySize,
  onPartySize,
  busy,
  error,
  onJoin,
}: {
  table: ScannedTable;
  partySize: number;
  onPartySize: (next: number) => void;
  busy: boolean;
  error: string | null;
  onJoin: () => void;
}) {
  const session = table.session!;
  return (
    <div className="stack">
      <Card>
        <div className="stack" style={{ textAlign: 'center' }}>
          <span style={{ fontSize: 36 }}>👥</span>
          <span className="strong" style={{ fontSize: 18 }}>
            {table.tableCode} 已經在用餐中
          </span>
          <span className="tiny muted">
            這一桌已經開始 {session.seatedMinutes} 分鐘
            {session.partySize ? ` · ${session.partySize} 位` : ''}。加入之後，你點的東西會記在同一張帳單上。
          </span>
          <div className="row" style={{ justifyContent: 'center', gap: 'var(--space-2)' }}>
            <Badge tone="info">目前 {money(session.totalMinor)}</Badge>
            <Badge tone="neutral">{session.orderCount} 輪已下單</Badge>
          </div>
        </div>
      </Card>

      {error && <Banner tone="danger">{error}</Banner>}

      <Card>
        <div className="stack">
          <PartySize value={partySize} onChange={onPartySize} max={table.seats * 2} />
          <Button variant="primary" size="lg" block loading={busy} onClick={onJoin}>
            加入這一桌
          </Button>
          <p className="tiny dim" style={{ textAlign: 'center' }}>
            若這其實是新的一桌，請先請店員結帳再重新掃碼。
          </p>
        </div>
      </Card>
    </div>
  );
}

/** A big-tap-target party size stepper, sized for a thumb. */
function PartySize({
  value,
  onChange,
  max,
}: {
  value: number;
  onChange: (next: number) => void;
  max: number;
}) {
  const cap = Math.max(1, Math.min(max, 50));
  return (
    <div className="stack-sm" style={{ gap: 6 }}>
      <span className="label">用餐人數</span>
      <div className="row" style={{ gap: 'var(--space-3)', justifyContent: 'center' }}>
        <button
          type="button"
          className="step-btn"
          onClick={() => onChange(Math.max(1, value - 1))}
          disabled={value <= 1}
          aria-label="減少"
        >
          −
        </button>
        <span className="step-value">{value}</span>
        <button
          type="button"
          className="step-btn"
          onClick={() => onChange(Math.min(cap, value + 1))}
          disabled={value >= cap}
          aria-label="增加"
        >
          +
        </button>
      </div>
    </div>
  );
}
