'use client';

import { useState } from 'react';
import { AdminShell, Pager } from '@/components/admin-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Empty,
  ErrorBlock,
  Field,
  Input,
  Loading,
  Modal,
  Select,
  Stat,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useAsync, useDebounced } from '@/lib/use-async';
import { ROLE_LABEL, dateTime, phone as formatPhone, relative } from '@/lib/format';
import type { AdminUser, UserRole } from '@/lib/types';

const LIMIT = 25;

const ROLES: UserRole[] = ['CUSTOMER', 'MERCHANT_OWNER', 'MERCHANT_STAFF', 'ADMIN'];

const ROLE_TONE: Record<UserRole, 'neutral' | 'info' | 'accent' | 'danger'> = {
  CUSTOMER: 'neutral',
  MERCHANT_OWNER: 'info',
  MERCHANT_STAFF: 'info',
  ADMIN: 'danger',
};

export default function AdminUsersPage() {
  const toast = useToast();
  const [role, setRole] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  const debouncedQuery = useDebounced(query, 350);

  const list = useAsync(
    () =>
      api.admin.users.list({
        ...(role ? { role } : {}),
        ...(active ? { isActive: active === 'true' } : {}),
        ...(debouncedQuery ? { q: debouncedQuery } : {}),
        limit: LIMIT,
        offset,
      }),
    [role, active, debouncedQuery, offset],
  );

  return (
    <AdminShell
      title="使用者"
      subtitle={list.data ? `共 ${list.data.total} 位` : undefined}
      actions={
        <Button size="sm" onClick={() => void list.reload()}>
          重新整理
        </Button>
      }
    >
      <div className="stack">
        <Card tight>
          <div className="grid-3">
            <Field label="角色">
              <Select
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                  setOffset(0);
                }}
              >
                <option value="">全部</option>
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="狀態">
              <Select
                value={active}
                onChange={(event) => {
                  setActive(event.target.value as '' | 'true' | 'false');
                  setOffset(0);
                }}
              >
                <option value="">全部</option>
                <option value="true">已啟用</option>
                <option value="false">已停用</option>
              </Select>
            </Field>
            <Field label="搜尋" hint="姓名或電話">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOffset(0);
                }}
                placeholder="+8529000…"
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
            <Empty icon="👤" title="沒有符合條件的使用者" />
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>使用者</th>
                      <th>角色</th>
                      <th>狀態</th>
                      <th className="right">擁有商戶</th>
                      <th className="right">員工身分</th>
                      <th className="right">訂單</th>
                      <th className="right">活躍 session</th>
                      <th>最後登入</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data?.data.map((user) => (
                      <tr key={user.id} data-clickable="true" onClick={() => setOpenId(user.id)}>
                        <td>
                          <div className="stack-sm" style={{ gap: 1 }}>
                            <span className="strong">{user.displayName}</span>
                            <span className="tiny dim mono">
                              {user.phone ? formatPhone(user.phone) : (user.email ?? user.id.slice(0, 8))}
                            </span>
                          </div>
                        </td>
                        <td>
                          <Badge tone={ROLE_TONE[user.role]}>{ROLE_LABEL[user.role]}</Badge>
                        </td>
                        <td>
                          {user.isActive ? (
                            <Badge tone="ok" dot>
                              已啟用
                            </Badge>
                          ) : (
                            <Badge tone="danger">已停用</Badge>
                          )}
                        </td>
                        <td className="right num">{user.ownedMerchantCount || <span className="dim">—</span>}</td>
                        <td className="right num">{user.staffMerchantCount || <span className="dim">—</span>}</td>
                        <td className="right num">{user.orderCount}</td>
                        <td className="right num">
                          {user.activeSessionCount > 0 ? (
                            <span className="strong">{user.activeSessionCount}</span>
                          ) : (
                            <span className="dim">0</span>
                          )}
                        </td>
                        <td className="tiny dim nowrap">{relative(user.lastLoginAt)}</td>
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
        <UserDetail
          userId={openId}
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

function UserDetail({
  userId,
  onClose,
  onChanged,
  onError,
}: {
  userId: string;
  onClose: () => void;
  onChanged: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const state = useAsync<AdminUser>(() => api.admin.users.get(userId), [userId]);
  const [draft, setDraft] = useState<{
    displayName: string;
    role: UserRole;
    isActive: boolean;
    locale: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const user = state.data;
  const form = draft ?? (user ? { displayName: user.displayName, role: user.role, isActive: user.isActive, locale: user.locale } : null);

  const roleChanged = !!user && !!form && form.role !== user.role;
  const dirty =
    !!user &&
    !!form &&
    (form.displayName !== user.displayName ||
      form.role !== user.role ||
      form.isActive !== user.isActive ||
      form.locale !== user.locale);

  async function save() {
    if (!user || !form) return;
    setBusy(true);
    try {
      await api.admin.users.update(user.id, {
        displayName: form.displayName.trim(),
        role: form.role,
        isActive: form.isActive,
        locale: form.locale,
      });
      await onChanged(`${user.displayName} 已更新`);
      setDraft(null);
      await state.reload();
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!user) return;
    setBusy(true);
    try {
      const result = await api.admin.users.revokeSessions(user.id);
      await onChanged(`${user.displayName}：已撤銷 ${result.revoked} 個 session`);
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
      title={user?.displayName ?? '載入中…'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            關閉
          </Button>
          <Button variant="primary" loading={busy} disabled={!dirty} onClick={() => void save()}>
            儲存變更
          </Button>
        </>
      }
    >
      {state.error ? (
        <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
      ) : !user || !form ? (
        <Loading rows={5} />
      ) : (
        <div className="stack">
          <div className="row-wrap">
            <Badge tone={ROLE_TONE[user.role]}>{ROLE_LABEL[user.role]}</Badge>
            {user.isActive ? (
              <Badge tone="ok" dot>
                已啟用
              </Badge>
            ) : (
              <Badge tone="danger">已停用</Badge>
            )}
            <span className="tiny dim">
              {user.phone ? formatPhone(user.phone) : (user.email ?? '—')} · 加入於{' '}
              {dateTime(user.createdAt)}
            </span>
          </div>

          <div className="grid-4">
            <Stat label="訂單" value={user.orderCount} />
            <Stat label="擁有商戶" value={user.ownedMerchantCount} />
            <Stat label="員工身分" value={user.staffMerchantCount} />
            <Stat
              label="活躍 session"
              value={user.activeSessionCount}
              tone={user.activeSessionCount > 0 ? 'warn' : undefined}
            />
          </div>

          <Field label="顯示名稱 *">
            <Input
              value={form.displayName}
              onChange={(event) => setDraft({ ...form, displayName: event.target.value })}
              maxLength={120}
            />
          </Field>

          <div className="grid-2">
            <Field label="角色" hint="變更後需要撤銷 session 才會生效">
              <Select
                value={form.role}
                onChange={(event) => setDraft({ ...form, role: event.target.value as UserRole })}
              >
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="語言">
              <Select
                value={form.locale}
                onChange={(event) => setDraft({ ...form, locale: event.target.value })}
              >
                <option value="zh-HK">繁體中文（香港）</option>
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </Select>
            </Field>
          </div>

          <Checkbox
            checked={form.isActive}
            onChange={(next) => setDraft({ ...form, isActive: next })}
            label={
              <span>
                啟用帳號
                <span className="tiny dim">
                  {' '}
                  — 停用後無法登入，已簽發的 session 仍有效直到撤銷
                </span>
              </span>
            }
          />

          {roleChanged && (
            <Banner tone="warn" title="角色變更需要撤銷 session">
              角色的授權資訊存在 access token 內。token 未過期前，此人的舊權限仍然有效 ——
              若正在降級（例如管理員改為顧客），請在儲存後立即撤銷 session。
            </Banner>
          )}

          <Banner tone="info" title="管理員保護">
            平台不允許把最後一位啟用中的管理員降級或停用，這是為了避免把自己鎖在門外。
            要調整管理員數量，請先建立新的管理員帳號。
          </Banner>

          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              disabled={user.activeSessionCount === 0}
              onClick={() => void revoke()}
            >
              撤銷全部 session（{user.activeSessionCount}）
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
