'use client';

import { Suspense, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'next/navigation';
import { AdminShell, Pager } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Empty,
  ErrorBlock,
  Field,
  Input,
  Loading,
  Modal,
  Segmented,
  Select,
  Stat,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync, useDebounced } from '@/lib/use-async';
import {
  OUTBOX_STATUS_LABEL,
  OUTBOX_STATUS_TONE,
  dateTime,
  duration,
  relative,
} from '@/lib/format';
import type { AdminOutboxEvent, AuditLogEntry, OutboxStatus } from '@/lib/types';

const LIMIT = 25;

const OUTBOX_STATUSES: OutboxStatus[] = ['PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER'];

/** A pending event older than this is the symptom of a relay that has stopped. */
const STUCK_AFTER_SECONDS = 300;

export default function AdminOpsPage() {
  return (
    <Suspense fallback={<div className="page"><Loading rows={5} /></div>}>
      <OpsView />
    </Suspense>
  );
}

function OpsView() {
  const search = useSearchParams();
  const [tab, setTab] = useState<'outbox' | 'audit'>('outbox');
  const [initialStatus] = useState(search.get('status') ?? '');

  return (
    <AdminShell
      title="系統與稽核"
      subtitle="事件投遞與管理操作記錄"
      actions={
        <Segmented<'outbox' | 'audit'>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'outbox', label: '事件投遞' },
            { value: 'audit', label: '稽核記錄' },
          ]}
        />
      }
    >
      {tab === 'outbox' ? <OutboxView initialStatus={initialStatus} /> : <AuditView />}
    </AdminShell>
  );
}

/* ==========================================================================
   Outbox
   ========================================================================== */

function OutboxView({ initialStatus }: { initialStatus: string }) {
  const toast = useToast();
  const [status, setStatus] = useState(initialStatus);
  const [eventType, setEventType] = useState('');
  const [aggregateId, setAggregateId] = useState('');
  const [offset, setOffset] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const debouncedAggregate = useDebounced(aggregateId, 350);
  const debouncedType = useDebounced(eventType, 350);

  const stats = useAsync(() => api.admin.ops.outboxStats(), []);
  const list = useAsync(
    () =>
      api.admin.ops.outbox({
        ...(status ? { status } : {}),
        ...(debouncedType ? { eventType: debouncedType } : {}),
        ...(debouncedAggregate ? { aggregateId: debouncedAggregate } : {}),
        limit: LIMIT,
        offset,
      }),
    [status, debouncedType, debouncedAggregate, offset],
  );

  const summary = stats.data;
  const stuck =
    summary?.oldestPendingAgeSeconds !== null &&
    summary?.oldestPendingAgeSeconds !== undefined &&
    summary.oldestPendingAgeSeconds > STUCK_AFTER_SECONDS;

  async function act(event: AdminOutboxEvent, kind: 'retry' | 'dead-letter') {
    setBusyId(event.id);
    try {
      if (kind === 'retry') {
        await api.admin.ops.retryOutbox(event.id);
        toast.push(`${event.eventType} 已重新排入待發送`, 'ok');
      } else {
        await api.admin.ops.deadLetter(event.id);
        toast.push(`${event.eventType} 已隔離`, 'warn');
      }
      await Promise.all([list.reload(), stats.reload()]);
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="stack">
      {stuck && (
        <Banner tone="danger" title={`待發送事件已積壓 ${duration(summary?.oldestPendingAgeSeconds)}`}>
          正常的 relay 會在數秒內消費掉 outbox。積壓時間持續上升，代表背景程序沒有在執行，
          或它正在反覆失敗。這會令入帳分錄、通知與即時推送全部停在半途。
        </Banner>
      )}

      <div className="grid-4">
        <Stat label="待發送" value={summary?.byStatus.PENDING ?? 0} tone={stuck ? 'warn' : undefined} />
        <Stat label="已發送" value={summary?.byStatus.PUBLISHED ?? 0} tone="ok" />
        <Stat
          label="發送失敗"
          value={summary?.byStatus.FAILED ?? 0}
          tone={(summary?.byStatus.FAILED ?? 0) > 0 ? 'warn' : undefined}
        />
        <Stat
          label="已隔離"
          value={summary?.deadLetterCount ?? 0}
          tone={(summary?.deadLetterCount ?? 0) > 0 ? 'danger' : undefined}
          hint={summary?.oldestPendingAt ? `最舊待發送 ${relative(summary.oldestPendingAt)}` : undefined}
        />
      </div>

      <Card flush>
        <div style={{ padding: 'var(--space-4) var(--space-4) 0' }}>
          <CardHead
            title="事件"
            subtitle="交易性 outbox — 事件與業務資料在同一個交易內寫入"
          />
          <div className="grid-3" style={{ marginBottom: 'var(--space-4)' }}>
            <Field label="狀態">
              <Select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部</option>
                {OUTBOX_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {OUTBOX_STATUS_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="事件類型">
              <Input
                value={eventType}
                onChange={(event) => {
                  setEventType(event.target.value);
                  setOffset(0);
                }}
                placeholder="order.placed"
              />
            </Field>
            <Field label="聚合根 ID">
              <Input
                value={aggregateId}
                onChange={(event) => {
                  setAggregateId(event.target.value);
                  setOffset(0);
                }}
                placeholder="訂單或商戶 UUID"
              />
            </Field>
          </div>
        </div>

        {list.error ? (
          <ErrorBlock error={list.error} onRetry={() => void list.reload()} />
        ) : list.loading && !list.data ? (
          <Loading rows={6} />
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <Empty icon="📨" title="沒有符合條件的事件">
            這通常代表 outbox 是乾淨的 —— 待發送與失敗都是 0 時，系統沒有積壓。
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>事件</th>
                    <th>聚合根</th>
                    <th>狀態</th>
                    <th className="right">嘗試</th>
                    <th>可發送時間</th>
                    <th>最後錯誤</th>
                    <th className="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.data.map((event) => (
                    <tr key={event.id}>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span className="mono strong">{event.eventType}</span>
                          <span className="tiny dim">
                            v{event.version} · {dateTime(event.createdAt)}
                          </span>
                        </div>
                      </td>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span className="tiny">{event.aggregateType}</span>
                          <span className="tiny dim mono">{event.aggregateId.slice(0, 8)}…</span>
                        </div>
                      </td>
                      <td>
                        <Badge tone={OUTBOX_STATUS_TONE[event.status]}>
                          {OUTBOX_STATUS_LABEL[event.status]}
                        </Badge>
                      </td>
                      <td className="right num">{event.attempts}</td>
                      <td className="tiny dim nowrap">{dateTime(event.availableAt)}</td>
                      <td className="tiny" style={{ maxWidth: 220 }}>
                        {event.lastError ? (
                          <span className="truncate" style={{ color: 'var(--danger)' }} title={event.lastError}>
                            {event.lastError}
                          </span>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          {event.status !== 'PUBLISHED' && (
                            <>
                              <Button
                                size="sm"
                                loading={busyId === event.id}
                                onClick={() => void act(event, 'retry')}
                              >
                                重試
                              </Button>
                              {event.status !== 'DEAD_LETTER' && (
                                <Button
                                  size="sm"
                                  variant="danger"
                                  disabled={busyId === event.id}
                                  onClick={() => void act(event, 'dead-letter')}
                                >
                                  隔離
                                </Button>
                              )}
                            </>
                          )}
                          {event.status === 'PUBLISHED' && (
                            <span className="tiny dim">{relative(event.publishedAt)}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={list.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>
    </div>
  );
}

/* ==========================================================================
   Audit
   ========================================================================== */

function AuditView() {
  const [targetType, setTargetType] = useState('');
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<AuditLogEntry | null>(null);

  const debouncedTarget = useDebounced(targetType, 350);
  const debouncedAction = useDebounced(action, 350);
  const debouncedActor = useDebounced(actorId, 350);

  const list = useAsync(
    () =>
      api.admin.ops.audit({
        ...(debouncedTarget ? { targetType: debouncedTarget } : {}),
        ...(debouncedAction ? { action: debouncedAction } : {}),
        ...(debouncedActor ? { actorId: debouncedActor } : {}),
        limit: LIMIT,
        offset,
      }),
    [debouncedTarget, debouncedAction, debouncedActor, offset],
  );

  return (
    <div className="stack">
      <Banner tone="info" title="稽核記錄是唯讀的">
        每一筆都與觸發它的業務交易在同一個資料庫交易內寫入，因此不會出現「操作成功但沒有記錄」的情況。
        記錄包含操作前後的值。
      </Banner>

      <Card tight>
        <div className="grid-3">
          <Field label="對象類型">
            <Input
              value={targetType}
              onChange={(event) => {
                setTargetType(event.target.value);
                setOffset(0);
              }}
              placeholder="merchant / order / user / platform_config"
            />
          </Field>
          <Field label="操作">
            <Input
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setOffset(0);
              }}
              placeholder="merchant.approve"
            />
          </Field>
          <Field label="操作者 ID">
            <Input
              value={actorId}
              onChange={(event) => {
                setActorId(event.target.value);
                setOffset(0);
              }}
              placeholder="使用者 UUID"
            />
          </Field>
        </div>
      </Card>

      <Card flush>
        {list.error ? (
          <ErrorBlock error={list.error} onRetry={() => void list.reload()} />
        ) : list.loading && !list.data ? (
          <Loading rows={6} />
        ) : (list.data?.data.length ?? 0) === 0 ? (
          <Empty icon="📝" title="沒有符合條件的稽核記錄">
            進行管理操作後，記錄會出現在這裡。
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>時間</th>
                    <th>操作者</th>
                    <th>操作</th>
                    <th>對象</th>
                    <th>來源 IP</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data?.data.map((entry) => (
                    <tr key={entry.id} data-clickable="true" onClick={() => setOpen(entry)}>
                      <td className="tiny num nowrap">{dateTime(entry.createdAt)}</td>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span>{entry.actorName ?? <span className="dim">系統</span>}</span>
                          <span className="tiny dim">{entry.actorRole ?? '—'}</span>
                        </div>
                      </td>
                      <td className="mono">{entry.action}</td>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span className="tiny">{entry.targetType}</span>
                          <span className="tiny dim mono">
                            {entry.targetId ? `${entry.targetId.slice(0, 8)}…` : '—'}
                          </span>
                        </div>
                      </td>
                      <td className="tiny dim mono">{entry.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager total={list.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
          </>
        )}
      </Card>

      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        wide
        title={open?.action ?? ''}
        footer={
          <Button variant="ghost" onClick={() => setOpen(null)}>
            關閉
          </Button>
        }
      >
        {open && (
          <div className="stack">
            <div className="row-wrap">
              <Badge tone="neutral">{open.targetType}</Badge>
              <span className="tiny dim mono">{open.targetId ?? '—'}</span>
              <span className="tiny dim">{dateTime(open.createdAt)}</span>
            </div>

            <div className="grid-2">
              <div className="stack-sm">
                <span className="tiny dim">變更前</span>
                <pre className="mono" style={diffStyle}>
                  {formatJson(open.before)}
                </pre>
              </div>
              <div className="stack-sm">
                <span className="tiny dim">變更後</span>
                <pre className="mono" style={diffStyle}>
                  {formatJson(open.after)}
                </pre>
              </div>
            </div>

            {open.ip && <span className="tiny dim">來源 IP：{open.ip}</span>}
          </div>
        )}
      </Modal>
    </div>
  );
}

const diffStyle: CSSProperties = {
  margin: 0,
  padding: 'var(--space-3)',
  background: 'var(--surface-2)',
  borderRadius: 'var(--radius-sm)',
  maxHeight: 320,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  fontSize: 11.5,
};

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
