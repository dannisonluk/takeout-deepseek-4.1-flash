'use client';

import { useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  ErrorBlock,
  Field,
  Loading,
  Modal,
  Tabs,
  Textarea,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import {
  REFUND_ACTION_SPEC,
  REFUND_REASON_LABEL,
  REFUND_REQUEST_SHORT_LABEL,
  REFUND_REQUEST_STATUS_LABEL,
  REFUND_REQUEST_STATUS_TONE,
  money,
  relative,
} from '@/lib/format';
import { useMerchant } from '@/lib/merchant';
import type { MerchantRefundRequest, RefundRequestStatus } from '@/lib/types';
import { useAsync } from '@/lib/use-async';

type Tab = 'OPEN' | 'IN_DISCUSSION' | 'ALL';

/**
 * 退款申請 — the shop's refund queue.
 *
 * The design rule is the same one the reservation book follows, and it matters
 * more here: **the buttons are a projection, not a mirror.** This file contains
 * no lifecycle table. Every action button comes from the server's
 * `allowedNextTransitions`, which means a rule change ships without a frontend
 * deploy and a button can never appear for a move the API would refuse.
 *
 * Two things specific to refunds:
 *
 *   1. **「已線下處理」 is a claim, and the copy says so.** This screen is where
 *      the shop records what it handed over. It is deliberately not called
 *      「退款」: the platform did not process anything, and a screen that said
 *      "refunded" would tell the shop's own staff the money had moved when it
 *      had not. `RESOLVED_OFFLINE` REQUIRES an amount or a reference, so a shop
 *      cannot close a ticket while saying nothing about what it did.
 *
 *   2. **The queue opens on ACTIVE, not ALL.** A work queue should not show a
 *      year of resolved tickets on the morning someone opens it.
 */

/** How a tab maps to the API's status filter. */
const TAB_STATUS: Record<Tab, RefundRequestStatus | 'ACTIVE' | 'ALL'> = {
  OPEN: 'OPEN',
  IN_DISCUSSION: 'IN_DISCUSSION',
  ALL: 'ALL',
};

export default function MerchantRefundsPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const [tab, setTab] = useState<Tab>('OPEN');
  const [busyId, setBusyId] = useState<string | null>(null);

  /** The move awaiting its details in the modal. */
  const [acting, setActing] = useState<{
    ticket: MerchantRefundRequest;
    target: RefundRequestStatus;
  } | null>(null);
  const [merchantNote, setMerchantNote] = useState('');
  const [settledAmount, setSettledAmount] = useState('');
  const [reference, setReference] = useState('');

  const state = useAsync<{
    data: MerchantRefundRequest[];
    total: number;
    counts: Record<RefundRequestStatus, number>;
  }>(
    () =>
      merchantId
        ? api.refunds.queue(merchantId, { status: TAB_STATUS[tab], limit: 100 })
        : Promise.resolve({ data: [], total: 0, counts: {} as Record<RefundRequestStatus, number> }),
    [merchantId, tab],
  );

  if (!merchant || !merchantId) return null;

  const rows = state.data?.data ?? [];
  const counts = state.data?.counts;
  const openCount = counts?.OPEN ?? 0;

  function openModal(ticket: MerchantRefundRequest, target: RefundRequestStatus) {
    setActing({ ticket, target });
    setMerchantNote('');
    setSettledAmount(
      ticket.requestedAmountMinor !== null ? (ticket.requestedAmountMinor / 100).toFixed(2) : '',
    );
    setReference('');
  }

  async function run() {
    if (!acting) return;
    const { ticket, target } = acting;
    setBusyId(ticket.id);
    try {
      const major = Number.parseFloat(settledAmount);
      const minor =
        settledAmount.trim() === '' || Number.isNaN(major) ? undefined : Math.round(major * 100);

      await api.refunds.merchantAct(merchantId!, ticket.id, {
        to: target,
        ...(merchantNote.trim() ? { merchantNote: merchantNote.trim() } : {}),
        ...(minor !== undefined ? { settledAmountMinor: minor } : {}),
        ...(reference.trim() ? { settlementReference: reference.trim() } : {}),
      });

      toast.push(
        `${ticket.orderNo} ${REFUND_ACTION_SPEC[target].label}`,
        target === 'DECLINED' ? 'warn' : 'ok',
      );
      setActing(null);
      await state.reload();
    } catch (caught) {
      // A 409 or 422 means the ticket moved, or the move needed details we did
      // not supply. Reload so the buttons match the truth before a retry.
      toast.push(
        caught instanceof ApiError ? (caught.validationMessage ?? caught.message) : '操作失敗',
        'danger',
      );
      await state.reload();
    } finally {
      setBusyId(null);
    }
  }

  const needsSettlementDetails = acting?.target === 'RESOLVED_OFFLINE';
  const settlementSupplied = settledAmount.trim() !== '' || reference.trim() !== '';

  return (
    <MerchantShell
      title="退款申請"
      subtitle={`${merchant.name} · 顧客提出，你與顧客自行商議`}
      counts={{ openRefunds: openCount }}
      actions={
        <Button size="sm" onClick={() => void state.reload()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        <Banner tone="info" title="退款不經平台">
          顧客在這裡提出的申請只是一個轉達。平台不經手款項、不會代你退款。
          請直接與顧客聯絡，商議好再回來把這張單標記為已處理。
        </Banner>

        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'OPEN', label: '待處理', count: counts?.OPEN },
            { value: 'IN_DISCUSSION', label: '商議中', count: counts?.IN_DISCUSSION },
            { value: 'ALL', label: '全部', count: state.data?.total },
          ]}
        />

        {state.error ? (
          <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
        ) : state.loading && rows.length === 0 ? (
          <Loading rows={4} />
        ) : rows.length === 0 ? (
          <Card>
            <Empty
              icon="✅"
              title={tab === 'OPEN' ? '沒有待處理的退款申請' : '這個分類沒有申請'}
            >
              {tab === 'OPEN'
                ? '顧客提出的退款申請會出現在這裡。'
                : '切換上方分類查看其他申請。'}
            </Empty>
          </Card>
        ) : (
          <div className="grid-2">
            {rows.map((ticket) => (
              <RefundQueueCard
                key={ticket.id}
                ticket={ticket}
                busy={busyId === ticket.id}
                onAct={(target) => openModal(ticket, target)}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={acting !== null}
        onClose={() => setActing(null)}
        title={
          acting
            ? `${REFUND_ACTION_SPEC[acting.target].label} · ${acting.ticket.orderNo}`
            : ''
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setActing(null)}>
              返回
            </Button>
            <Button
              variant={REFUND_ACTION_SPEC[acting?.target ?? 'IN_DISCUSSION'].variant}
              // RESOLVED_OFFLINE must say what was handed over. The API refuses
              // it too (422), but the shop should not get as far as submitting
              // an empty claim.
              disabled={needsSettlementDetails && !settlementSupplied}
              loading={busyId === acting?.ticket.id}
              onClick={() => void run()}
            >
              確定{REFUND_ACTION_SPEC[acting?.target ?? 'IN_DISCUSSION'].label}
            </Button>
          </>
        }
      >
        {acting && (
          <div className="stack">
            <ActingBanner target={acting.target} />

            {needsSettlementDetails && (
              <>
                <Field
                  label="已退還金額（HK$）"
                  hint="實際交給顧客的金額。金額與參考至少填一項。"
                >
                  <input
                    className="input"
                    inputMode="decimal"
                    value={settledAmount}
                    onChange={(event) => setSettledAmount(event.target.value)}
                    placeholder="38.00"
                  />
                </Field>

                <Field
                  label="參考編號（選填）"
                  hint="現金、轉帳、優惠券 —— 任何顧客可以引述的憑據"
                >
                  <input
                    className="input"
                    value={reference}
                    maxLength={120}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="CASH-2026-0001"
                  />
                </Field>
              </>
            )}

            <Field
              label={acting.target === 'DECLINED' ? '拒絕原因' : '給顧客的訊息（選填）'}
              hint="顧客會看到這段文字"
            >
              <Textarea
                value={merchantNote}
                maxLength={1000}
                rows={2}
                onChange={(event) => setMerchantNote(event.target.value)}
              />
            </Field>
          </div>
        )}
      </Modal>
    </MerchantShell>
  );
}

/** The warning appropriate to the move about to be taken. */
function ActingBanner({ target }: { target: RefundRequestStatus }) {
  switch (target) {
    case 'RESOLVED_OFFLINE':
      return (
        <Banner tone="info" title="這是記錄，不是退款">
          請在線下把款項交給顧客，然後在這裡記錄你交了甚麼。平台不會處理這筆款項，
          這裡的數字只是你的記錄，顧客會看到你填寫的內容。
        </Banner>
      );
    case 'DECLINED':
      return (
        <Banner tone="warn" title="拒絕後這張申請即結束">
          顧客會看到你的說明。如果只是想再討論，請改用「開始商議」。
          這張單結束後，顧客仍可就同一張訂單重新提出。
        </Banner>
      );
    case 'IN_DISCUSSION':
      return (
        <Banner tone="info" title="標記為商議中">
          顧客會收到通知，知道店家已看到申請。之後請直接與顧客聯絡商議金額與方式。
        </Banner>
      );
    default:
      return null;
  }
}

function RefundQueueCard({
  ticket,
  busy,
  onAct,
}: {
  ticket: MerchantRefundRequest;
  busy: boolean;
  onAct: (target: RefundRequestStatus) => void;
}) {
  // THE whole point: the buttons are whatever the server said is legal next.
  const targets = ticket.allowedNextTransitions;

  return (
    <Card>
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack-sm" style={{ gap: 2 }}>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <strong>{REFUND_REASON_LABEL[ticket.reasonCode]}</strong>
            <Badge tone={REFUND_REQUEST_STATUS_TONE[ticket.status]}>
              {REFUND_REQUEST_SHORT_LABEL[ticket.status]}
            </Badge>
          </div>
          <span className="tiny dim mono">{ticket.orderNo}</span>
        </div>

        <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
          <span className="tiny dim">要求</span>
          <span className="num strong">
            {ticket.requestedAmountMinor !== null ? money(ticket.requestedAmountMinor) : '全額'}
          </span>
          <span className="tiny dim">訂單 {money(ticket.orderTotalMinor)}</span>
        </div>
      </div>

      <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

      <div className="stack-sm">
        <div className="row-between">
          <span className="strong">{ticket.customerName}</span>
          <span className="tiny dim">{relative(ticket.createdAt)}</span>
        </div>

        {ticket.customerNote && (
          <div
            className="tiny"
            style={{
              padding: 'var(--space-2) var(--space-3)',
              background: 'var(--surface-2)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <span className="dim">顧客說明：</span>
            {ticket.customerNote}
          </div>
        )}

        {ticket.merchantNote && (
          <div className="tiny dim">
            <span>你的回覆：</span>
            {ticket.merchantNote}
          </div>
        )}

        {ticket.status === 'RESOLVED_OFFLINE' && (
          <div className="tiny dim">
            已記錄線下處理
            {ticket.settledAmountMinor !== null && (
              <>
                {' · '}
                <span className="num">{money(ticket.settledAmountMinor)}</span>
              </>
            )}
            {ticket.settlementReference && (
              <>
                {' · '}
                <span className="mono">{ticket.settlementReference}</span>
              </>
            )}
          </div>
        )}

        <div className="row-between tiny dim">
          <span>訂單狀態</span>
          <span>{ticket.orderStatus}</span>
        </div>
      </div>

      <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

      <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
        {targets.length === 0 ? (
          <span className="tiny dim">沒有可執行的動作</span>
        ) : (
          targets.map((target) => {
            const spec = REFUND_ACTION_SPEC[target];
            return (
              <Button
                key={target}
                variant={spec.variant}
                size="sm"
                loading={busy}
                onClick={() => onAct(target)}
              >
                {spec.label}
              </Button>
            );
          })
        )}
      </div>
    </Card>
  );
}
