'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { ROLE_LABEL, phone as formatPhone } from '@/lib/format';
import type { UserRole } from '@/lib/types';
import { Button } from './ui';

interface NavItem {
  href: string;
  label: string;
  /** Rendered as a pill — for a queue that needs attention. */
  badge?: number | undefined;
  /** Match descendants too. Off for `/admin`, which would swallow every route. */
  exact?: boolean;
}

interface NavGroup {
  title?: string;
  items: NavItem[];
}

export function AppShell({
  groups,
  title,
  subtitle,
  actions,
  children,
}: {
  groups: NavGroup[];
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <div className="shell">
      <nav className="nav">
        <Link href="/" className="nav-brand">
          <span className="nav-brand-mark">取</span>
          <span>自取平台</span>
        </Link>

        {groups.map((group, index) => (
          <div className="nav-group" key={group.title ?? index}>
            {group.title && <span className="nav-group-title">{group.title}</span>}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="nav-item"
                data-active={isActive(item)}
              >
                <span>{item.label}</span>
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className="badge"
                    style={{
                      background: 'var(--accent)',
                      color: '#12161d',
                      padding: '0 6px',
                      fontSize: 11,
                    }}
                  >
                    {item.badge}
                  </span>
                )}
              </Link>
            ))}
          </div>
        ))}

        <div className="nav-foot">
          {user && (
            <div className="stack-sm" style={{ gap: 1, padding: '0 var(--space-2)' }}>
              <span className="strong truncate">{user.displayName}</span>
              <span className="tiny dim">
                {ROLE_LABEL[user.role]}
                {user.phone ? ` · ${formatPhone(user.phone)}` : ''}
              </span>
            </div>
          )}
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            登出
          </Button>
        </div>
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{title}</h1>
            {subtitle && <span className="tiny muted">{subtitle}</span>}
          </div>
          {actions && <div className="row-wrap">{actions}</div>}
        </header>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}

/**
 * The nav for each role.
 *
 * Exported as data rather than baked into the shell so the admin console can
 * inject live counts (pending merchants, stuck outbox events) without the shell
 * needing to know what an outbox is.
 *
 * `counts` values are `number | undefined` because a page that only knows some
 * of the figures should be able to pass what it has — `{ activeOrders }` from a
 * list response, say — without inventing zeros for the rest. An absent badge
 * and a zero badge look different on purpose: zero means "we checked, there are
 * none", absent means "we did not check".
 */
export function navForRole(
  role: UserRole,
  counts?: Record<string, number | undefined>,
): NavGroup[] {
  if (role === 'ADMIN') {
    return [
      {
        items: [
          { href: '/admin', label: '總覽', exact: true },
          { href: '/admin/orders', label: '訂單', badge: counts?.activeOrders },
          { href: '/admin/merchants', label: '商戶', badge: counts?.pendingMerchants },
        ],
      },
      {
        title: '財務',
        items: [
          { href: '/admin/finance', label: '結算與對帳' },
          { href: '/admin/refunds', label: '退款申請' },
          { href: '/admin/config', label: '平台設定' },
        ],
      },
      {
        title: '維運',
        items: [
          { href: '/admin/users', label: '使用者' },
          { href: '/admin/ops', label: '系統與稽核', badge: counts?.outboxDeadLetter },
        ],
      },
    ];
  }

  if (role === 'MERCHANT_OWNER' || role === 'MERCHANT_STAFF') {
    return [
      {
        items: [
          { href: '/merchant', label: '今日概況', exact: true },
          { href: '/merchant/orders', label: '訂單廚房板', badge: counts?.activeOrders },
          { href: '/merchant/reservations', label: '訂位簿', badge: counts?.pendingReservations },
          // 現場候位 and 店內點餐 sit with the other *operational* screens
          // (kitchen, reservations) rather than under 設定, because they are
          // used mid-service with a guest standing in front of the host. A
          // screen a host has to hunt for during a rush is a screen that does
          // not exist.
          { href: '/merchant/queue', label: '現場候位', badge: counts?.waitingGuests },
          { href: '/merchant/dining', label: '店內桌況', badge: counts?.occupiedTables },
          { href: '/merchant/refunds', label: '退款申請', badge: counts?.openRefunds },
          { href: '/merchant/closures', label: '特別休息日' },
          { href: '/merchant/menu', label: '菜單管理' },
          { href: '/merchant/analytics', label: '營業報表' },
          { href: '/merchant/settings', label: '商戶設定' },
        ],
      },
      {
        title: '其他',
        items: [
          { href: '/', label: '顧客前台' },
          { href: '/orders', label: '我的訂單' },
          { href: '/reservations', label: '我的訂位' },
        ],
      },
    ];
  }

  return [
    {
      items: [
        { href: '/', label: '找餐廳', exact: true },
        { href: '/orders', label: '我的訂單' },
        { href: '/refunds', label: '退款申請' },
        { href: '/reservations', label: '我的訂位' },
      ],
    },
    {
      title: '商戶',
      // NOT `/merchant/apply` — that path sits inside the merchant portal's
      // route group, whose layout requires a MERCHANT_* role. An applicant is
      // still a CUSTOMER, so the form lives outside the guarded tree.
      items: [{ href: '/merchant-apply', label: '申請入駐' }],
    },
  ];
}
