import { WaitlistStatus } from '@takeout/domain';

/**
 * 現場候位 — the read models.
 *
 * Two shapes, deliberately different, because the two audiences ask different
 * questions and the UI emphasis requirement makes that concrete:
 *
 *   - **`CustomerQueueView`** is what one guest sees on their phone, one-handed,
 *     in daylight, possibly walking. It answers "where am I and when will it be
 *     my turn" and nothing else. It is deliberately small.
 *   - **`MerchantQueueView`** is what the host sees on a tablet on a counter in
 *     a dark shop. It answers "who is next, and who have I already called" and
 *     needs the whole queue, the phone numbers, and every action available.
 *
 * Keeping them as separate types rather than one object with a `role` flag is
 * what stops the customer's response from carrying the phone numbers of the
 * eight parties ahead of them.
 */

/** A guest's own ticket. */
export interface CustomerQueueTicketView {
  readonly id: string;
  /** `A-014` — the number the guest was told. */
  readonly ticketNo: string;
  readonly status: WaitlistStatus;
  /** 候位中 / 已叫號 / 已入座 — pre-labelled, so no client invents its own. */
  readonly statusLabel: string;
  readonly partySize: number;
  readonly guestName: string;
  readonly joinedAt: string;
  /**
   * 1-based position among the tickets still ahead or equal. `0` once the
   * ticket has ended — the page polls this and must survive the ticket ending
   * without rendering a "number 0" card.
   */
  readonly position: number;
  /** How many parties are ahead of this one. */
  readonly ahead: number;
  /**
   * Rough minutes until called. `null` when it cannot be estimated (a terminal
   * ticket) — deliberately not `0`, which would read as "now".
   */
  readonly estimatedWaitMinutes: number | null;
  /** What the guest was quoted when they joined, for "you were told N minutes". */
  readonly quotedMinutes: number | null;
  readonly calledAt: string | null;
  /** Deadline to appear after being called. Drives the countdown on the page. */
  readonly callDeadlineAt: string | null;
  readonly seatedAt: string | null;
  readonly cancelledAt: string | null;
  readonly statusReason: string | null;
  /** The guest may leave the queue only while still waiting. */
  readonly canCancel: boolean;
  /** Read off the settings so the page can show the shop's own wording. */
  readonly customerNotice: string | null;
}

/** The whole take-a-number page payload for one merchant. */
export interface CustomerQueueEntryPointView {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantSlug: string;
  readonly timezone: string;
  /** False hides the entry point entirely — the feature is off. */
  readonly enabled: boolean;
  /** False while the shop is shut and does not take tickets when shut. */
  readonly acceptingNow: boolean;
  /**
   * Why not, when `acceptingNow` is false. `'CLOSED'` when the shop is shut,
   * `'DISABLED'` when the feature is off.
   *
   * Two values rather than a boolean because the guest takes a different action
   * for each: "come back at 11" versus "this shop does not do queues".
   */
  readonly closedReason: 'CLOSED' | 'DISABLED' | null;
  readonly policy: {
    readonly minPartySize: number;
    readonly maxPartySize: number;
    readonly averageTurnMinutes: number;
    readonly callTimeoutMinutes: number;
  };
  readonly customerNotice: string | null;
  /**
   * How long the current queue is and roughly how long a new guest would wait.
   * Shown before they commit, which is the whole point of the number.
   */
  readonly queueLength: number;
  readonly estimatedWaitMinutes: number;
  /** The guest's own live ticket, when they already hold one. */
  readonly myTicket: CustomerQueueTicketView | null;
}

/** One row of the host board. */
export interface MerchantQueueEntryView {
  readonly id: string;
  readonly ticketNo: string;
  readonly status: WaitlistStatus;
  readonly statusLabel: string;
  readonly statusShortLabel: string;
  readonly partySize: number;
  readonly guestName: string;
  readonly contactPhone: string;
  readonly note: string | null;
  readonly joinedAt: string;
  readonly position: number;
  readonly ahead: number;
  readonly estimatedWaitMinutes: number | null;
  readonly calledAt: string | null;
  readonly callDeadlineAt: string | null;
  readonly seatedAt: string | null;
  readonly cancelledAt: string | null;
  readonly statusReason: string | null;
  readonly waitedMinutes: number;
  readonly version: number;
  /**
   * What the host may do next, computed by the same state machine the write
   * path uses. A board that offered a button the server would refuse is the
   * defect this field exists to prevent.
   */
  readonly allowedNextTransitions: readonly WaitlistStatus[];
}

/** The host board for one shop. */
export interface MerchantQueueView {
  readonly merchantId: string;
  /** Merchant-local `YYYY-MM-DD` of the queue being shown. */
  readonly serviceDate: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly acceptingNow: boolean;
  readonly customerNotice: string | null;
  readonly policy: {
    readonly enabled: boolean;
    readonly acceptWhenClosed: boolean;
    readonly minPartySize: number;
    readonly maxPartySize: number;
    readonly averageTurnMinutes: number;
    readonly callTimeoutMinutes: number;
  };
  /** Tickets still waiting or called. This is the live queue. */
  readonly active: readonly MerchantQueueEntryView[];
  /** Everything that ended today, newest first — the "who did we seat" log. */
  readonly completed: readonly MerchantQueueEntryView[];
  readonly counts: {
    readonly waiting: number;
    readonly called: number;
    readonly seated: number;
    readonly noShow: number;
    readonly cancelled: number;
  };
  /** The next ticket number that would be issued. Shown as "next: A-015". */
  readonly nextTicketNo: string;
}

/** The settings screen's read model. */
export interface WaitlistSettingsView {
  readonly merchantId: string;
  readonly policy: {
    readonly enabled: boolean;
    readonly acceptWhenClosed: boolean;
    readonly minPartySize: number;
    readonly maxPartySize: number;
    readonly averageTurnMinutes: number;
    readonly callTimeoutMinutes: number;
  };
  readonly customerNotice: string | null;
  /** Whether the shop is open right now, so 開關 has context. */
  readonly openNow: boolean;
}

/** The result of a take-a-number request. */
export interface TakeNumberResultView {
  readonly ticket: CustomerQueueTicketView;
  /** Prose for the confirmation, built server-side so the number cannot drift. */
  readonly message: string;
}

/** The result of advancing a ticket, as the host board receives it. */
export interface QueueTransitionResultView {
  readonly entryId: string;
  readonly ticketNo: string;
  readonly fromStatus: WaitlistStatus;
  readonly toStatus: WaitlistStatus;
  readonly occurredAt: string;
  /** Obligations the caller must discharge (notify, start the call timer). */
  readonly sideEffects: readonly string[];
  readonly callDeadlineAt: string | null;
  readonly allowedNextTransitions: readonly WaitlistStatus[];
  readonly entry: MerchantQueueEntryView;
}

/** What a call-timeout sweep did. */
export interface QueueSweepResultView {
  readonly merchantId: string;
  readonly markedNoShow: number;
  readonly skipped: number;
  readonly message: string;
}
