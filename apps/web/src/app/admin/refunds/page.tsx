'use client';

import { useState } from 'react';
import { AdminShell } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
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
  REFUND_REQUEST_STATUS_TONE,
  money,
  relative,
} from '@/lib/format';
import type { MerchantRefundRequest, RefundRequestStatus } from '@/lib/types';
import { useAsync } from '@/lib/use-async';

type Tab = 'OPEN' | 'IN_DISCUSSION' | 'ALL';

const TAB_STATUS: Record<Tab, RefundRequestStatus | 'ACTIVE' | 'ALL'> = {
  OPEN: 'OPEN',
  IN_DISCUSSION: 'IN_DISCUSSION',
  ALL: 'ALL',
};

/**
 * 退款申請 — the platform's console for refund tickets.
 *
 * Read-only by default and by intent. The platform is not a party to this
 * conversation, so its console exists for one reason: to let support answer
 * "what happened with order X" without logging into a shop's account.
 *
 * The one write it offers is the unblock transition — a shop that has closed,
 * gone silent, or is plainly not going to answer. It goes through the SAME
 * state machine and the SAME use case as the shop's endpoint, so an admin
 * cannot reach a state a shop could not, and the audit trail records `ADMIN`
 * as the actor rather than pretending the shop did it.
 *
 * The banner says "平台不經手款項" for the same reason every other screen in
 * this feature does: the failure mode is somebody believing the platform will
 * chase the money, and then nobody does.
 */
export default function AdminRefundsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('OPEN');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [acting, setActing] = useState<{
    ticket: MerchantRefundRequest;
    target: RefundRequestStatus;
  } | null>(null);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');

  const state = useAsync(
    () => api.refunds.adminList({ status: TAB_STATUS[tab], limit: 100 }),
    [tab],
  );

  const rows = state.data?.data ?? [];

  async function run() {
    if (!acting) return;
    const { ticket, target } = acting;
    setBusyId(ticket.id);
    try {
      const major = Number.parseFloat(amount);
      const minor = amount.trim() === '' || Number.isNaN(major) ? undefined : Math.round(major * 100);

      await api.refunds.adminAct(ticket.id, {
        to: target,
        ...(note.trim() ? { merchantNote: note.trim() } : {}),
        ...(minor !== undefined ? { settledAmountMinor: minor } : {}),
        ...(reference.trim() ? { settlementReference: reference.trim() } : {}),
      });

      toast.push(`申請已${REFUND_ACTION_SPEC[target].label}`, target === 'DECLINED' ? 'warn' : 'ok');
      setActing(null);
      await state.reload();
    } catch (caught) {
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
  const settlementSupplied = amount.trim() !== '' || reference.trim() !== '';

  return (
    <AdminShell title="退款申請" subtitle="顧客與店家之間的申請，平台只讀與必要時介入">
      <div className="stack">
        <Banner tone="info" title="平台不經手款項">
          退款由顧客與店家自行商議。這裡的介入功能只為處理店家已停業、失聯等情況，
          以同一套狀態機運作，紀錄會標明是平台操作。
        </Banner>

        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'OPEN', label: '待處理' },
            { value: 'IN_DISCUSSION', label: '商議中' },
            { value: 'ALL', label: '全部' },
          ]}
        />

        {state.error ? (
          <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
        ) : state.loading && rows.length === 0 ? (
          <Loading rows={4} />
        ) : rows.length === 0 ? (
          <Card>
            <Empty icon="📭" title="這個分類沒有退款申請">
              切換上方分類查看其他申請。
            </Empty>
          </Card>
        ) : (
          <div className="grid-2">
            {rows.map((ticket) => (
              <Card key={ticket.id}>
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
                  <span className="tiny dim">{relative(ticket.createdAt)}</span>
                </div>

                <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

                <div className="stack-sm">
                  <div className="row-between">
                    <span className="strong">{ticket.customerName}</span>
                    <span className="num">
                      {ticket.requestedAmountMinor !== null
                        ? money(ticket.requestedAmountMinor)
                        : '全額'}
                    </span>
                  </div>
                  <div className="row-between tiny dim">
                    <span>商戶</span>
                    <span className="mono truncate" style={{ maxWidth: 200 }}>
                      {ticket.merchantId}
                    </span>
                  </div>
                  <div className="row-between tiny dim">
                    <span>訂單狀態</span>
                    <span>{ticket.orderStatus}</span>
                  </div>
                  {ticket.customerNote && (
                    <div className="tiny dim">顧客：{ticket.customerNote}</div>
                  )}
                  {ticket.merchantNote && <div className="tiny dim">店家：{ticket.merchantNote}</div>}
                </div>

                <hr className="divider" style={{ margin: 'var(--space-3) 0' }} />

                <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
                  {ticket.allowedNextTransitions.length === 0 ? (
                    <span className="tiny dim">沒有可執行的動作</span>
                  ) : (
                    ticket.allowedNextTransitions.map((target) => (
                      <Button
                        key={target}
                        variant={REFUND_ACTION_SPEC[target].variant}
                        size="sm"
                        loading={busyId === ticket.id}
                        onClick={() => {
                          setActing({ ticket, target });
                          setNote('');
                          setReference('');
                          setAmount('');
                        }}
                      >
                        {REFUND_ACTION_SPEC[target].label}
                      </Button>
                    ))
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Modal
        open={acting !== null}
        onClose={() => setActing(null)}
        title={
          acting ? `平台介入 · ${REFUND_ACTION_SPEC[acting.target].label}` : ''
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setActing(null)}>
              返回
            </Button>
            <Button
              variant={REFUND_ACTION_SPEC[acting?.target ?? 'IN_DISCUSSION'].variant}
              disabled={needsSettlementDetails && !settlementSupplied}
              loading={busyId === acting?.ticket.id}
              onClick={() => void run()}
            >
              確定
            </Button>
          </>
        }
      >
        {acting && (
          <div className="stack">
            <Banner tone="warn" title="這是平台代為操作">
              紀錄會標明由平台管理員操作。只有在店家無法自行處理時才應使用。
            </Banner>

            {needsSettlementDetails && (
              <>
                <Field label="已退還金額（HK$）" hint="金額與參考至少填一項">
                  <input
                    className="input"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </Field>
                <Field label="參考編號（選填）">
                  <input
                    className="input"
                    value={reference}
                    maxLength={120}
                    onChange={(event) => setReference(event.target.value)}
                  />
                </Field>
              </>
            )}

            <Field label="說明" hint="顧客會看到這段文字">
              <Textarea
                value={note}
                maxLength={1000}
                rows={2}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          </div>
        )}
      </Modal>
    </AdminShell>
  );
}
