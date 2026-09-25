/**
 * 現場候位 — the vocabulary.
 *
 * A walk-in queue is a different shape from a reservation book, and the enum
 * says so. There is no `PENDING`: **taking a ticket is the confirmation.** A
 * guest who has pulled a number is in the queue; there is nothing for the shop
 * to accept, and an intake switch that had to approve each one would be a
 * queue the shop has to work before it can work the queue.
 *
 * `CALLED` is the state that earns this its own machine. The gap between "your
 * table is ready" and "you sat down" is precisely where a walk-in queue is lost
 * — the guest is in the corridor, the host cannot see them, and without a
 * `CALLED` state there is no way to say "we tried" versus "we forgot".
 */

export enum WaitlistStatus {
  WAITING = 'WAITING',
  /** Called, and now on a timer to appear. */
  CALLED = 'CALLED',
  /** They sat down. */
  SEATED = 'SEATED',
  /** Called and never appeared. */
  NO_SHOW = 'NO_SHOW',
  /** The guest gave up, or the shop closed the queue with them still on it. */
  CANCELLED = 'CANCELLED',
}

export enum WaitlistActor {
  /** The guest, from the take-a-number page. */
  CUSTOMER = 'CUSTOMER',
  MERCHANT = 'MERCHANT',
  /** The clock — the call-timeout sweep. */
  SYSTEM = 'SYSTEM',
  ADMIN = 'ADMIN',
}

/** The guest is no longer in the queue. */
const TERMINAL: readonly WaitlistStatus[] = [
  WaitlistStatus.SEATED,
  WaitlistStatus.NO_SHOW,
  WaitlistStatus.CANCELLED,
];

/**
 * Still somebody's job — this is what the host board's live list counts.
 *
 * `SEATED` is terminal for the ticket, even though the party is now in the
 * building: the *queue* item is done. The sitting is `DiningSession`'s problem,
 * not the queue's, and conflating the two is how a board ends up showing a
 * guest twice — once as seated, once as still waiting.
 */
const ACTIVE: readonly WaitlistStatus[] = [WaitlistStatus.WAITING, WaitlistStatus.CALLED];

export function isTerminalWaitlistStatus(status: WaitlistStatus): boolean {
  return TERMINAL.includes(status);
}

export function isActiveWaitlistStatus(status: WaitlistStatus): boolean {
  return ACTIVE.includes(status);
}

export const WAITLIST_STATUS_LABEL: Readonly<Record<WaitlistStatus, string>> = {
  [WaitlistStatus.WAITING]: '候位中',
  [WaitlistStatus.CALLED]: '已叫號',
  [WaitlistStatus.SEATED]: '已入座',
  [WaitlistStatus.NO_SHOW]: '過號',
  [WaitlistStatus.CANCELLED]: '已取消',
};

/** Short form for the host board's chips, where width is scarce. */
export const WAITLIST_STATUS_SHORT_LABEL: Readonly<Record<WaitlistStatus, string>> = {
  [WaitlistStatus.WAITING]: '候位',
  [WaitlistStatus.CALLED]: '叫號',
  [WaitlistStatus.SEATED]: '入座',
  [WaitlistStatus.NO_SHOW]: '過號',
  [WaitlistStatus.CANCELLED]: '取消',
};

/**
 * The tunable shape of a shop's queue.
 *
 * Read from `WaitlistSettings` with the defaults below as the fallback, the
 * same three-layer resolution pricing uses — a merchant who has never opened
 * the settings screen gets a working queue rather than a `null` the service has
 * to guess at.
 */
export interface WaitlistPolicy {
  /** Off until the merchant turns it on. */
  readonly enabled: boolean;
  /**
   * Take tickets while the shop is shut.
   *
   * Default `false`, because a queue that fills before opening means the first
   * guest to arrive at opening is behind six people who are still asleep. A
   * shop that wants a warm queue at the door turns it on deliberately.
   */
  readonly acceptWhenClosed: boolean;
  readonly minPartySize: number;
  readonly maxPartySize: number;
  /** Estimate for the "roughly N minutes" quote. An estimate, and labelled as one. */
  readonly averageTurnMinutes: number;
  /** How long a called guest has to appear before being marked a no-show. */
  readonly callTimeoutMinutes: number;
  readonly customerNotice: string | null;
}

export const DEFAULT_WAITLIST_POLICY: WaitlistPolicy = {
  // Off by default: shipping the feature must not start queueing guests at a
  // shop that never asked for it.
  enabled: false,
  acceptWhenClosed: false,
  minPartySize: 1,
  maxPartySize: 10,
  averageTurnMinutes: 45,
  callTimeoutMinutes: 10,
  customerNotice: null,
};

/** Why a ticket ended without a seating. */
export const WAITLIST_REASON = {
  /** The guest cancelled from their own page. */
  GUEST_CANCELLED: 'GUEST_CANCELLED',
  /** The shop closed the queue, or turned the feature off, with them on it. */
  QUEUE_CLOSED: 'QUEUE_CLOSED',
  /** Called and never came. */
  CALL_TIMEOUT: 'CALL_TIMEOUT',
  /** The host gave up on them by hand. */
  HOST_MARKED_NO_SHOW: 'HOST_MARKED_NO_SHOW',
  /** The shop shut for the day with them still waiting. */
  SHOP_CLOSED: 'SHOP_CLOSED',
} as const;

export type WaitlistReason = (typeof WAITLIST_REASON)[keyof typeof WAITLIST_REASON];

const REASONS: readonly string[] = Object.values(WAITLIST_REASON);

export function isWaitlistReason(value: string): value is WaitlistReason {
  return REASONS.includes(value);
}
