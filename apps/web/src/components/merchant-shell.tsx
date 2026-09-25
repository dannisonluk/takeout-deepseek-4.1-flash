'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useMerchant } from '@/lib/merchant';
import { MERCHANT_STATUS_LABEL, MERCHANT_STATUS_TONE } from '@/lib/format';
import type { OwnedMerchant } from '@/lib/types';
import { AppShell, navForRole } from './app-shell';
import { Badge, Select } from './ui';

/**
 * The sidebar shell plus a shop switcher.
 *
 * The switcher only renders when there is more than one shop. A single-shop
 * merchant seeing a dropdown with one option learns nothing and loses a row of
 * screen space; a two-shop merchant cannot work without it.
 */
export function MerchantShell({
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
  const { user } = useAuth();
  const { merchants, merchant, select } = useMerchant();

  return (
    <AppShell
      groups={navForRole(user?.role ?? 'CUSTOMER', counts)}
      title={title}
      subtitle={subtitle}
      actions={
        <>
          {merchants.length > 1 && merchant && (
            <Select
              value={merchant.id}
              onChange={(event) => select(event.target.value)}
              aria-label="切換商戶"
              style={{ width: 'auto', minWidth: 160 }}
            >
              {merchants.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          )}
          {merchant && (
            <Badge tone={MERCHANT_STATUS_TONE[merchant.status]}>
              {MERCHANT_STATUS_LABEL[merchant.status]}
            </Badge>
          )}
          {actions}
        </>
      }
    >
      {children}
    </AppShell>
  );
}

/**
 * The banner a merchant sees when the platform, not the kitchen, is the reason
 * no orders are arriving.
 *
 * Rendered on every portal page rather than only on the dashboard, because the
 * merchant who is staring at an empty kitchen board is exactly the one who has
 * not looked at the dashboard.
 */
export function MerchantStatusNotice({ merchant }: { merchant: OwnedMerchant }) {
  if (merchant.status === 'ACTIVE') {
    return null;
  }

  if (merchant.status === 'PENDING_REVIEW' || merchant.status === 'DRAFT') {
    return (
      <div className="banner banner-warn">
        <div className="grow stack-sm" style={{ gap: 2 }}>
          <strong>尚未上線</strong>
          <div>
            平台正在審核你的申請。審核通過前，你的餐廳不會出現在顧客前台，也不會收到訂單。
            你可以先建立菜單，審核通過後即時生效。
          </div>
        </div>
      </div>
    );
  }

  if (merchant.status === 'SUSPENDED') {
    return (
      <div className="banner banner-danger">
        <div className="grow stack-sm" style={{ gap: 2 }}>
          <strong>已被暫停營業</strong>
          <div>
            平台已暫停你的餐廳，顧客目前無法下單。請聯絡平台了解原因並安排恢復。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="banner banner-danger">
      <div className="grow stack-sm" style={{ gap: 2 }}>
        <strong>已結業</strong>
        <div>此商戶已結業，不能再接單。此狀態不可還原。</div>
      </div>
    </div>
  );
}
