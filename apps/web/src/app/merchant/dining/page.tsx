'use client';

import { useEffect, useState } from 'react';
import { MerchantShell } from '@/components/merchant-shell';
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
  Stat,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useMerchant } from '@/lib/merchant';
import { useAsync, useTicker } from '@/lib/use-async';
import {
  DINING_SESSION_STATUS_LABEL,
  DINING_SESSION_STATUS_TONE,
  dateTime,
  money,
  moneyCompact,
  seatedTone,
  waitDuration,
} from '@/lib/format';
import type {
  DiningSessionTab,
  DiningTable,
  MerchantTableBoard,
} from '@/lib/types';

/**
 * 店內點餐 — the merchant's floor. **Tablet on a counter.**
 *
 * THE UI BRIEF, MADE CONCRETE
 * ---------------------------
 * Same reading conditions as the host board: a tablet, dim room, glanced at
 * from a metre away. Three decisions follow from that, and one more from what
 * this screen is actually *for*:
 *
 *   1. **A grid of tables, not a list of sessions.** The host's question is
 *      "which tables are free", so a free table is a tile of its own — not an
 *      absence. A list of open sittings answers a different question and hides
 *      the room.
 *   2. **Seated time is the loudest signal on an occupied tile.** Turning a
 *      table is the job, so `seatedMinutes` drives the tile's colour and is
 *      rendered as a chip, not buried in a details pane.
 *   3. **The whole floor comes back in one request** (`api.dining.board`) so a
 *      poll cannot show a table as both free and occupied.
 *   4. **Settling is a two-step.** Tapping a table opens its tab; closing the
 *      sitting asks CLOSED vs ABANDONED, because the difference lands in the
 *      day's covers and the machine refuses to guess.
 *
 * The QR management sits here too rather than on a separate settings screen:
 * rotating a table's code is something a host does *at the table*, standing
 * next to it, holding the tablet — not something they go looking for in
 * settings while a guest watches.
 */

/** 20s. A floor changes on a human timescale; a table turn is minutes, not seconds. */
const POLL_MS = 20_000;

export default function MerchantDiningPage() {
  const { merchant, merchantId } = useMerchant();
  const toast = useToast();

  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [managing, setManaging] = useState<DiningTable | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyTableId, setBusyTableId] = useState<string | null>(null);

  const board = useAsync<MerchantTableBoard>(() => api.dining.board(merchantId!), [merchantId]);

  /**
   * Poll the floor, suppressed while a modal is open.
   *
   * A reload replaces `board.data`, and a modal keyed on the old object would
   * reset a half-filled form when a poll lands. The floor is still one tap away
   * behind the modal, and closing it refetches.
   */
  const tick = useTicker(POLL_MS);
  const reload = board.reload;
  useEffect(() => {
    if (managing || adding || openSessionId) return;
    void reload();
  }, [tick, managing, adding, openSessionId, reload]);

  if (!merchant || !merchantId) return null;

  const data = board.data;

  async function openTable(table: DiningTable) {
    setBusyTableId(table.id);
    try {
      const result = await api.dining.openTable(merchantId!, table.id);
      toast.push(`${table.code}：${result.message}`, 'ok');
      await board.reload();
    } catch (caught) {
      toast.push((caught as Error).message, 'danger');
      await board.reload();
    } finally {
      setBusyTableId(null);
    }
  }

  return (
    <MerchantShell
      title="店內桌況"
      subtitle={
        data
          ? `${data.serviceDate} · ${data.counts.occupied}／${data.counts.active} 桌使用中 · 每 ${POLL_MS / 1000} 秒更新`
          : undefined
      }
      // The number of tables in use feeds the sidebar badge: a host on the
      // kitchen board can see the floor filling up without leaving it.
      counts={data ? { occupiedTables: data.counts.occupied } : undefined}
      actions={
        <div className="row">
          <Button size="sm" onClick={() => void board.reload()}>
            重新整理
          </Button>
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            新增桌子
          </Button>
        </div>
      }
    >
      <div className="stack">
        {board.error ? (
          <ErrorBlock error={board.error} onRetry={() => void board.reload()} />
        ) : !data ? (
          <Loading rows={5} />
        ) : data.counts.total === 0 ? (
          <Card>
            <Empty icon="🪑" title="還沒有任何桌子" action={
              <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
                新增第一張桌子
              </Button>
            }>
              設定好桌子後，每一桌都可以印出專屬的 QR code，客人掃碼即可點餐。
            </Empty>
          </Card>
        ) : (
          <>
            {/* ---- the room at a glance --------------------------------- */}
            <div className="board-stats">
              <Stat label="使用中" value={data.counts.occupied} tone={data.counts.occupied > 0 ? 'ok' : undefined} />
              <Stat label="空桌" value={data.counts.free} />
              <Stat label="現場人數" value={data.counts.seatedGuests} hint="依已入座人數統計" />
              <Stat
                label="營業中桌數"
                value={`${data.counts.occupied}/${data.counts.active}`}
                hint={`共 ${data.counts.total} 張（${data.counts.total - data.counts.active} 張停用）`}
              />
            </div>

            {/* ---- the floor -------------------------------------------- */}
            <Card flush>
              <CardHead title="桌況" subtitle="點一張桌子即可查看帳單或結帳" />
              <div className="board-grid">
                {data.tables.map((table) => (
                  <TableTile
                    key={table.id}
                    table={table}
                    busy={busyTableId === table.id}
                    onOpen={() => table.session && setOpenSessionId(table.session.id)}
                    onSeat={() => void openTable(table)}
                    onManage={() => setManaging(table)}
                  />
                ))}
              </div>
            </Card>

            <p className="tiny dim">
              桌子停用後不會出現在樓面，但已存在的帳單不受影響。若 QR code 外洩，可以「重新產生 QR」讓舊碼立即失效。
            </p>
          </>
        )}
      </div>

      {/* ---- the tab / settle dialog ----------------------------------- */}
      {openSessionId && merchantId && (
        <SessionTab
          merchantId={merchantId}
          sessionId={openSessionId}
          onClose={() => setOpenSessionId(null)}
          onChanged={async (message) => {
            toast.push(message, 'ok');
            await board.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}

      {/* ---- table management ------------------------------------------ */}
      {adding && merchantId && (
        <TableEditor
          merchantId={merchantId}
          table={null}
          onClose={() => setAdding(false)}
          onSaved={async (message) => {
            toast.push(message, 'ok');
            await board.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}

      {managing && merchantId && (
        <TableEditor
          merchantId={merchantId}
          table={managing}
          onClose={() => setManaging(null)}
          onSaved={async (message) => {
            toast.push(message, 'ok');
            await board.reload();
          }}
          onError={(message) => toast.push(message, 'danger')}
        />
      )}
    </MerchantShell>
  );
}

/**
 * One table.
 *
 * Occupied and free are rendered by the same component on purpose — the tile is
 * the table, and its state is a property of it. Two components would mean a
 * free table and an occupied one at the same position look like different
 * things, which is exactly the confusion this board must not create.
 */
function TableTile({
  table,
  busy,
  onOpen,
  onSeat,
  onManage,
}: {
  table: DiningTable;
  busy: boolean;
  onOpen: () => void;
  onSeat: () => void;
  onManage: () => void;
}) {
  const session = table.session;
  const occupied = session !== null;

  return (
    <div
      className="tile"
      data-state={!table.isActive ? 'ended' : occupied ? 'called' : 'free'}
    >
      <div className="tile-head">
        <span className="tile-no">{table.code}</span>
        <div className="stack-sm" style={{ gap: 3, alignItems: 'flex-end' }}>
          {!table.isActive ? (
            <Badge tone="neutral">已停用</Badge>
          ) : occupied ? (
            <Badge tone={DINING_SESSION_STATUS_TONE[session.status]} dot>
              {DINING_SESSION_STATUS_LABEL[session.status]}
            </Badge>
          ) : (
            <Badge tone="neutral">空桌</Badge>
          )}
          {table.label && <span className="tiny dim">{table.label}</span>}
        </div>
      </div>

      <div className="tile-body">
        {occupied ? (
          <>
            <div className="row" style={{ gap: 'var(--space-3)' }}>
              <span className="tile-party">{session.partySize ?? '—'}</span>
              <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 4 }}>
                位
              </span>
              <span className="grow" />
              <div className="stack-sm" style={{ gap: 1, alignItems: 'flex-end' }}>
                <span className="tiny dim">已入座</span>
                <Badge tone={seatedTone(session.seatedMinutes)}>
                  {waitDuration(session.seatedMinutes)}
                </Badge>
              </div>
            </div>

            <div className="row-between">
              <span className="tiny dim">{session.orderCount} 輪已下單</span>
              <span className="strong num" style={{ fontSize: 18 }}>
                {money(session.totalMinor)}
              </span>
            </div>

            <span className="tiny dim">
              {table.seats} 座 · 主菜 {session.mainItemCount} 件
            </span>
          </>
        ) : (
          <>
            <span className="small muted">{table.seats} 座</span>
            <span className="tiny dim">沒有進行中的帳單</span>
          </>
        )}
      </div>

      <div className="tile-actions">
        {occupied ? (
          <Button size="lg" block variant="primary" onClick={onOpen}>
            查看帳單
          </Button>
        ) : (
          <Button
            size="lg"
            block
            variant="default"
            loading={busy}
            disabled={!table.isActive}
            onClick={onSeat}
          >
            開桌入座
          </Button>
        )}
        <Button size="sm" block variant="ghost" onClick={onManage}>
          桌號與 QR
        </Button>
      </div>
    </div>
  );
}

/**
 * The tab for one sitting, and the settle action.
 *
 * The close step asks CLOSED vs ABANDONED rather than defaulting silently. Both
 * are terminal and both are recorded; the difference is whether the party paid
 * and left or walked out, and that lands in the day's covers. A host who is
 * asked once at the end of a sitting is not being slowed down; a shop whose
 * covers are wrong every night is.
 */
function SessionTab({
  merchantId,
  sessionId,
  onClose,
  onChanged,
  onError,
}: {
  merchantId: string;
  sessionId: string;
  onClose: () => void;
  onChanged: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const tab = useAsync<DiningSessionTab>(
    () => api.dining.sessionTab(merchantId, sessionId),
    [merchantId, sessionId],
  );
  const [settling, setSettling] = useState(false);
  const [busy, setBusy] = useState(false);

  async function close(status: 'CLOSED' | 'ABANDONED') {
    setBusy(true);
    try {
      const result = await api.dining.closeSession(merchantId, sessionId, status);
      await onChanged(result.message);
      setSettling(false);
      onClose();
    } catch (caught) {
      onError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const data = tab.data;
  const settled = data ? !data.canOrderMore : false;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={data ? `${data.session.tableCode} · 帳單` : '帳單'}
      footer={
        <div className="row-between" style={{ width: '100%' }}>
          <Button variant="ghost" onClick={onClose}>
            關閉
          </Button>
          {data && !settled && !settling && (
            <Button variant="primary" onClick={() => setSettling(true)}>
              結帳並收桌
            </Button>
          )}
        </div>
      }
    >
      {tab.error ? (
        <ErrorBlock error={tab.error} onRetry={() => void tab.reload()} />
      ) : !data ? (
        <Loading rows={5} />
      ) : settling ? (
        <div className="stack">
          <Banner tone="warn" title="請確認這一桌的結束方式">
            兩種都會立刻結束這一桌並釋放桌位，但會計入不同的紀錄。
          </Banner>
          <div className="stack-sm">
            <Button
              variant="primary"
              size="lg"
              block
              loading={busy}
              onClick={() => void close('CLOSED')}
            >
              已結帳、客人離場
            </Button>
            <Button
              size="lg"
              block
              loading={busy}
              onClick={() => void close('ABANDONED')}
            >
              客人直接離場（未結帳）
            </Button>
            <Button variant="ghost" block onClick={() => setSettling(false)}>
              返回
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack">
          {/* ---- the header -------------------------------------------- */}
          <div className="row-between row-wrap" style={{ gap: 'var(--space-3)' }}>
            <div className="stack-sm" style={{ gap: 2 }}>
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <Badge tone={DINING_SESSION_STATUS_TONE[data.session.status]}>
                  {DINING_SESSION_STATUS_LABEL[data.session.status]}
                </Badge>
                <span className="small strong">
                  {data.session.partySize ?? '—'} 位
                </span>
              </div>
              <span className="tiny dim">
                入座 {dateTime(data.session.openedAt)}
                {data.settledAt && ` · 結帳 ${dateTime(data.settledAt)}`}
              </span>
            </div>
            <div className="stack-sm" style={{ gap: 0, alignItems: 'flex-end' }}>
              <span className="tiny dim">帳單總額</span>
              <span className="strong" style={{ fontSize: 24 }}>{money(data.totalMinor)}</span>
            </div>
          </div>

          <div className="grid-4">
            <Stat label="已入座" value={waitDuration(data.session.seatedMinutes)} />
            <Stat label="輪數" value={data.session.orderCount} />
            <Stat label="主菜件數" value={data.session.mainItemCount} />
            <Stat label="帳單" value={moneyCompact(data.totalMinor)} />
          </div>

          {/* ---- the lines --------------------------------------------- */}
          {data.lines.length === 0 ? (
            <Empty icon="🧾" title="這一桌還沒有點餐">
              客人掃碼後點的餐會出現在這裡，並同時送到廚房。
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>訂單</th>
                    <th>狀態</th>
                    <th className="right">件數</th>
                    <th className="right">金額</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.orderId} style={{ opacity: line.countsTowardTotal ? 1 : 0.5 }}>
                      <td>
                        <span className="mono small">{line.orderNo}</span>
                        <span className="tiny dim"> {dateTime(line.createdAt)}</span>
                      </td>
                      <td>
                        <Badge tone={line.countsTowardTotal ? 'info' : 'neutral'}>
                          {line.statusLabel}
                        </Badge>
                      </td>
                      <td className="right num">{line.quantity}</td>
                      <td className="right num">
                        {line.countsTowardTotal ? money(line.lineTotalMinor) : '已取消'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="row-between" style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }}>
            <span className="strong">合計</span>
            <span className="strong num" style={{ fontSize: 20 }}>{money(data.totalMinor)}</span>
          </div>

          {settled && (
            <Banner tone="info">
              這一桌已經結束，帳單為 {money(data.totalMinor)}。桌位已釋放，可以接待下一組客人。
            </Banner>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Create or edit a table, and its QR.
 *
 * The QR is rendered as a URL rather than an image: the shop prints the label
 * from their own printer, and a scannable image here would need a QR encoder in
 * the bundle. What the shop actually needs from this dialog is the URL to give
 * the printer — and a way to invalidate the old one if it leaks.
 */
function TableEditor({
  merchantId,
  table,
  onClose,
  onSaved,
  onError,
}: {
  merchantId: string;
  table: DiningTable | null;
  onClose: () => void;
  onSaved: (message: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const isNew = table === null;
  const [code, setCode] = useState(table?.code ?? '');
  const [label, setLabel] = useState(table?.label ?? '');
  const [seats, setSeats] = useState(String(table?.seats ?? 4));
  const [isActive, setIsActive] = useState(table?.isActive ?? true);
  const [rotate, setRotate] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      if (isNew) {
        await api.dining.createTable(merchantId, {
          code: code.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
          seats: Number(seats) || 4,
        });
        await onSaved(`桌號 ${code.trim().toUpperCase()} 已新增`);
      } else {
        await api.dining.updateTable(merchantId, table.id, {
          label: label.trim() || null,
          seats: Number(seats) || table.seats,
          isActive,
          ...(rotate ? { rotateQr: true } : {}),
        });
        await onSaved(
          rotate ? `${table.code} 已更新，QR code 已重新產生` : `${table.code} 已更新`,
        );
      }
      onClose();
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
      title={isNew ? '新增桌子' : `編輯 ${table.code}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={isNew && code.trim().length === 0}
            onClick={() => void save()}
          >
            {isNew ? '新增' : '儲存'}
          </Button>
        </>
      }
    >
      <div className="stack">
        {isNew ? (
          <Field label="桌號 *" hint="顯示在桌貼與帳單上，例如 A12、12、窗邊">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={32}
              placeholder="A12"
            />
          </Field>
        ) : (
          <Field label="桌號" hint="桌號建立後不可更改；QR code 綁定的是這張桌子">
            <Input value={table.code} readOnly />
          </Field>
        )}

        <Field label="備註標籤" hint="例如：靠窗四人桌。方便店員辨認">
          <Input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={80}
          />
        </Field>

        <Field label="座位數" hint="1–50">
          <Input
            value={seats}
            onChange={(event) => setSeats(event.target.value)}
            inputMode="numeric"
            style={{ maxWidth: 140 }}
          />
        </Field>

        {!isNew && (
          <>
            <Checkbox
              checked={isActive}
              onChange={setIsActive}
              label={
                <span>
                  桌子啟用中
                  <span className="tiny dim"> — 停用後不會出現在樓面，可以在這裡重新啟用。</span>
                </span>
              }
            />

            <div className="stack-sm">
              <span className="label">QR code</span>
              <div
                className="mono small"
                style={{
                  padding: 'var(--space-3)',
                  background: 'var(--surface-3)',
                  borderRadius: 'var(--radius)',
                  wordBreak: 'break-all',
                }}
              >
                {table.qrUrl}
              </div>
              <Checkbox
                checked={rotate}
                onChange={setRotate}
                label={
                  <span>
                    重新產生 QR code
                    <span className="tiny dim">
                      {' '}
                      — 舊的桌貼會立即失效，需要重新列印。只有在舊碼外洩時才需要。
                    </span>
                  </span>
                }
              />
              {rotate && (
                <Banner tone="warn">
                  確定後，這張桌子現在貼著的 QR code 將無法再使用。請準備好新的列印。
                </Banner>
              )}
            </div>
          </>
        )}

        {isNew && (
          <span className="tiny dim">
            新增後會產生專屬 QR code，可在「桌號與 QR」中查看並列印。
          </span>
        )}
      </div>
    </Modal>
  );
}
