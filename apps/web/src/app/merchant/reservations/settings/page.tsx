'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  ErrorBlock,
  Field,
  Input,
  Loading,
  Textarea,
  Toggle,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { useAsync } from '@/lib/use-async';
import type { ReservationPolicy } from '@/lib/types';

/**
 * 訂位設定 — the shop's reservation book settings.
 *
 * The form's job is to make the two cross-field rules impossible to submit:
 *
 *   - `minPartySize <= maxPartySize`
 *   - `turnMinutes >= slotMinutes`
 *
 * Both are enforced by the API too, but a merchant who types 8/4 should be told
 * which pair is wrong *before* a round trip, next to the fields. The server is
 * still the authority — this is a fast, local copy of the same predicate, and
 * the save button is disabled while it is violated rather than relying on the
 * error coming back.
 *
 * The whole object is submitted (PUT semantics), because a partial write is how
 * a merchant ends up with a `maxPartySize` they thought they had changed.
 */

/** The editable shape — numbers are strings so a partly-typed field is legal. */
interface Draft {
  enabled: boolean;
  autoConfirm: boolean;
  slotMinutes: string;
  turnMinutes: string;
  seatsPerSlot: string;
  minPartySize: string;
  maxPartySize: string;
  leadTimeMinutes: string;
  advanceDays: string;
  customerNotice: string;
}

function toDraft(policy: ReservationPolicy, customerNotice: string | null): Draft {
  return {
    enabled: policy.enabled,
    autoConfirm: policy.autoConfirm,
    slotMinutes: String(policy.slotMinutes),
    turnMinutes: String(policy.turnMinutes),
    seatsPerSlot: String(policy.seatsPerSlot),
    minPartySize: String(policy.minPartySize),
    maxPartySize: String(policy.maxPartySize),
    leadTimeMinutes: String(policy.leadTimeMinutes),
    advanceDays: String(policy.advanceDays),
    customerNotice: customerNotice ?? '',
  };
}

const NUMERIC_BOUNDS: Record<string, { min: number; max: number; label: string }> = {
  slotMinutes: { min: 5, max: 120, label: '每格長度必須介於 5–120 分鐘' },
  turnMinutes: { min: 15, max: 360, label: '用餐時間必須介於 15–360 分鐘' },
  seatsPerSlot: { min: 1, max: 500, label: '每時段座位必須介於 1–500' },
  minPartySize: { min: 1, max: 50, label: '最少人數必須介於 1–50' },
  maxPartySize: { min: 1, max: 50, label: '最多人數必須介於 1–50' },
  leadTimeMinutes: { min: 0, max: 10_080, label: '最短提前預訂必須介於 0–10080 分鐘' },
  advanceDays: { min: 1, max: 365, label: '可預訂天數必須介於 1–365 日' },
};

/** The first problem with the draft, or `null`. Order matches the form. */
function findProblem(draft: Draft): string | null {
  for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
    const value = Number.parseInt(draft[key as keyof Draft] as string, 10);
    if (!Number.isFinite(value)) return `${bounds.label}（請輸入數字）`;
    if (value < bounds.min || value > bounds.max) return bounds.label;
  }

  const min = Number.parseInt(draft.minPartySize, 10);
  const max = Number.parseInt(draft.maxPartySize, 10);
  if (min > max) return '最少人數不能大於最多人數，否則任何訂位都不合法。';

  const slot = Number.parseInt(draft.slotMinutes, 10);
  const turn = Number.parseInt(draft.turnMinutes, 10);
  if (turn < slot) {
    return '用餐時間不能短於每格長度，否則一筆訂位會佔不住它所在的時段。';
  }

  return null;
}

export default function ReservationSettingsPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const settings = useAsync(
    () => (merchantId ? api.bookings.settings(merchantId) : Promise.resolve(null)),
    [merchantId],
  );

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed once the settings land. Keyed on the merchant id so a re-fetch does
  // not stomp on fields the merchant has since edited.
  useEffect(() => {
    if (settings.data && draft === null) {
      setDraft(toDraft(settings.data.policy, settings.data.customerNotice));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.data]);

  if (!merchant || !merchantId) return null;

  const problem = draft ? findProblem(draft) : null;

  const patch = (partial: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...partial } : current));

  /** Toggling the master switch saves immediately — it is one decision. */
  async function toggleEnabled(next: boolean) {
    if (!draft) return;
    setDraft({ ...draft, enabled: next });
    setSaving(true);
    setError(null);
    try {
      const updated = await api.bookings.saveSettings(merchantId!, { enabled: next });
      setDraft(toDraft(updated.policy, updated.customerNotice));
      toast.push(next ? '已開放線上訂位' : '已關閉線上訂位', next ? 'ok' : 'warn');
    } catch (caught) {
      // Roll the switch back — leaving it visually on when the server refused
      // would make the merchant think bookings are coming in.
      setDraft((current) => (current ? { ...current, enabled: !next } : current));
      setError((caught as Error).message);
      toast.push((caught as Error).message, 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function save() {
    if (!draft || problem) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.bookings.saveSettings(merchantId!, {
        enabled: draft.enabled,
        autoConfirm: draft.autoConfirm,
        slotMinutes: Number(draft.slotMinutes),
        turnMinutes: Number(draft.turnMinutes),
        seatsPerSlot: Number(draft.seatsPerSlot),
        minPartySize: Number(draft.minPartySize),
        maxPartySize: Number(draft.maxPartySize),
        leadTimeMinutes: Number(draft.leadTimeMinutes),
        advanceDays: Number(draft.advanceDays),
        // An emptied box clears the notice rather than leaving the old prose.
        customerNotice: draft.customerNotice.trim() ? draft.customerNotice.trim() : null,
      });
      setDraft(toDraft(updated.policy, updated.customerNotice));
      toast.push('訂位設定已儲存', 'ok');
    } catch (caught) {
      setError((caught as Error).message);
      toast.push((caught as Error).message, 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <MerchantShell title="訂位設定" subtitle={`${merchant.name} · 時區 ${merchant.timezone}`}>
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        {settings.error ? (
          <ErrorBlock error={settings.error} onRetry={() => void settings.reload()} />
        ) : !draft ? (
          <Loading rows={5} />
        ) : (
          <>
            {error && <Banner tone="danger">{error}</Banner>}

            <Card>
              <CardHead
                title="線上訂位"
                subtitle="關閉後顧客看不到訂位入口，已存在的訂位不受影響"
                action={
                  <Toggle
                    checked={draft.enabled}
                    onChange={(next) => void toggleEnabled(next)}
                    disabled={saving || merchant.status !== 'ACTIVE'}
                    onLabel="開放中"
                    offLabel="已關閉"
                  />
                }
              />
              <div className="row-wrap">
                <Badge tone={draft.enabled ? 'ok' : 'neutral'}>
                  {draft.enabled ? '顧客可預約' : '顧客不可預約'}
                </Badge>
                {merchant.status !== 'ACTIVE' && (
                  <span className="tiny dim">
                    商戶未上線，訂位不會對顧客開放。狀態由平台管理。
                  </span>
                )}
              </div>
            </Card>

            <Card>
              <CardHead title="自動確認" subtitle="開啟後新訂位直接成立，不需人手確認" />
              <Toggle
                checked={draft.autoConfirm}
                onChange={(next) => patch({ autoConfirm: next })}
                onLabel="自動確認"
                offLabel="人手確認"
              />
              <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
                繁忙時段建議關閉，讓你可以先看人數再決定是否接單。
              </p>
            </Card>

            <Card>
              <CardHead title="時段與座位" subtitle="決定顧客看到的時間格線與容量" />
              <div className="stack">
                <div className="grid-2">
                  <Field label="每格長度（分鐘）" hint="5–120。顧客可選的開始時間間隔，例如 30">
                    <Input
                      value={draft.slotMinutes}
                      inputMode="numeric"
                      onChange={(event) => patch({ slotMinutes: event.target.value })}
                    />
                  </Field>
                  <Field
                    label="用餐時間（分鐘）"
                    hint="15–360，且不可短於每格長度。例如 90 分鐘會佔用 3 格"
                  >
                    <Input
                      value={draft.turnMinutes}
                      inputMode="numeric"
                      onChange={(event) => patch({ turnMinutes: event.target.value })}
                    />
                  </Field>
                </div>

                <Field
                  label="每時段座位數"
                  hint="1–500。系統以座位而非桌數計算容量，確保 6 人桌不會被當成 2 人"
                >
                  <Input
                    value={draft.seatsPerSlot}
                    inputMode="numeric"
                    style={{ maxWidth: 160 }}
                    onChange={(event) => patch({ seatsPerSlot: event.target.value })}
                  />
                </Field>
              </div>
            </Card>

            <Card>
              <CardHead title="人數限制" />
              <div className="grid-2">
                <Field label="最少人數" hint="1–50">
                  <Input
                    value={draft.minPartySize}
                    inputMode="numeric"
                    onChange={(event) => patch({ minPartySize: event.target.value })}
                  />
                </Field>
                <Field label="最多人數" hint="1–50，不可小於最少人數">
                  <Input
                    value={draft.maxPartySize}
                    inputMode="numeric"
                    onChange={(event) => patch({ maxPartySize: event.target.value })}
                  />
                </Field>
              </div>
              <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
                超出上限的團體請直接致電店家。
              </p>
            </Card>

            <Card>
              <CardHead title="預訂規則" />
              <div className="grid-2">
                <Field label="最短提前預訂（分鐘）" hint="0–10080。例如 60 表示不可訂 1 小時內的時段">
                  <Input
                    value={draft.leadTimeMinutes}
                    inputMode="numeric"
                    onChange={(event) => patch({ leadTimeMinutes: event.target.value })}
                  />
                </Field>
                <Field label="可預訂天數" hint="1–365。顧客最多可選未來幾天">
                  <Input
                    value={draft.advanceDays}
                    inputMode="numeric"
                    onChange={(event) => patch({ advanceDays: event.target.value })}
                  />
                </Field>
              </div>
            </Card>

            <Card>
              <CardHead title="顧客提示" subtitle="會直接顯示在訂位頁，例如用餐限時或訂金安排" />
              <Field label="提示文字（選填）" hint="留空即不顯示">
                <Textarea
                  value={draft.customerNotice}
                  maxLength={500}
                  rows={3}
                  placeholder="例如：訂位保留 15 分鐘，逾時將釋出座位。"
                  onChange={(event) => patch({ customerNotice: event.target.value })}
                />
              </Field>
            </Card>

            {problem && (
              <Banner tone="warn" title="設定尚未一致">
                {problem}
              </Banner>
            )}

            <div className="row-between">
              <Link href="/merchant/reservations">
                <Button variant="ghost">← 返回訂位簿</Button>
              </Link>
              <Button
                variant="primary"
                loading={saving}
                disabled={problem !== null}
                onClick={() => void save()}
              >
                儲存訂位設定
              </Button>
            </div>
          </>
        )}
      </div>
    </MerchantShell>
  );
}
