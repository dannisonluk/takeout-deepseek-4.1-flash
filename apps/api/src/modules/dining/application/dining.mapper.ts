import {
  DiningSessionStatus,
  ORDER_STATUS_LABEL_ZH_HK,
  OrderStatus,
  DINING_SESSION_STATUS_LABEL,
} from '@takeout/domain';
import {
  PersistedDiningSession,
  PersistedDiningTable,
  SessionOrderSummary,
} from '../domain/dining.repository.port';
import {
  DiningSessionSummaryView,
  DiningTabLineView,
} from '../interface/dining.views';

/**
 * 店內點餐 — domain rows to read models.
 *
 * The one computation worth naming is `summary`: a session view carries a total
 * and a seated time, neither of which is a column. Totals are summed from the
 * order summaries the repository returns (already only the orders that count),
 * and the seated time is derived from `openedAt` against the caller's clock.
 *
 * Deriving both here rather than storing them keeps the invariants in one
 * place: there is no `total_minor` column to go stale against the orders, and
 * no `seated_minutes` column to be wrong the moment a tablet's clock is off.
 */

/** Sum what the table owes right now. Returns minor units. */
export function tabTotals(orders: readonly SessionOrderSummary[]): {
  totalMinor: number;
  mainItemCount: number;
  orderCount: number;
} {
  let totalMinor = 0;
  let mainItemCount = 0;
  for (const order of orders) {
    totalMinor += order.totalMinor;
    mainItemCount += order.itemCount;
  }
  return { totalMinor, mainItemCount, orderCount: orders.length };
}

/** A session plus its tab, flattened into the summary the board and tab share. */
export function toSessionSummary(
  session: PersistedDiningSession,
  table: Pick<PersistedDiningTable, 'code'>,
  orders: readonly SessionOrderSummary[],
  now: Date,
): DiningSessionSummaryView {
  const totals = tabTotals(orders);

  return {
    id: session.id,
    tableId: session.tableId,
    tableCode: table.code,
    status: session.status,
    statusLabel: DINING_SESSION_STATUS_LABEL[session.status],
    partySize: session.partySize,
    serviceDate: session.serviceDate.toISOString().slice(0, 10),
    openedAt: session.openedAt.toISOString(),
    closedAt: session.closedAt?.toISOString() ?? null,
    seatedMinutes: Math.max(
      0,
      Math.floor(
        ((session.closedAt ?? now).getTime() - session.openedAt.getTime()) / 60_000,
      ),
    ),
    totalMinor: totals.totalMinor,
    orderCount: totals.orderCount,
    mainItemCount: totals.mainItemCount,
    version: session.version,
  };
}

/**
 * One round on the tab.
 *
 * `countsTowardTotal` is a separate field from the status because the two
 * audiences want different things from the same row: the guest wants to know
 * their 走冰 request was cancelled without the line vanishing, and the total
 * must not include it. Hiding voided rounds entirely makes a guest think the
 * order was never placed.
 */
export function toTabLine(order: SessionOrderSummary): DiningTabLineView {
  return {
    orderId: order.orderId,
    orderNo: order.orderNo,
    status: order.status,
    statusLabel: orderStatusLabel(order.status),
    quantity: order.itemCount,
    lineTotalMinor: order.totalMinor,
    createdAt: order.createdAt.toISOString(),
    countsTowardTotal: countsTowardTotal(order.status),
  };
}

/**
 * Statuses that are NOT on the bill.
 *
 * Note what is absent: `PENDING_PAYMENT`. A dine-in round is on the tab from
 * the moment it is sent — the guest is seated and the money is settled on the
 * whole bill at the end — so an unpaid round counts. This mirrors the
 * repository's `notIn` filter exactly; the two must agree or the total on screen
 * and the total in the row would differ.
 */
function countsTowardTotal(status: string): boolean {
  return !['REJECTED', 'CANCELLED', 'EXPIRED'].includes(status);
}

/**
 * A label for an order status that arrived as a bare string.
 *
 * The repository returns the status as a string because it crosses the Prisma
 * boundary; the labels live in the domain keyed by the domain enum. Unknown
 * values fall through to the raw string rather than to `undefined`, so a status
 * added to the database but not the label map shows up in the UI as its own
 * name instead of a blank cell.
 */
function orderStatusLabel(status: string): string {
  const label = (ORDER_STATUS_LABEL_ZH_HK as Record<string, string | undefined>)[status];
  if (label) return label;
  const domainStatus = status as OrderStatus;
  return ORDER_STATUS_LABEL_ZH_HK[domainStatus] ?? status;
}

export { DiningSessionStatus };
