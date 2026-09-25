'use client';

import { useMemo, useState } from 'react';
import { MerchantShell, MerchantStatusNotice } from '@/components/merchant-shell';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHead,
  Checkbox,
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
import { useMerchant } from '@/lib/merchant';
import { useAsync } from '@/lib/use-async';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, money } from '@/lib/format';
import type { MenuCategory, MenuItem, MenuItemAvailability, OwnerMenu } from '@/lib/types';

/**
 * `HK$58.00` typed by a human -> `5800` minor units.
 *
 * Rounds rather than truncates. `58.99 * 100` is `5898.999999999999` in IEEE754,
 * and `Math.trunc` would quietly shave a cent off the dish — on a menu of a
 * hundred items that is a real, invisible revenue leak. The API enforces the
 * upper bound; this only has to be honest about the lower one.
 */
function toMinor(input: string): number | null {
  const parsed = Number.parseFloat(input);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

/** `5800` -> `58.00`, for pre-filling the price input. */
function toMajorInput(minor: number): string {
  return (minor / 100).toFixed(2);
}

const AVAILABILITY_OPTIONS: MenuItemAvailability[] = ['AVAILABLE', 'SOLD_OUT', 'HIDDEN'];

export default function MerchantMenuPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const state = useAsync<OwnerMenu>(
    () => (merchantId ? api.menu.get(merchantId) : Promise.resolve(null as unknown as OwnerMenu)),
    [merchantId],
  );

  const [itemEditor, setItemEditor] = useState<{
    item: MenuItem | null;
    categoryId: string | null;
  } | null>(null);
  const [categoryEditor, setCategoryEditor] = useState<MenuCategory | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'item' | 'category'; id: string; name: string } | null
  >(null);
  const [busy, setBusy] = useState(false);

  const menu = state.data;
  const categories = useMemo(() => menu?.categories ?? [], [menu]);
  const uncategorised = menu?.uncategorised ?? [];

  if (!merchant || !merchantId) return null;

  const guard = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await fn();
      toast.push(message, 'ok');
      await state.reload();
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Category order is written by issuing one `PATCH` per category with its new
   * index.
   *
   * Items have a bulk `PUT /menu/items/order` endpoint and use it; categories
   * do not, so the whole list is renumbered. Sending all of them rather than
   * only the two that moved is what makes the result correct even when the
   * existing `sortOrder` values are not contiguous — which they are not, after
   * a delete.
   */
  const moveCategory = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= categories.length) return;
    const reordered = [...categories];
    const moved = reordered[index];
    const displaced = reordered[target];
    if (!moved || !displaced) return;
    reordered[index] = displaced;
    reordered[target] = moved;
    void guard(
      () =>
        Promise.all(
          reordered.map((category, order) =>
            api.menu.updateCategory(merchantId, category.id, { sortOrder: order }),
          ),
        ),
      '分類順序已更新',
    );
  };

  const moveItem = (list: MenuItem[], index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const reordered = [...list];
    const moved = reordered[index];
    const displaced = reordered[target];
    if (!moved || !displaced) return;
    reordered[index] = displaced;
    reordered[target] = moved;
    void guard(
      () =>
        api.menu.reorderItems(
          merchantId,
          reordered.map((item, order) => ({ id: item.id, sortOrder: order })),
        ),
      '菜式順序已更新',
    );
  };

  const deleteTarget = () => {
    if (!confirmDelete) return;
    const { kind, id } = confirmDelete;
    return kind === 'item'
      ? api.menu.deleteItem(merchantId, id)
      : api.menu.deleteCategory(merchantId, id);
  };

  return (
    <MerchantShell
      title="菜單管理"
      subtitle={menu ? `服務日 ${menu.serviceDate} · 今日剩餘為即時數字` : merchant.name}
      actions={
        <>
          <Button size="sm" onClick={() => setCategoryEditor('new')}>
            新增分類
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setItemEditor({ item: null, categoryId: null })}
          >
            新增菜式
          </Button>
        </>
      }
    >
      <div className="stack">
        <MerchantStatusNotice merchant={merchant} />

        {state.error ? (
          <ErrorBlock error={state.error} onRetry={() => void state.reload()} />
        ) : state.loading && !menu ? (
          <Loading rows={5} />
        ) : (
          <>
            <div className="grid-4">
              <Stat label="分類" value={menu?.totals.categories ?? 0} />
              <Stat label="菜式" value={menu?.totals.items ?? 0} />
              <Stat
                label="主餐"
                value={menu?.totals.mainItems ?? 0}
                hint="每件收 HK$3.50 平台費"
              />
              <Stat
                label="今日售出上限"
                value={
                  menu
                    ? menu.categories.reduce(
                        (sum, category) =>
                          sum +
                          category.items.filter((item) => item.availability === 'SOLD_OUT')
                            .length,
                        0,
                      ) +
                    uncategorised.filter((item) => item.availability === 'SOLD_OUT').length
                    : 0
                }
                hint="已標示售罄的菜式數"
              />
            </div>

            <Banner tone="info" title="主餐標記會直接影響你的收入">
              每件標記為「主餐」的菜式，平台收取 HK$3.50 中介費，並從你的入帳中扣除。
              飲品、配菜一般應設為非主餐。
            </Banner>

            {categories.length === 0 && uncategorised.length === 0 && (
              <Card>
                <Empty
                  icon="📋"
                  title="菜單還是空的"
                  action={
                    <Button
                      variant="primary"
                      onClick={() => setItemEditor({ item: null, categoryId: null })}
                    >
                      新增第一道菜
                    </Button>
                  }
                >
                  先建立分類（例如「點心」、「飲品」），再逐項加入菜式。
                </Empty>
              </Card>
            )}

            {categories.map((category, categoryIndex) => (
              <Card flush key={category.id}>
                <div style={{ padding: 'var(--space-4)' }}>
                  <div className="row-between">
                    <div className="stack-sm" style={{ gap: 2 }}>
                      <div className="row" style={{ gap: 'var(--space-2)' }}>
                        <h3>{category.name}</h3>
                        {!category.isActive && <Badge tone="neutral">已隱藏</Badge>}
                      </div>
                      <span className="tiny dim">
                        {category.items.length} 道菜
                        {category.nameEn ? ` · ${category.nameEn}` : ''}
                      </span>
                    </div>

                    <div className="row-wrap">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || categoryIndex === 0}
                        title="上移"
                        onClick={() => moveCategory(categoryIndex, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || categoryIndex === categories.length - 1}
                        title="下移"
                        onClick={() => moveCategory(categoryIndex, 1)}
                      >
                        ↓
                      </Button>
                      <Button size="sm" onClick={() => setCategoryEditor(category)}>
                        編輯
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setItemEditor({ item: null, categoryId: category.id })}
                      >
                        新增菜式
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() =>
                          setConfirmDelete({
                            kind: 'category',
                            id: category.id,
                            name: category.name,
                          })
                        }
                      >
                        刪除
                      </Button>
                    </div>
                  </div>
                </div>

                <ItemTable
                  items={category.items}
                  busy={busy}
                  onMove={(index, delta) => moveItem(category.items, index, delta)}
                  onEdit={(item) => setItemEditor({ item, categoryId: category.id })}
                  onDelete={(item) =>
                    setConfirmDelete({ kind: 'item', id: item.id, name: item.name })
                  }
                  onAvailability={(item, availability) =>
                    void guard(
                      () => api.menu.setAvailability(merchantId, item.id, availability),
                      `${item.name} 已更新供應狀態`,
                    )
                  }
                />
              </Card>
            ))}

            {uncategorised.length > 0 && (
              <Card flush>
                <div style={{ padding: 'var(--space-4)' }}>
                  <CardHead
                    title="未分類"
                    subtitle="沒有歸類的菜式。顧客仍看得到，但沒有分類標題。"
                    action={
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => setItemEditor({ item: null, categoryId: null })}
                      >
                        新增菜式
                      </Button>
                    }
                  />
                </div>
                <ItemTable
                  items={uncategorised}
                  busy={busy}
                  onMove={(index, delta) => moveItem(uncategorised, index, delta)}
                  onEdit={(item) => setItemEditor({ item, categoryId: null })}
                  onDelete={(item) =>
                    setConfirmDelete({ kind: 'item', id: item.id, name: item.name })
                  }
                  onAvailability={(item, availability) =>
                    void guard(
                      () => api.menu.setAvailability(merchantId, item.id, availability),
                      `${item.name} 已更新供應狀態`,
                    )
                  }
                />
              </Card>
            )}
          </>
        )}
      </div>

      {itemEditor && (
        <ItemEditor
          merchantId={merchantId}
          categories={categories}
          editing={itemEditor.item}
          defaultCategoryId={itemEditor.categoryId}
          onClose={() => setItemEditor(null)}
          onSaved={async (message) => {
            setItemEditor(null);
            toast.push(message, 'ok');
            await state.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}

      {categoryEditor && (
        <CategoryEditor
          merchantId={merchantId}
          editing={categoryEditor === 'new' ? null : categoryEditor}
          onClose={() => setCategoryEditor(null)}
          onSaved={async (message) => {
            setCategoryEditor(null);
            toast.push(message, 'ok');
            await state.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}

      <Modal
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={confirmDelete?.kind === 'category' ? '刪除分類' : '刪除菜式'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                void (async () => {
                  const target = confirmDelete;
                  if (!target) return;
                  setBusy(true);
                  try {
                    await deleteTarget();
                    toast.push(`${target.name} 已刪除`, 'ok');
                    setConfirmDelete(null);
                    await state.reload();
                  } catch (caught) {
                    toast.push((caught as Error).message, 'danger');
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              確認刪除
            </Button>
          </>
        }
      >
        {confirmDelete?.kind === 'category' ? (
          <Banner tone="warn">
            分類「{confirmDelete.name}」內仍有菜式時無法刪除。若只是想停售，請改用「編輯」把它設為隱藏 —
            這樣保留分組，日後可原樣恢復。
          </Banner>
        ) : (
          <p>
            刪除「{confirmDelete?.name}」後無法復原。若只是今日售罄，請改為「今日售罄」而不是刪除。
          </p>
        )}
      </Modal>
    </MerchantShell>
  );
}

function ItemTable({
  items,
  busy,
  onMove,
  onEdit,
  onDelete,
  onAvailability,
}: {
  items: MenuItem[];
  busy: boolean;
  onMove: (index: number, delta: number) => void;
  onEdit: (item: MenuItem) => void;
  onDelete: (item: MenuItem) => void;
  onAvailability: (item: MenuItem, availability: MenuItemAvailability) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="empty" style={{ padding: 'var(--space-5)' }}>
        <span className="tiny dim">此分類還沒有菜式</span>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>菜式</th>
            <th className="right">價格</th>
            <th>主餐</th>
            <th>供應</th>
            <th className="right">今日剩餘</th>
            <th className="right">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={item.id}>
              <td>
                <div className="stack-sm" style={{ gap: 1 }}>
                  <span className="strong">{item.name}</span>
                  <span className="tiny dim">
                    {item.nameEn ? `${item.nameEn} · ` : ''}
                    {item.prepTimeMinutes ? `${item.prepTimeMinutes} 分鐘` : '沿用店舖出餐時間'}
                  </span>
                </div>
              </td>
              <td className="right num strong">{money(item.priceMinor)}</td>
              <td>
                {item.isMainItem ? (
                  <Badge tone="accent">主餐</Badge>
                ) : (
                  <span className="tiny dim">—</span>
                )}
              </td>
              <td>
                <Select
                  value={item.availability}
                  disabled={busy}
                  style={{ width: 120 }}
                  onChange={(event) =>
                    onAvailability(item, event.target.value as MenuItemAvailability)
                  }
                >
                  {AVAILABILITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {AVAILABILITY_LABEL[option]}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="right num">
                {item.remainingToday === null ? (
                  <span className="dim">無限</span>
                ) : (
                  <span style={{ color: item.remainingToday === 0 ? 'var(--danger)' : undefined }}>
                    {item.remainingToday}
                    {item.dailyQuota !== null ? ` / ${item.dailyQuota}` : ''}
                  </span>
                )}
              </td>
              <td className="right">
                <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || index === 0}
                    title="上移"
                    onClick={() => onMove(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || index === items.length - 1}
                    title="下移"
                    onClick={() => onMove(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button size="sm" onClick={() => onEdit(item)}>
                    編輯
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => onDelete(item)}>
                    刪除
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ==========================================================================
   Editors
   ========================================================================== */

function ItemEditor({
  merchantId,
  categories,
  editing,
  defaultCategoryId,
  onClose,
  onSaved,
  onError,
}: {
  merchantId: string;
  categories: MenuCategory[];
  editing: MenuItem | null;
  defaultCategoryId: string | null;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState({
    name: editing?.name ?? '',
    nameEn: editing?.nameEn ?? '',
    description: editing?.description ?? '',
    price: editing ? toMajorInput(editing.priceMinor) : '',
    categoryId: editing?.categoryId ?? defaultCategoryId ?? '',
    isMainItem: editing?.isMainItem ?? false,
    dailyQuota: editing?.dailyQuota === null || editing?.dailyQuota === undefined ? '' : String(editing.dailyQuota),
    prepTimeMinutes:
      editing?.prepTimeMinutes === null || editing?.prepTimeMinutes === undefined
        ? ''
        : String(editing.prepTimeMinutes),
    availability: editing?.availability ?? ('AVAILABLE' as MenuItemAvailability),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceMinor = toMinor(form.price);
  const ready = form.name.trim().length > 0 && priceMinor !== null;

  async function submit() {
    if (priceMinor === null) {
      setError('請輸入有效價格，例如 58.00');
      return;
    }
    setBusy(true);
    setError(null);

    const quota = form.dailyQuota.trim() === '' ? null : Number.parseInt(form.dailyQuota, 10);
    const prep = form.prepTimeMinutes.trim() === '' ? null : Number.parseInt(form.prepTimeMinutes, 10);

    const payload = {
      name: form.name.trim(),
      ...(form.nameEn.trim() ? { nameEn: form.nameEn.trim() } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      priceMinor,
      ...(form.categoryId ? { categoryId: form.categoryId } : { categoryId: null }),
      isMainItem: form.isMainItem,
      availability: form.availability,
      dailyQuota: quota,
      prepTimeMinutes: prep,
    };

    try {
      if (editing) {
        await api.menu.updateItem(merchantId, editing.id, payload);
        await onSaved(`${payload.name} 已更新`);
      } else {
        await api.menu.createItem(merchantId, payload);
        await onSaved(`${payload.name} 已新增`);
      }
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
      wide
      title={editing ? `編輯 ${editing.name}` : '新增菜式'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            {editing ? '儲存' : '新增'}
          </Button>
        </>
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}

      <div className="grid-2">
        <Field label="菜式名稱 *">
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="蝦餃"
            maxLength={160}
          />
        </Field>
        <Field label="英文名稱">
          <Input
            value={form.nameEn}
            onChange={(event) => setForm({ ...form, nameEn: event.target.value })}
            placeholder="Shrimp Dumpling"
            maxLength={160}
          />
        </Field>
      </div>

      <Field label="簡介">
        <Textarea
          value={form.description}
          onChange={(event) => setForm({ ...form, description: event.target.value })}
          maxLength={2000}
          placeholder="即點即蒸，四件"
        />
      </Field>

      <div className="grid-2">
        <Field label="價格（HK$）*" hint="以元為單位，例如 58 或 58.50">
          <Input
            value={form.price}
            onChange={(event) => setForm({ ...form, price: event.target.value })}
            inputMode="decimal"
            placeholder="58.00"
            className={form.price.length > 0 && priceMinor === null ? 'input-error' : ''}
          />
        </Field>
        <Field label="分類" hint="留空則不歸類">
          <Select
            value={form.categoryId}
            onChange={(event) => setForm({ ...form, categoryId: event.target.value })}
          >
            <option value="">未分類</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="每日供應上限" hint="留空或 0 代表無限">
          <Input
            value={form.dailyQuota}
            onChange={(event) => setForm({ ...form, dailyQuota: event.target.value })}
            inputMode="numeric"
            placeholder="例如 40"
          />
        </Field>
        <Field label="出餐時間（分鐘）" hint="留空則沿用店舖設定">
          <Input
            value={form.prepTimeMinutes}
            onChange={(event) => setForm({ ...form, prepTimeMinutes: event.target.value })}
            inputMode="numeric"
            placeholder="15"
          />
        </Field>
      </div>

      <Field label="供應狀態">
        <Select
          value={form.availability}
          onChange={(event) =>
            setForm({ ...form, availability: event.target.value as MenuItemAvailability })
          }
        >
          {AVAILABILITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {AVAILABILITY_LABEL[option]}
            </option>
          ))}
        </Select>
      </Field>

      <Checkbox
        checked={form.isMainItem}
        onChange={(next) => setForm({ ...form, isMainItem: next })}
        label={
          <span>
            標記為<strong>主餐</strong>
            <span className="tiny dim"> — 每件收 HK$3.50 平台費並從入帳扣除</span>
          </span>
        }
      />
    </Modal>
  );
}

function CategoryEditor({
  merchantId,
  editing,
  onClose,
  onSaved,
  onError,
}: {
  merchantId: string;
  editing: MenuCategory | null;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [nameEn, setNameEn] = useState(editing?.nameEn ?? '');
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      ...(nameEn.trim() ? { nameEn: nameEn.trim() } : {}),
      isActive,
    };
    try {
      if (editing) {
        await api.menu.updateCategory(merchantId, editing.id, payload);
        await onSaved(`${payload.name} 已更新`);
      } else {
        await api.menu.createCategory(merchantId, payload);
        await onSaved(`${payload.name} 已新增`);
      }
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
      title={editing ? `編輯 ${editing.name}` : '新增分類'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={name.trim().length === 0}
            onClick={() => void submit()}
          >
            {editing ? '儲存' : '新增'}
          </Button>
        </>
      }
    >
      {error && <Banner tone="danger">{error}</Banner>}

      <Field label="分類名稱 *">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="點心"
          maxLength={120}
        />
      </Field>

      <Field label="英文名稱">
        <Input
          value={nameEn}
          onChange={(event) => setNameEn(event.target.value)}
          placeholder="Dim Sum"
          maxLength={120}
        />
      </Field>

      <Checkbox
        checked={isActive}
        onChange={setIsActive}
        label={
          <span>
            在前台顯示
            <span className="tiny dim"> — 取消勾選可停售整個分類而不刪除菜式</span>
          </span>
        }
      />
    </Modal>
  );
}
