'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Card, Empty, ErrorBlock, Loading } from '@/components/ui';
import { useRequireRole } from '@/lib/auth';
import { MerchantProvider, useMerchant } from '@/lib/merchant';

/**
 * Guards the whole `/merchant` subtree.
 *
 * `/merchant-apply` deliberately lives OUTSIDE this tree: an applicant is still
 * a `CUSTOMER` until the API promotes them, so putting the form behind this
 * guard would lock out the only people who need it.
 *
 * The guard is client-side and is not the authorisation boundary — every
 * `/v1/merchant/:merchantId/*` endpoint re-checks the token and the merchant
 * scope server-side. This exists so a customer who types the URL gets sent
 * somewhere useful instead of watching four requests fail.
 */
export default function MerchantLayout({ children }: { children: ReactNode }) {
  const { user, loading, denied } = useRequireRole(['MERCHANT_OWNER', 'MERCHANT_STAFF']);

  if (loading || denied || !user) {
    return <CenteredLoader />;
  }

  return (
    <MerchantProvider>
      <MerchantGate>{children}</MerchantGate>
    </MerchantProvider>
  );
}

function MerchantGate({ children }: { children: ReactNode }) {
  const { loading, error, merchants, reload } = useMerchant();

  if (loading) return <CenteredLoader />;
  if (error) {
    return (
      <div className="page">
        <ErrorBlock error={error} onRetry={() => void reload()} />
      </div>
    );
  }

  /**
   * An owner with no merchant. This is reachable in exactly one way: a staff
   * member was removed from every shop they worked for, or an application was
   * rejected and the record cleaned up. Neither is an error, so it gets an
   * empty state rather than a banner.
   */
  if (merchants.length === 0) {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <Card>
          <Empty
            icon="🏪"
            title="沒有可管理的商戶"
            action={
              <Link href="/merchant-apply">
                <Button variant="primary">申請入駐</Button>
              </Link>
            }
          >
            你的帳號目前不屬於任何商戶。若你剛被移除權限，請聯絡商戶擁有人。
          </Empty>
        </Card>
      </div>
    );
  }

  return <>{children}</>;
}

function CenteredLoader() {
  return (
    <div className="page" style={{ maxWidth: 480 }}>
      <Loading rows={4} />
    </div>
  );
}
