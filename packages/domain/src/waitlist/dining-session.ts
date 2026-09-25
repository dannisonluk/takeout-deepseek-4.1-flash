import { Clock, SystemClock } from '../shared/index';
import {
  DiningSessionClosedError,
  DiningSessionConflictError,
} from './waitlist.errors';

/**
 * 店內點餐 — the table's sitting.
 *
 * This is a **separate aggregate from `Order`**, and the reason is worth stating
 * because the obvious alternative is a new `OrderStatus`:
 *
 * The order lifecycle (`PAID → ACCEPTED → PREPARING → READY_FOR_PICKUP →
 * COMPLETED`) is a *collection* pipeline. Its tail is about handing food over a
 * counter. A dine-in guest never collects anything — they are already sitting
 * down. Bolting a `DINING_*` branch onto that enum would make every
 * `READY_FOR_PICKUP`-shaped guard wrong for half the states it now covers, and
 * the pricing engine, kitchen board and timeout sweeper all key off that enum.
 *
 * So an in-store order is still an ordinary `Order` row — same money, same
 * kitchen, same machine — and the **session** is what groups the several orders
 * a table places across one sitting and gates the QR token.
 */

export enum DiningSessionStatus {
  OPEN = 'OPEN',
  /** Bill settled, table turned around. */
  CLOSED = 'CLOSED',
  /** Nobody came, or the party left without ordering. */
  ABANDONED = 'ABANDONED',
}

export enum DiningActor {
  /** The guest at the table, via the QR page. */
  CUSTOMER = 'CUSTOMER',
  MERCHANT = 'MERCHANT',
  SYSTEM = 'SYSTEM',
  ADMIN = 'ADMIN',
}

const TERMINAL: readonly DiningSessionStatus[] = [
  DiningSessionStatus.CLOSED,
  DiningSessionStatus.ABANDONED,
];

export function isTerminalDiningSessionStatus(status: DiningSessionStatus): boolean {
  return TERMINAL.includes(status);
}

export const DINING_SESSION_STATUS_LABEL: Readonly<Record<DiningSessionStatus, string>> = {
  [DiningSessionStatus.OPEN]: '用餐中',
  [DiningSessionStatus.CLOSED]: '已結帳',
  [DiningSessionStatus.ABANDONED]: '已離場',
};

/**
 * The dining machine, such as it is.
 *
 * Deliberately small. The interesting lifecycle here is the **order's**, which
 * already exists and is already correct; a sitting only needs to know whether
 * it is still accepting orders, and which of the two ways it ended. Inventing
 * more states would be inventing a second order machine.
 */
export class DiningSessionMachine {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  /** Whether the table may still accept an order. */
  canOrder(status: DiningSessionStatus): boolean {
    return status === DiningSessionStatus.OPEN;
  }

  isTerminal(status: DiningSessionStatus): boolean {
    return isTerminalDiningSessionStatus(status);
  }

  close(
    context: { readonly diningSessionId: string; readonly status: DiningSessionStatus },
    to: DiningSessionStatus = DiningSessionStatus.CLOSED,
    now: Date = this.clock.now(),
  ): {
    diningSessionId: string;
    from: DiningSessionStatus;
    to: DiningSessionStatus;
    closedAt: Date;
  } {
    if (isTerminalDiningSessionStatus(context.status)) {
      throw new DiningSessionClosedError(context.status);
    }
    if (!isTerminalDiningSessionStatus(to)) {
      // Closing to a non-terminal state is not a close. Guarded here because the
      // caller passes the target, and a typo would silently leave the table open
      // while the response says it is shut.
      throw new DiningSessionConflictError(context.diningSessionId, context.status);
    }
    return {
      diningSessionId: context.diningSessionId,
      from: context.status,
      to,
      closedAt: now,
    };
  }
}

/** Throws when a table already has a live sitting. */
export function assertNoOpenSession(
  tableId: string,
  existing: { readonly id: string; readonly status: DiningSessionStatus } | null,
): void {
  if (existing && existing.status === DiningSessionStatus.OPEN) {
    throw new DiningSessionConflictError(tableId, existing.id);
  }
}
