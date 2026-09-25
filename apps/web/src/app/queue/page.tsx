'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CustomerNav } from '@/components/customer-nav';
import { Button, Card, Field, Input } from '@/components/ui';

/**
 * 現場候位 — "find my ticket".
 *
 * WHY THIS PAGE EXISTS
 * --------------------
 * The queue is deliberately anonymous: the guest's identity is their **phone
 * number**, not an account, because requiring a login before somebody can pull
 * a number would lose most of the queue at the first tap. The price of that
 * decision is that there is no server-side list of "my tickets" — the client has
 * to remember which merchant it queued at.
 *
 * So the recovery path is: this page reads the merchant ids this browser has
 * ever taken a number at (a tiny `localStorage` index the take-a-number page
 * maintains) and links straight back to each. If the browser has nothing — a
 * new phone, cleared storage, an incognito tab — it says so plainly and points
 * at the restaurant page, rather than pretending to search.
 *
 * A phone-first page like the queue itself: one column, big taps, no tables.
 */
export default function MyQueuePage() {
  const [entries, setEntries] = useState<{ merchantId: string; phone: string }[] | null>(null);
  const [lookup, setLookup] = useState('');

  useEffect(() => {
    const found: { merchantId: string; phone: string }[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith('takeout.queue.phone.')) continue;
      const merchantId = key.slice('takeout.queue.phone.'.length);
      const phone = window.localStorage.getItem(key);
      if (merchantId && phone) found.push({ merchantId, phone });
    }
    setEntries(found);
  }, []);

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 520 }}>
        <div className="stack">
          <Card>
            <div className="stack" style={{ textAlign: 'center' }}>
              <span style={{ fontSize: 40 }}>🎫</span>
              <span className="strong" style={{ fontSize: 18 }}>
                我的候位號碼
              </span>
              <span className="tiny muted">
                現場候位不需要登入，號碼綁定在你取號時留下的電話。這一頁會列出這個瀏覽器取過號的餐廳。
              </span>
            </div>
          </Card>

          {entries === null ? null : entries.length === 0 ? (
            <Card>
              <div className="stack" style={{ textAlign: 'center' }}>
                <span className="small muted">
                  這個瀏覽器沒有候位紀錄。可能是用另一部手機取號，或瀏覽器資料已被清除。
                </span>
                <Link href="/">
                  <Button variant="primary" size="lg" block>
                    去找餐廳並取號
                  </Button>
                </Link>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="stack-sm">
                <span className="label">這個瀏覽器取過號的餐廳</span>
                {entries.map((entry) => (
                  <Link
                    key={entry.merchantId}
                    href={`/queue/${entry.merchantId}`}
                    className="btn btn-block"
                  >
                    查看號碼（{maskPhone(entry.phone)}）
                  </Link>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <div className="stack-sm">
              <span className="label">直接輸入餐廳編號</span>
              <span className="tiny dim">
                如果餐廳提供了編號（merchant id），可以直接打開它的取號頁。
              </span>
              <Field label="">
                <Input
                  value={lookup}
                  onChange={(event) => setLookup(event.target.value)}
                  placeholder="餐廳編號，例如 2f1c9a3e-…"
                />
              </Field>
              {/* A plain anchor in a disabled-looking state rather than a button
                  that toasts on tap: the guest's goal is a navigation, and a
                  control that says "no" is worse than one that is not there. */}
              {lookup.trim() ? (
                <Link href={`/queue/${lookup.trim()}`}>
                  <Button variant="primary" block>
                    打開這個餐廳的取號頁
                  </Button>
                </Link>
              ) : (
                <span className="tiny dim" style={{ textAlign: 'center' }}>
                  輸入編號後即可開啟。
                </span>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

/** `+85290000001` -> `+852 **** 0001`. Never renders the full number on screen. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return phone;
  return `${phone.slice(0, phone.startsWith('+') ? 4 : 3)} **** ${phone.slice(-4)}`;
}
