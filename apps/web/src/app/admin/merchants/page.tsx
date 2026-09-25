'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AdminShell, Pager } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  ErrorBlock,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Textarea,
  Toggle,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync, useDebounced } from '@/lib/use-async';
import { HK_DISTRICTS } from '@/lib/districts';
import {
  ANALYTICS_CAPABILITY_LABEL,
  ANALYTICS_TIERS,
  ANALYTICS_TIER_BLURB,
  ANALYTICS_TIER_LABEL,
  ANALYTICS_TIER_TONE,
  MERCHANT_ACTION_LABEL,
  MERCHANT_STATUS_LABEL,
  MERCHANT_STATUS_TONE,
  analyticsTierRank,
  dateTime,
  minuteOfDay,
  money,
  phone as formatPhone,
  weekday,
} from '@/lib/format';
import type {
  AdminMerchant,
  AnalyticsCapability,
  AnalyticsTier,
  MerchantAdminAction,
  MerchantStatus,
} from '@/lib/types';

const LIMIT = 25;

const ALL_STATUSES: MerchantStatus[] = [
  'DRAFT',
  'PENDING_REVIEW',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
];

/**
 * What each lifecycle action actually does, so the confirm dialog can say it.
 *
 * APPROVE and REINSTATE deliberately do NOT reopen intake: a merchant who
 * paused their own shop before being suspended should not silently start
 * receiving orders because an admin reinstated them. The operator turns intake
 * on separately, which is why the dialog says so rather than implying it.
 */
const ACTION_EFFECT: Record<MerchantAdminAction, string> = {
  APPROVE: '商戶會出現在顧客前台。接單開關維持目前設定，不會自動開啟。',
  SUSPEND: '商戶立即從前台下架，無法再接收新訂單。已存在的訂單不受影響。',
  REINSTATE: '商戶重新出現在前台。接單開關維持目前設定，不會自動開啟。',
  CLOSE: '結業是不可還原的。商戶永久下架，之後只能建立新的商戶。',
};

export default function AdminMerchantsPage() {
  return (
    <Suspense fallback={<div className="page"><Loading rows={5} /></div>}>
      <MerchantsView />
    </Suspense>
  );
}

function MerchantsView() {
  const search = useSearchParams();
  const toast = useToast();

  const [status, setStatus] = useState(search.get('status') ?? '');
  const [district, setDistrict] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const debouncedQuery = useDebounced(query, 350);

  const list = useAsync(
    () =>
      api.admin.merchants.list({
        ...(status ? { status } : {}),
        ...(district ? { district } : {}),
        ...(debouncedQuery ? { q: debouncedQuery } : {}),
        limit: LIMIT,
        offset,
      }),
    [status, district, debouncedQuery, offset],
  );

  return (
    <AdminShell
      title="商戶"
      subtitle={list.data ? `共 ${list.data.total} 間` : undefined}
      actions={
        <Button size="sm" onClick={() => void list.reload()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <Card tight>
          <div className="grid-3">
            <Field label="狀態">
              <Select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部</option>
                {ALL_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {MERCHANT_STATUS_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="地區">
              <Select
                value={district}
                onChange={(event) => {
                  setDistrict(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部</option>
                {HK_DISTRICTS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="搜尋" hint="名稱、代稱、擁有者">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
                placeholder="dim-sum-express"
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
            <Empty icon="🏪" title="沒有符合條件的商戶">
              調整篩選條件再試，或等待新的入駐申請。
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>商戶</th>
                      <th>狀態</th>
                      <th>接單</th>
                      <th>擁有者</th>
                      <th>地區</th>
                      <th className="right">菜式</th>
                      <th className="right">進行中</th>
                      <th className="right">累計 GMV</th>
                      <th className="right">待結算</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data?.data.map((merchant) => (
                      <tr
                        key={merchant.id}
                        data-clickable="true"
                        onClick={() => setOpenId(merchant.id)}
                      >
                        <td>
                          <div className="stack-sm" style={{ gap: 1 }}>
                            <span className="strong">{merchant.name}</span>
                            <span className="tiny dim mono">{merchant.slug}</span>
                          </div>
                        </td>
                        <td>
                          <Badge tone={MERCHANT_STATUS_TONE[merchant.status]}>
                            {MERCHANT_STATUS_LABEL[merchant.status]}
                          </Badge>
                        </td>
                        <td>
                          {merchant.acceptsOrders ? (
                            <Badge tone="ok" dot>
                              接單中
                            </Badge>
                          ) : (
                            <Badge tone="neutral">已暫停</Badge>
                          )}
                        </td>
                        <td className="truncate" style={{ maxWidth: 150 }}>
                          {merchant.owner?.displayName ?? <span className="dim">—</span>}
                        </td>
                        <td className="tiny">{merchant.district ?? <span className="dim">—</span>}</td>
                        <td className="right num">{merchant.stats.menuItems}</td>
                        <td className="right num">
                          {merchant.stats.activeOrders > 0 ? (
                            <span className="strong">{merchant.stats.activeOrders}</span>
                          ) : (
                            <span className="dim">0</span>
                          )}
                        </td>
                        <td className="right num">{money(merchant.stats.lifetimeGmvMinor)}</td>
                        <td className="right num">
                          {merchant.stats.pendingPayoutMinor > 0 ? (
                            money(merchant.stats.pendingPayoutMinor)
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                total={list.data?.total ?? 0}
                limit={LIMIT}
                offset={offset}
                onChange={setOffset}
              />
            </>
          )}
        </Card>
      </div>

      {openId && (
        <MerchantDetail
          merchantId={openId}
          onClose={() => setOpenId(null)}
          onChanged={async (message) => {
            toast.push(message, 'ok');
            await list.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}
    </AdminShell>
  );
}

function MerchantDetail({
  merchantId,
  onClose,
  onChanged,
  onError,
}: {
  merchantId: string;
  onClose: () => void;
  onChanged: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const state = useAsync<AdminMerchant>(() => api.admin.merchants.get(merchantId), [merchantId]);
  const [pendingAction, setPendingAction] = useState<MerchantAdminAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const merchant = state.data;

  async function applyAction(action: MerchantAdminAction) {
    if (!merchant) return;
    setBusy(true);
    try {
      const updated = await api.admin.merchants.act(merchant.id, action, reason.trim());
      await onChanged(`${updated.name}：${MERCHANT_ACTION_LABEL[action] ?? action} 已完成`);
      setPendingAction(null);
      setReason('');
      await state.reload();
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleIntake(next: boolean) {
    if (!merchant) return;
    setBusy(true);
    try {
      const updated = await api.admin.merchants.setIntake(merchant.id, next);
      await onChanged(`${updated.name} 接單狀態已${next ? '開啟' : '關閉'}`);
      await state.reload();
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={merchant?.name ?? '載入中…'}
      footer={
        <Button variant="ghost" onClick={onClose}>
          關閉
        </Button>
      }
    >
      {state.error ? (
        <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
      ) : !merchant ? (
        <Loading rows={5} />
      ) : (
        <div className="stack">
          <div className="row-wrap">
            <Badge tone={MERCHANT_STATUS_TONE[merchant.status]}>
              {MERCHANT_STATUS_LABEL[merchant.status]}
            </Badge>
            <span className="tiny muted mono">{merchant.slug}</span>
            <span className="tiny dim">建立於 {dateTime(merchant.createdAt)}</span>
          </div>

          <div className="grid-4">
            <div className="stat">
              <span className="stat-label">菜式</span>
              <span className="stat-value">{merchant.stats.menuItems}</span>
            </div>
            <div className="stat">
              <span className="stat-label">進行中訂單</span>
              <span className="stat-value">{merchant.stats.activeOrders}</span>
            </div>
            <div className="stat">
              <span className="stat-label">累計 GMV</span>
              <span className="stat-value" style={{ fontSize: 18 }}>
                {money(merchant.stats.lifetimeGmvMinor)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">待結算</span>
              <span className="stat-value" style={{ fontSize: 18 }}>
                {money(merchant.stats.pendingPayoutMinor)}
              </span>
            </div>
          </div>

          {/* ---- intake -------------------------------------------------- */}
          <Card tight>
            <div className="row-between">
              <div className="stack-sm" style={{ gap: 2 }}>
                <strong>接單開關</strong>
                <span className="tiny muted">
                  平台可以直接控制。關閉後顧客無法下單，新訂單會被自動拒單並退款。
                </span>
              </div>
              <Toggle
                checked={merchant.acceptsOrders}
                onChange={(next) => void toggleIntake(next)}
                disabled={busy || merchant.status !== 'ACTIVE'}
                onLabel="接單中"
                offLabel="已暫停"
              />
            </div>
          </Card>

          {/* ---- reporting tier ------------------------------------------ */}
          <AnalyticsTierControl
            merchant={merchant}
            busy={busy}
            onChanged={async (message) => {
              await onChanged(message);
              await state.reload();
            }}
            onError={onError}
          />

          {/* ---- lifecycle ----------------------------------------------- */}
          <div className="stack-sm">
            <span className="tiny dim">商戶狀態操作</span>
            {merchant.allowedActions.length === 0 ? (
              <Banner tone="info">
                此商戶已結業，沒有可執行的狀態操作。
              </Banner>
            ) : (
              <div className="row-wrap">
                {merchant.allowedActions.map((action) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={
                      action === 'CLOSE' || action === 'SUSPEND'
                        ? 'danger'
                        : action === 'APPROVE' || action === 'REINSTATE'
                          ? 'primary'
                          : 'default'
                    }
                    onClick={() => {
                      setPendingAction(action);
                      setReason('');
                    }}
                  >
                    {MERCHANT_ACTION_LABEL[action] ?? action}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {/* ---- contact + address --------------------------------------- */}
          <div className="stack-sm">
            <span className="tiny dim">資料</span>
            <Row label="擁有者" value={merchant.owner?.displayName ?? '—'} />
            <Row
              label="聯絡電話"
              value={merchant.owner?.phone ? formatPhone(merchant.owner.phone) : '—'}
            />
            <Row label="商戶電話" value={merchant.phone ? formatPhone(merchant.phone) : '—'} />
            <Row label="地址" value={`${merchant.addressLine1}${merchant.addressLine2 ? ` ${merchant.addressLine2}` : ''}`} />
            <Row label="地區" value={merchant.district ?? '—'} />
            <Row label="座標" value={`${merchant.latitude}, ${merchant.longitude}`} />
            <Row label="出餐時間" value={`${merchant.prepTimeMinutes} 分鐘`} />
            <Row label="取餐時段" value={`${merchant.pickupWindowMinutes} 分鐘`} />
            <Row label="接單時限" value={`${merchant.acceptTimeoutMinutes} 分鐘`} />
            <Row label="自動接單" value={merchant.autoAcceptOrders ? '已開啟' : '已關閉'} />
            <Row label="時區" value={merchant.timezone} />
          </div>

          {merchant.hours.length > 0 && (
            <div className="stack-sm">
              <span className="tiny dim">營業時間</span>
              {merchant.hours.map((hour) => (
                <div className="row-between" key={hour.dayOfWeek}>
                  <span className="tiny">{weekday(hour.dayOfWeek)}</span>
                  <span className="tiny num">
                    {hour.isClosed
                      ? '休息'
                      : `${minuteOfDay(hour.opensAtMinute)} – ${minuteOfDay(hour.closesAtMinute)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Modal
        open={pendingAction !== null}
        onClose={() => setPendingAction(null)}
        title={pendingAction ? MERCHANT_ACTION_LABEL[pendingAction] : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingAction(null)}>
              取消
            </Button>
            <Button
              variant={pendingAction === 'CLOSE' || pendingAction === 'SUSPEND' ? 'danger' : 'primary'}
              loading={busy}
              disabled={reason.trim().length === 0}
              onClick={() => pendingAction && void applyAction(pendingAction)}
            >
              確認
            </Button>
          </>
        }
      >
        <Banner tone={pendingAction === 'CLOSE' ? 'danger' : 'warn'}>
          {pendingAction ? ACTION_EFFECT[pendingAction] : ''}
        </Banner>
        <Field label="原因 *" hint="會寫入稽核記錄">
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：證照資料齊全，核准上線"
            maxLength={500}
          />
        </Field>
      </Modal>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row-between">
      <span className="tiny muted nowrap">{label}</span>
      <span className="tiny num truncate" style={{ textAlign: 'right' }}>
        {value}
      </span>
    </div>
  );
}

/**
 * 商戶營業報表權限 — the paid-tier switch.
 *
 * WHY IT NEEDS ITS OWN CONFIRM DIALOG
 * -----------------------------------
 * An upgrade is safe and takes effect immediately. A downgrade silently removes
 * panels a shop may be using in a monthly close, and the merchant finds out by
 * seeing an empty section they had been reading last month. So the downgrade
 * path is a dialog that names the capability being taken away — and the API
 * supplies that prose (`warning`) rather than this component inventing it,
 * because the capability table lives in the domain.
 *
 * The export being free is *not* a tier property here: `canExportRawData` is
 * always true, and the text says so on every tier, so an operator does not
 * think a downgrade cuts a shop off from its own rows.
 */
function AnalyticsTierControl({
  merchant,
  busy,
  onChanged,
  onError,
}: {
  merchant: AdminMerchant;
  busy: boolean;
  onChanged: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<AnalyticsTier | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  /**
   * Ask the API what the move would cost before doing it.
   *
   * A dry probe rather than a local rank comparison: the capability table is
   * the domain's, and re-deriving "is this a downgrade" in the browser is how
   * the warning and the actual effect drift apart. The probe is a real write
   * when it is not a downgrade — so this only probes on the moves the local
   * rank check already says are downgrades, and those are the ones that open a
   * dialog anyway.
   */
  async function choose(next: AnalyticsTier) {
    if (next === merchant.analytics.tier) return;
    const isDowngrade =
      analyticsTierRank(next) < analyticsTierRank(merchant.analytics.tier);
    if (!isDowngrade) {
      await apply(next);
      return;
    }
    setWarning(
      `降級後此商戶將無法使用${lostCapabilities(merchant.analytics.tier, next)}。已匯出的檔案不受影響。`,
    );
    setPending(next);
  }

  async function apply(next: AnalyticsTier) {
    setApplying(true);
    try {
      const result = await api.admin.merchants.setAnalyticsTier(merchant.id, next);
      await onChanged(
        result.isDowngrade && result.warning ? `${result.message}（${result.warning}）` : result.message,
      );
      setPending(null);
      setWarning(null);
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card tight>
      <div className="stack-sm">
        <div className="row-between row-wrap" style={{ gap: 'var(--space-2)' }}>
          <div className="stack-sm" style={{ gap: 2 }}>
            <strong>營業報表權限</strong>
            <span className="tiny muted">
              平台控制。訂單明細匯出永久免費，付費方案買的是分析功能（趨勢、排行、同期比較）。
            </span>
          </div>
          <Badge tone={ANALYTICS_TIER_TONE[merchant.analytics.tier]}>
            {merchant.analytics.label}
          </Badge>
        </div>

        <div className="row-wrap">
          {ANALYTICS_TIERS.map((tier) => (
            <Button
              key={tier}
              size="sm"
              variant={tier === merchant.analytics.tier ? 'primary' : 'default'}
              disabled={busy || applying || tier === merchant.analytics.tier}
              onClick={() => void choose(tier)}
              title={ANALYTICS_TIER_BLURB[tier]}
            >
              {ANALYTICS_TIER_LABEL[tier]}
            </Button>
          ))}
        </div>

        <span className="tiny dim">{merchant.analytics.blurb}</span>
      </div>

      <Modal
        open={pending !== null}
        onClose={() => {
          setPending(null);
          setWarning(null);
        }}
        title={`降級至「${pending ? ANALYTICS_TIER_LABEL[pending] : ''}」`}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setPending(null);
                setWarning(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={applying}
              onClick={() => pending && void apply(pending)}
            >
              確認降級
            </Button>
          </>
        }
      >
        <Banner tone="warn" title="降級會立即移除以下功能">
          <span className="tiny">{warning}</span>
        </Banner>
        <p className="tiny dim" style={{ marginTop: 'var(--space-3)' }}>
          歷史資料不會被刪除。若之後重新升級，過去所有日期的報表會再次完整顯示。
        </p>
      </Modal>
    </Card>
  );
}

/**
 * The capabilities a downgrade takes away, as prose.
 *
 * Mirrors `describeLostCapabilities` in the API so the confirm dialog can render
 * its warning BEFORE the request is sent — a modal that only knows what it is
 * removing after it has removed it is not a confirmation. The API's own warning
 * is still shown in the toast afterwards, and the two come from the same table
 * in `packages/domain`.
 */
function lostCapabilities(from: AnalyticsTier, to: AnalyticsTier): string {
  const rank: Record<AnalyticsTier, AnalyticsCapability[]> = {
    NONE: [],
    BASIC: ['DAILY_ROLLUP', 'ITEM_MIX', 'HOUR_OF_DAY', 'CHANNEL_MIX'],
    PRO: ['DAILY_ROLLUP', 'ITEM_MIX', 'HOUR_OF_DAY', 'CHANNEL_MIX', 'COMPARISON'],
  };
  const lost = rank[from].filter((capability) => !rank[to].includes(capability));
  if (lost.length === 0) return '任何功能';
  return lost.map((capability) => ANALYTICS_CAPABILITY_LABEL[capability]).join('、');
}
