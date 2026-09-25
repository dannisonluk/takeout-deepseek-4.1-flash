import { DiningSessionStatus } from '@takeout/domain';

/**
 * 店內點餐 — the read models.
 *
 * THREE shapes, and the split is the point of this file. The requirement for
 * this feature was explicitly "the UI emphasis differs, and some screens must
 * work on a phone", and the differences are structural rather than cosmetic:
 *
 *   - **`ScannedTableView`** is what a guest gets the instant a phone camera
 *     resolves a QR. It is read standing up, one-handed, in a noisy shop, and
 *     it must therefore arrive in ONE response: which restaurant, which table,
 *     whether there is a sitting here, what is on the tab so far. A second
 *     round-trip before the page can render is the difference between "掃碼即點"
 *     and a spinner in front of a waiter.
 *   - **`MerchantTableBoardView`** is a tablet on a counter in a dark shop. It
 *     needs every table, its sitting, and its running total at a glance; it does
 *     NOT need the dish-level detail, because the kitchen board already has it.
 *   - **`DiningSessionTabView`** is the tab the guest checks and the host closes.
 *     It carries the line items because "what did we order" is the question both
 *     of them ask, and neither should have to reconstruct it from order ids.
 *
 * As with the waitlist views, keeping these as separate types rather than one
 * object with flags is what stops the guest's response from carrying another
 * table's tab, or the board's response from carrying a guest's session token.
 */

/** One table, as the merchant's floor plan lists it. */
export interface DiningTableView {
  readonly id: string;
  readonly code: string;
  readonly label: string | null;
  readonly seats: number;
  readonly isActive: boolean;
  readonly qrToken: string;
  /**
   * The QR URL a shop prints on the label. Built server-side because it needs
   * the web app's public origin, which the client does not reliably know (a
   * tablet on the shop's LAN and a printed sheet must produce the same string).
   */
  readonly qrUrl: string;
  /** The live sitting, if the table is in use. */
  readonly session: DiningSessionSummaryView | null;
}

/** A sitting, without its line items. What the board renders per table. */
export interface DiningSessionSummaryView {
  readonly id: string;
  readonly tableId: string;
  readonly tableCode: string;
  readonly status: DiningSessionStatus;
  readonly statusLabel: string;
  readonly partySize: number | null;
  readonly serviceDate: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  /** How long the table has been sitting, in minutes. Drives "已經 42 分鐘". */
  readonly seatedMinutes: number;
  /** Running total across everything ordered this sitting, in minor units. */
  readonly totalMinor: number;
  /** How many orders (rounds) this table has placed. */
  readonly orderCount: number;
  /** How many main dishes, which is what the platform fee is charged on. */
  readonly mainItemCount: number;
  readonly version: number;
}

/** The merchant's floor plan. */
export interface MerchantTableBoardView {
  readonly merchantId: string;
  readonly timezone: string;
  readonly serviceDate: string;
  readonly tables: readonly DiningTableView[];
  readonly counts: {
    readonly total: number;
    readonly active: number;
    readonly occupied: number;
    readonly free: number;
    /** Planned covers across the open sittings. */
    readonly seatedGuests: number;
  };
}

/** One line on a tab. */
export interface DiningTabLineView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly quantity: number;
  readonly lineTotalMinor: number;
  readonly createdAt: string;
  /** False for a voided round, so the tab can grey it rather than hide it. */
  readonly countsTowardTotal: boolean;
}

/** The tab for one sitting — what the guest reviews and the host closes. */
export interface DiningSessionTabView {
  readonly session: DiningSessionSummaryView;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly lines: readonly DiningTabLineView[];
  readonly subtotalMinor: number;
  readonly totalMinor: number;
  /** False once the sitting is closed; the page then shows the settled bill. */
  readonly canOrderMore: boolean;
  readonly settledAt: string | null;
}

/** What a scanned QR resolves to. The guest's entry point. */
export interface ScannedTableView {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantSlug: string;
  readonly timezone: string;
  readonly tableId: string;
  readonly tableCode: string;
  readonly tableLabel: string | null;
  readonly seats: number;
  /**
   * Whether 店內點餐 is switched on for this shop. False renders an
   * "此餐廳未開放掃碼點餐" screen rather than a broken menu.
   */
  readonly diningEnabled: boolean;
  /** Whether the shop is open right now, so the menu is not shown at 03:00. */
  readonly openNow: boolean;
  /**
   * The sitting at this table, if one is open.
   *
   * `null` means the table is free: the page then offers "開始用餐" (open a
   * sitting) rather than an order menu, because an order with no sitting has
   * nowhere to be billed to.
   */
  readonly session: DiningSessionSummaryView | null;
  /**
   * The QR token, echoed back so the guest's subsequent requests can be keyed on
   * it without the app having to parse the URL again. Present ONLY on this
   * response — the board never receives a token.
   */
  readonly qrToken: string;
}

/** The result of opening a sitting from a scanned table. */
export interface OpenSessionResultView {
  readonly session: DiningSessionSummaryView;
  /**
   * 一次性入座碼 — the token the guest's subsequent ordering is keyed on.
   *
   * Returned ONLY here, and only to the guest who just opened the sitting. The
   * table's static QR is not enough to order, so the page must capture this and
   * use it for every round. It is per-sitting and never reused.
   */
  readonly guestToken: string;
  /** The URL the guest's phone should settle on after opening. */
  readonly orderingUrl: string;
  readonly message: string;
}

/** The result of closing a sitting. */
export interface CloseSessionResultView {
  readonly session: DiningSessionSummaryView;
  readonly tab: DiningSessionTabView;
  readonly message: string;
}
