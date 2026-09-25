'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import { Badge, Button, Card, CardHead, Loading } from '@/components/ui';
import { useAuth, homeFor } from '@/lib/auth';
import { ROLE_LABEL, phone as formatPhone } from '@/lib/format';

export default function AccountPage() {
  const router = useRouter();
  const { user, loading, logout } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace('/login?next=/account');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <>
        <CustomerNav />
        <div className="page" style={{ maxWidth: 560 }}>
          <Loading rows={3} />
        </div>
      </>
    );
  }

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 560 }}>
        <div className="stack">
          <h1>我的帳號</h1>

          <Card>
            <CardHead
              title={user.displayName}
              subtitle={user.phone ? formatPhone(user.phone) : (user.email ?? '未設定聯絡方式')}
              action={<Badge tone="info">{ROLE_LABEL[user.role]}</Badge>}
            />

            <hr className="divider" style={{ margin: '0 0 var(--space-4)' }} />

            <div className="stack-sm">
              <div className="row-between tiny">
                <span className="dim">使用者編號</span>
                <span className="mono truncate">{user.id}</span>
              </div>
              <div className="row-between tiny">
                <span className="dim">語言</span>
                <span>{user.locale}</span>
              </div>
              <div className="row-between tiny">
                <span className="dim">可管理商戶</span>
                <span>{user.merchantIds.length} 間</span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHead title="快速前往" />
            <div className="row-wrap">
              <Link href="/orders">
                <Button size="sm">我的訂單</Button>
              </Link>
              {user.role === 'CUSTOMER' && (
                <Link href="/merchant-apply">
                  <Button size="sm">申請成為商戶</Button>
                </Link>
              )}
              {(user.role === 'MERCHANT_OWNER' || user.role === 'MERCHANT_STAFF') && (
                <Link href="/merchant">
                  <Button size="sm" variant="primary">
                    商戶後台
                  </Button>
                </Link>
              )}
              {user.role === 'ADMIN' && (
                <Link href="/admin">
                  <Button size="sm" variant="primary">
                    管理後台
                  </Button>
                </Link>
              )}
              <Link href={homeFor(user.role)}>
                <Button size="sm" variant="ghost">
                  返回首頁
                </Button>
              </Link>
            </div>
          </Card>

          <Button variant="danger" onClick={() => void logout()}>
            登出
          </Button>
        </div>
      </div>
    </>
  );
}
