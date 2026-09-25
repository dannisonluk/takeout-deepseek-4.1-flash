'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AppShell, navForRole } from './app-shell';
import { Button } from './ui';

/**
 * The admin shell.
 *
 * `counts` is passed in rather than fetched here. The only endpoint that
 * produces all three badge figures is `GET /admin/dashboard`, which is a
 * multi-table aggregation — calling it from the shell would make every admin
 * page pay for the dashboard's queries just to draw a number in the sidebar.
 * Pages that already have the figures hand them over; the rest simply show no
 * badge.
 */
export function AdminShell({
  title,
  subtitle,
  actions,
  counts,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  counts?: Record<string, number | undefined>;
  children: ReactNode;
}) {
  return (
    <AppShell
      groups={navForRole('ADMIN', counts)}
      title={title}
      subtitle={subtitle}
      actions={
        <>
          <Link href="/" target="_blank">
            <Button size="sm" variant="ghost">
              顧客前台 ↗
            </Button>
          </Link>
          {actions}
        </>
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * A pager for the offset/limit admin lists.
 *
 * The admin endpoints page with `limit`/`offset` (not a cursor), so the control
 * is arithmetic on those two numbers. The last page is often short, which is
 * why "next" is disabled by the total rather than by a full page.
 */
export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (nextOffset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <div className="row-between" style={{ padding: 'var(--space-3) var(--space-4)' }}>
      <span className="tiny muted">
        第 {from}–{to} 筆，共 {total} 筆
      </span>
      <div className="row">
        <Button
          size="sm"
          disabled={!canPrev}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          上一頁
        </Button>
        <Button size="sm" disabled={!canNext} onClick={() => onChange(offset + limit)}>
          下一頁
        </Button>
      </div>
    </div>
  );
}
