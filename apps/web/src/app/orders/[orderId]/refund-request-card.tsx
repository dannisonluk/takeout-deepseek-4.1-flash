'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Banner, Button, Card, CardHead, Field, Modal, Select, Textarea, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { REFUND_REASON_CODES, REFUND_REASON_LABEL, money } from '@/lib/format';
import type { RefundReasonCode, RefundRequestStatus } from '@/lib/types';

/**
 * 申請退款 — the filing flow, embedded in the order detail page.
 *
 * Three deliberate choices:
 *
 *   1. **It lives on the order, not in a separate wizard.** The complaint is
 *      about a specific order, and the customer arrives here having just looked
 *      at it. A separate form would make them pick the order again from a list
 *      that may contain several, which is a chance to pick wrong.
 *
 *   2. **The amount is optional and pre-filled with the order total.** Omitting
 *      it means "the whole thing, we'll talk" — which is what most people mean.
 *      Pre-filling it makes "I want all of it" the zero-effort path.
 *
 *   3. **The copy says the platform does not handle the money.** Twice: once in
 *      the card, once in the confirm modal. If a customer files a ticket
 *      believing the platform will chase the refund, nobody does, and they wait
 *      forever. That is a worse failure than a slightly repetitive sentence.
 */

/** Statuses on which filing is sensible — mirrors the API's refundable set. */
const FILABLE: string[] = [
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'COMPLETED',
  'REJECTED',
  'REFUNDED',
];

export function RefundRequestCard({
  orderId,
  orderNo,
  orderTotalMinor,
  orderStatus,
  /** The status of an existing open ticket, or null when there is none. */
  openTicketStatus,
  /** Whether this order already has ANY ticket (to link to the list). */
  hasAnyTicket,
}: {
  orderId: string;
  orderNo: string;
  orderTotalMinor: number;
  orderStatus: string;
  openTicketStatus: RefundRequestStatus | null;
  hasAnyTicket: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<RefundReasonCode>('NEVER_RECEIVED');
  const [amount, setAmount] = useState(String(orderTotalMinor / 100));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [filed, setFiled] = useState(false);

  const filable = FILABLE.includes(orderStatus);

  if (!filable) return null;

  // An open ticket already exists — filing again would be a 409. Point at the
  // existing one instead of offering a button that cannot work.
  if (openTicketStatus) {
    return (
      <Card>
        <CardHead title="退款申請" />
        <Banner tone="info" title="這張訂單已有進行中的退款申請">
          你已就這張訂單提出申請，店家正在處理。一張訂單同時只會有一張申請。
        </Banner>
        <div className="row" style={{ marginTop: 'var(--space-3)' }}>
          <Link href="/refunds">
            <Button size="sm">查看我的退款申請</Button>
          </Link>
        </div>
      </Card>
    );
  }

  async function file() {
    setBusy(true);
    setError(null);
    try {
      const major = Number.parseFloat(amount);
      const minor =
        amount.trim() === '' || Number.isNaN(major) ? undefined : Math.round(major * 100);

      await api.refunds.file(orderId, {
        reasonCode,
        ...(minor !== undefined ? { requestedAmountMinor: minor } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });

      toast.push('退款申請已送出，店家會與你聯絡', 'ok');
      setFiled(true);
      setOpen(false);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  if (filed) {
    return (
      <Card>
        <CardHead title="退款申請" />
        <Banner tone="ok" title="申請已送出">
          店家會看到你的申請並與你聯絡。退款金額與方式由你們雙方商議，平台不經手款項。
        </Banner>
        <div className="row" style={{ marginTop: 'var(--space-3)' }}>
          <Link href="/refunds">
            <Button size="sm" variant="primary">
              查看我的退款申請
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHead
          title="退款申請"
          subtitle="送到店家處理，平台只負責轉達"
        />
        <div className="stack-sm">
          <p className="tiny dim">
            如果這張訂單有問題，你可以在這裡提出申請。店家會收到並與你聯絡，
            金額與退款方式由你們雙方直接商議 —— 平台不會經手這筆款項。
          </p>
          <div className="row-wrap">
            <Button variant="primary" onClick={() => setOpen(true)}>
              申請退款
            </Button>
            {hasAnyTicket && (
              <Link href="/refunds">
                <Button variant="ghost">查看過往申請</Button>
              </Link>
            )}
          </div>
        </div>
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`申請退款 · ${orderNo}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              返回
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void file()}>
              送出申請
            </Button>
          </>
        }
      >
        <div className="stack">
          <Banner tone="info" title="這不是自動退款">
            申請會直接送到店家。退款金額與方式由你與店家自行商議，平台不經手款項，
            也不會自動退還任何金額。
          </Banner>

          {error && (
            <Banner tone="danger" title="送出失敗">
              {error instanceof ApiError
                ? (error.validationMessage ?? error.message)
                : '請稍後再試'}
            </Banner>
          )}

          <Field label="原因">
            <Select
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value as RefundReasonCode)}
            >
              {REFUND_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {REFUND_REASON_LABEL[code]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="希望退款金額（HK$，選填）"
            hint={`留空表示「全部，我們再談」。訂單總額 ${money(orderTotalMinor)}，不可多於此數。`}
          >
            <input
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={(orderTotalMinor / 100).toFixed(2)}
            />
          </Field>

          <Field
            label={reasonCode === 'OTHER' ? '說明 *' : '說明（選填）'}
            hint={reasonCode === 'OTHER' ? '選了「其他」就必須說明，否則店家無法回應' : '店家會看到這段文字'}
          >
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="點心送到時已經冷了，叉燒包也是硬的"
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
