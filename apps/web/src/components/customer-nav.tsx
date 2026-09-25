'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Button } from './ui';

/**
 * Customer-facing top navigation.
 *
 * A top bar rather than the sidebar `AppShell` uses, because the audience is
 * different: a customer is on a phone, holding it one-handed, at a bus stop.
 * A 232px sidebar would eat half the screen and put the menu behind a drawer.
 */
export function CustomerNav() {
  const pathname = usePathname();
  const { user, loading } = useAuth();

  const link = (href: string, label: string, exact = false) => {
    const active = exact ? pathname === href : pathname.startsWith(href);
    return (
      <Link
        href={href}
        className="nav-item"
        data-active={active}
        style={{ padding: '5px 10px' }}
      >
        {label}
      </Link>
    );
  };

  return (
    <header
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface-1)',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      <div
        className="row-between"
        style={{ maxWidth: 980, margin: '0 auto', padding: 'var(--space-3) var(--space-4)' }}
      >
        <Link href="/" className="nav-brand" style={{ padding: 0 }}>
          <span className="nav-brand-mark">取</span>
          <span>自取平台</span>
        </Link>

        <nav className="row-wrap">
          {link('/', '找餐廳', true)}
          {user && link('/orders', '我的訂單')}
          {user && link('/refunds', '退款申請')}
          {user && link('/reservations', '我的訂位')}
          {/*
            候位 is NOT under `user &&`. A walk-in guest is deliberately not
            signed in — the queue is keyed on their phone number, not an
            account — so gating this link on a session would hide the one page
            the feature exists for. It lands on a recovery screen when no phone
            is remembered.
          */}
          {link('/queue', '現場候位')}
          {user?.role === 'CUSTOMER' && link('/merchant-apply', '申請入駐')}
          {/* Staff who land on the storefront need a way back to their console. */}
          {(user?.role === 'MERCHANT_OWNER' || user?.role === 'MERCHANT_STAFF') &&
            link('/merchant', '商戶後台')}
          {user?.role === 'ADMIN' && link('/admin', '管理後台')}

          {loading ? null : user ? (
            <Link href="/account" className="row" style={{ gap: 8 }}>
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  background: 'var(--surface-3)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                }}
              >
                {user.displayName.slice(0, 1)}
              </span>
            </Link>
          ) : (
            <Link href="/login">
              <Button variant="primary" size="sm">
                登入
              </Button>
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
