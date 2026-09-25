'use client';

import { useState } from 'react';
import { AdminShell } from '@/components/admin-shell';
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
  Select,
  Stat,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/use-async';
import { basisPoints, dateTime, money, moneyBare } from '@/lib/format';
import type { PlatformConfigEntry, PricingPolicy } from '@/lib/types';

export default function AdminConfigPage() {
  const toast = useToast();
  const entries = useAsync(() => api.admin.config.list(), []);
  const pricing = useAsync(() => api.admin.config.pricing(), []);
  const [editing, setEditing] = useState<PlatformConfigEntry | null>(null);
  const [confirmReset, setConfirmReset] = useState<PlatformConfigEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadAll = async () => {
    await Promise.all([entries.reload(), pricing.reload()]);
  };

  return (
    <AdminShell
      title="平台設定"
      subtitle="所有可調參數的單一來源"
      actions={
        <Button size="sm" onClick={() => void reloadAll()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <Banner tone="warn" title="這裡的改動會即時影響新訂單">
          已存在的訂單使用下單當時的計費快照，不會被改動。
          中介費的調整會直接改變平台收入與商戶入帳，請確認後再儲存。
        </Banner>

        {/* ---- the policy actually in force ------------------------------- */}
        <Card>
          <CardHead
            title="目前生效的計費政策"
            subtitle="由計費引擎實際載入的值，非資料庫欄位"
            action={
              pricing.data ? (
                <Badge tone={pricing.data.source === 'platform_config' ? 'accent' : 'neutral'}>
                  {pricing.data.source === 'platform_config'
                    ? '來自平台設定'
                    : pricing.data.source === 'environment'
                      ? '來自環境變數'
                      : '程式預設值'}
                </Badge>
              ) : undefined
            }
          />

          {pricing.error ? (
            <ErrorBlock error={pricing.error} onRetry={() => void pricing.reload()} />
          ) : !pricing.data ? (
            <Loading rows={3} />
          ) : (
            <PolicyView policy={pricing.data} />
          )}
        </Card>

        {/* ---- the editable keys ------------------------------------------ */}
        <Card flush>
          <div style={{ padding: 'var(--space-4)' }}>
            <CardHead
              title="可調整參數"
              subtitle="三層解析：平台設定（資料庫）→ 環境變數 → 程式預設值"
            />
          </div>

          {entries.error ? (
            <ErrorBlock error={entries.error} onRetry={() => void entries.reload()} />
          ) : entries.loading && !entries.data ? (
            <Loading rows={6} />
          ) : (entries.data?.length ?? 0) === 0 ? (
            <Empty icon="⚙" title="沒有可調整的參數" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>參數</th>
                    <th>目前值</th>
                    <th>預設值</th>
                    <th>來源</th>
                    <th>說明</th>
                    <th className="right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.data?.map((entry) => (
                    <tr key={entry.key}>
                      <td>
                        <div className="stack-sm" style={{ gap: 1 }}>
                          <span className="mono strong">{entry.key}</span>
                          {entry.namespace === 'pricing' && <Badge tone="accent">計費</Badge>}
                          {entry.namespace === 'cancellation' && <Badge tone="warn">取消政策</Badge>}
                        </div>
                      </td>
                      <td className="num strong">{renderValue(entry, entry.effectiveValue)}</td>
                      <td className="num muted">{renderValue(entry, entry.fallback)}</td>
                      <td>
                        {entry.hasOverride ? (
                          <div className="stack-sm" style={{ gap: 1 }}>
                            <Badge tone="accent">平台設定</Badge>
                            <span className="tiny dim">
                              {entry.updatedByName ?? entry.updatedById ?? '—'} ·{' '}
                              {dateTime(entry.updatedAt)}
                            </span>
                          </div>
                        ) : (
                          <span className="tiny dim">環境／預設</span>
                        )}
                      </td>
                      <td className="tiny muted" style={{ maxWidth: 320 }}>
                        {entry.description}
                      </td>
                      <td className="right">
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                          <Button size="sm" onClick={() => setEditing(entry)}>
                            調整
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!entry.hasOverride}
                            onClick={() => setConfirmReset(entry)}
                          >
                            還原
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      {editing && (
        <ConfigEditor
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            toast.push(message, 'ok');
            await reloadAll();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}

      <Modal
        open={confirmReset !== null}
        onClose={() => setConfirmReset(null)}
        title="還原為預設值"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void (async () => {
                  const target = confirmReset;
                  if (!target) return;
                  setBusy(true);
                  try {
                    await api.admin.config.remove(target.key);
                    toast.push(`${target.key} 已還原為預設值`, 'ok');
                    setConfirmReset(null);
                    await reloadAll();
                  } catch (caught) {
                    toast.push((caught as Error).message, 'danger');
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              確認還原
            </Button>
          </>
        }
      >
        <p>
          會刪除 <span className="mono">{confirmReset?.key}</span> 的平台設定覆寫，
          之後的值改由環境變數或程式預設值決定（目前預設為{' '}
          <strong>{confirmReset ? renderValue(confirmReset, confirmReset.fallback) : ''}</strong>）。
        </p>
      </Modal>
    </AdminShell>
  );
}

function PolicyView({ policy }: { policy: PricingPolicy }) {
  return (
    <div className="stack">
      <div className="grid-4">
        <Stat
          label="每件主餐中介費"
          value={money(policy.platformFee.feePerMainItemMinor)}
          tone="accent"
          hint={policy.platformFee.countAddOnItems ? '含加購品' : '只計主餐'}
        />
        <Stat
          label="支付手續費"
          value={`${basisPoints(policy.paymentFee.rateBps)} + ${moneyBare(
            policy.paymentFee.fixedMinor,
          )}`}
          hint={`計費於 ${policy.paymentFee.chargeOn}`}
        />
        <Stat label="顧客服務費" value={money(policy.customerServiceFeeMinor)} />
        <Stat label="最低入帳金額" value={money(policy.minimumPayoutMinor)} />
      </div>

      <div
        className="mono"
        style={{
          padding: 'var(--space-3)',
          background: 'var(--surface-2)',
          borderRadius: 'var(--radius-sm)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {[
          `Platform_Fee    = Count(Ordered_Main_Items) × ${moneyBare(policy.platformFee.feePerMainItemMinor)}`,
          `Merchant_Payout = Subtotal − Platform_Fee − Payment_Processing_Fee`,
          `Total (顧客付)  = Subtotal + Customer_Service_Fee (${moneyBare(policy.customerServiceFeeMinor)})`,
        ].join('\n')}
      </div>
    </div>
  );
}

function renderValue(entry: PlatformConfigEntry, value: number | boolean | string | null): string {
  if (value === null) return '—';
  if (entry.valueType === 'boolean') return value ? '開啟' : '關閉';
  return String(value);
}

function ConfigEditor({
  entry,
  onClose,
  onSaved,
  onError,
}: {
  entry: PlatformConfigEntry;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(String(entry.effectiveValue));
  const [description, setDescription] = useState(entry.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isBoolean = entry.valueType === 'boolean';
  const numeric = Number.parseInt(value, 10);
  const valid = isBoolean || (Number.isFinite(numeric) && numeric >= 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const next: number | boolean = isBoolean ? value === 'true' : numeric;
      await api.admin.config.upsert(
        entry.key,
        next,
        description.trim() === entry.description ? undefined : description.trim(),
      );
      await onSaved(`${entry.key} 已更新為 ${isBoolean ? (next ? '開啟' : '關閉') : String(next)}`);
    } catch (caught) {
      const message = (caught as Error).message;
      setError(message);
      onError(message);
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`調整 ${entry.key}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            儲存
          </Button>
        </>
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}

      {entry.isPricingKey && (
        <Banner tone="warn" title="這是計費參數">
          中介費以 minor units 儲存：HK$3.50 要輸入 <strong>350</strong>，不是 3.5。
          手續費率以 basis points 儲存：3.40% 要輸入 <strong>340</strong>。
        </Banner>
      )}

      <Field
        label="值"
        hint={isBoolean ? '開啟或關閉' : `目前生效值：${String(entry.effectiveValue)}`}
      >
        {isBoolean ? (
          <Select value={value} onChange={(event) => setValue(event.target.value)}>
            <option value="true">開啟</option>
            <option value="false">關閉</option>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            inputMode="numeric"
            className={valid ? '' : 'input-error'}
          />
        )}
      </Field>

      <Field label="說明" hint="會顯示在參數清單上">
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={500}
        />
      </Field>

      <div className="stack-sm">
        <span className="tiny dim">變更預覽</span>
        <div className="row-between">
          <span className="tiny muted">目前</span>
          <span className="num">{renderValue(entry, entry.effectiveValue)}</span>
        </div>
        <div className="row-between">
          <span className="tiny muted">儲存後</span>
          <span className="num strong">
            {isBoolean ? (value === 'true' ? '開啟' : '關閉') : valid ? numeric : '—'}
          </span>
        </div>
      </div>
    </Modal>
  );
}
