'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CustomerNav } from '@/components/customer-nav';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  ErrorBlock,
  Loading,
  Modal,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import {
  REFUND_REASON_LABEL,
  REFUND_REQUEST_STATUS_LABEL,
  REFUND_REQUEST_STATUS_TONE,
  money,
  relative,
} from '@/lib/format';
import type { CustomerRefundRequest } from '@/lib/types';
import { useAsync } from '@/lib/use-async';

/**
 * 一張退款申請 — one ticket, from the customer's side.
 *
 * Two things this page must get right, and both are about not overclaiming:
 *
 *   1. The platform is not a party. The banner says so, and it says what to do
 *      instead (talk to the shop), because the alternative reading — that the
 *      platform will now chase this for them — leads to a customer who waits
 *      forever for a refund nobody is processing.
 *
 *   2. `RESOLVED_OFFLINE` is a claim by the shop. It is rendered as 「店家表示
 *      已線下處理」, never 「已退款」. If the money did not arrive, the truth is
 *      that the shop says it sent it — which is exactly what the page shows.
 */
export default function RefundDetailPage() {
  const params = useParams<{ refundRequestId: string }>();
  const toast = useToast();

  const ticket = useAsync<CustomerRefundRequest>(
    () => api.refunds.get(params.refundRequestId),
    [params.refundRequestId],
  );

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);

  async function withdraw() {
    setWithdrawing(true);
    try {
      const result = await api.refunds.withdraw(params.refundRequestId);
      toast.push(`申請已${REFUND_REQUEST_STATUS_LABEL[result.toStatus]}`, 'ok');
      setWithdrawOpen(false);
      await ticket.reload();
    } catch (caught) {
      toast.push(
        caught instanceof ApiError ? (caught.validationMessage ?? caught.message) : '撤回失敗',
        'danger',
      );
      // A 409 means the shop moved it under us — reload so the page matches.
      await ticket.reload();
    } finally {
      setWithdrawing(false);
    }
  }

  const data = ticket.data;

  return (
    <>
      <CustomerNav />
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="stack">
          {ticket.loading ? (
            <Loading rows={5} />
          ) : ticket.error ? (
            <ErrorBlock error={ticket.error} onRetry={() => void ticket.reload()} />
          ) : data ? (
            <>
              <Banner tone="info" title="平台只負責轉達">
                這是一個轉達給店家的申請，退款不會經由平台處理。請直接與店家聯絡，
                商議金額與方式。
              </Banner>

              <Card>
                <div className="row-between">
                  <div className="stack-sm" style={{ gap: 2 }}>
                    <span className="tiny dim">申請編號</span>
                    <span className="mono strong truncate" style={{ maxWidth: 260 }}>
                      {data.id}
                    </span>
                  </div>
                  <Badge tone={REFUND_REQUEST_STATUS_TONE[data.status]} dot>
                    {REFUND_REQUEST_STATUS_LABEL[data.status]}
                  </Badge>
                </div>

                <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />

                <div className="stack-sm">
                  <div className="row-between">
                    <span className="dim">原因</span>
                    <span className="strong">{REFUND_REASON_LABEL[data.reasonCode]}</span>
                  </div>
                  <div className="row-between">
                    <span className="dim">要求金額</span>
                    <span className="num">
                      {data.requestedAmountMinor !== null
                        ? money(data.requestedAmountMinor)
                        : '未指定'}
                    </span>
                  </div>
                  <div className="row-between">
                    <span className="dim">訂單總額</span>
                    <span className="num">{money(data.orderTotalMinor)}</span>
                  </div>
                  <div className="row-between">
                    <span className="dim">提出時間</span>
                    <span>{relative(data.createdAt)}</span>
                  </div>
                </div>

                {data.customerNote && (
                  <>
                    <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
                    <div className="stack-sm">
                      <span className="label">你的說明</span>
                      <span className="muted">{data.customerNote}</span>
                    </div>
                  </>
                )}

                {data.merchantNote && (
                  <>
                    <hr className="divider" style={{ margin: 'var(--space-4) 0' }} />
                    <div className="stack-sm">
                      <span className="label">店家回覆</span>
                      <span className="muted">{data.merchantNote}</span>
                    </div>
                  </>
                )}
              </Card>

              {data.status === 'RESOLVED_OFFLINE' && (
                <Card>
                  <CardHead
                    title="店家表示已線下處理"
                    subtitle="以下內容由店家提供，平台未經核實"
                  />
                  <div className="stack-sm">
                    <div className="row-between">
                      <span className="dim">退款金額</span>
                      <span className="num strong">
                        {data.settledAmountMinor !== null
                          ? money(data.settledAmountMinor)
                          : '未提供'}
                      </span>
                    </div>
                    <div className="row-between">
                      <span className="dim">參考編號</span>
                      <span className="mono">
                        {data.settlementReference ?? '未提供'}
                      </span>
                    </div>
                    <div className="row-between">
                      <span className="dim">處理時間</span>
                      <span>{data.resolvedAt ? relative(data.resolvedAt) : '—'}</span>
                    </div>
                  </div>
                  <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
                    如果你沒有收到這筆款項，請直接與店家聯絡。平台沒有參與這筆交易。
                  </p>
                </Card>
              )}

              {data.status === 'DECLINED' && (
                <Banner tone="warn" title="店家拒絕了這項申請">
                  你可以直接與店家聯絡了解原因，或在訂單頁查看其他選項。
                </Banner>
              )}

              {data.status === 'CANCELLED' && (
                <Banner tone="info" title="你已撤回這項申請">
                  如仍有問題，可以再次提出。同一張訂單只會有一張進行中的申請。
                </Banner>
              )}

              <div className="row-wrap">
                <Link href="/refunds">
                  <Button variant="ghost">← 我的退款申請</Button>
                </Link>
                <Link href={`/orders/${data.orderId}`}>
                  <Button variant="ghost">查看訂單</Button>
                </Link>
                {data.allowedNextTransitions.includes('CANCELLED') && (
                  <Button variant="danger" onClick={() => setWithdrawOpen(true)}>
                    撤回申請
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <Modal
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        title="撤回退款申請"
        footer={
          <>
            <Button variant="ghost" onClick={() => setWithdrawOpen(false)}>
              返回
            </Button>
            <Button variant="danger" loading={withdrawing} onClick={() => void withdraw()}>
              確認撤回
            </Button>
          </>
        }
      >
        <p className="muted">
          撤回後這張申請會結束，店家不會再看到它。如果問題仍在，你可以重新提出。
        </p>
      </Modal>
    </>
  );
}
