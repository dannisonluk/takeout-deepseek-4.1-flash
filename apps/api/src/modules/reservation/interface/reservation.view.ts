import { ReservationPolicy, ReservationStatus } from '@takeout/domain';

/** One bookable start time. */
export interface ReservationSlotView {
  readonly startsAt: string;
  /** Seats still free at this start, after everything already booked. */
  readonly remaining: number;
  /** True when a party of the requested size fits. */
  readonly bookable: boolean;
}

/**
 * The booking page's read model.
 *
 * `notice` is prose, generated server-side. Everything else is data the page
 * needs to render the grid without a second call.
 */
export interface ReservationAvailabilityView {
  readonly timezone: string;
  readonly enabled: boolean;
  readonly acceptingNew: boolean;
  readonly customerNotice: string | null;
  readonly policy: {
    readonly slotMinutes: number;
    readonly turnMinutes: number;
    readonly minPartySize: number;
    readonly maxPartySize: number;
    readonly leadTimeMinutes: number;
    readonly advanceDays: number;
  };
  readonly windowStart: string;
  readonly windowEnd: string;
  /** The sentence to show above the grid. Never empty. */
  readonly notice: string;
  /**
   * 特別休息日 inside the window, as `YYYY-MM-DD`, ascending.
   *
   * Sent so the booking page can grey out the calendar instead of rendering an
   * empty grid with no reason given — "no slots" and "we are shut that day" are
   * different answers and the customer acts on them differently.
   */
  readonly closedDates: readonly string[];
  readonly slots: readonly ReservationSlotView[];
  readonly bookableCount: number;
}

/** The customer-facing projection. */
export interface CustomerReservationView {
  readonly id: string;
  readonly reservationNo: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly merchantSlug: string;
  readonly merchantTimezone: string;
  readonly status: ReservationStatus;
  readonly partySize: number;
  readonly startsAt: string;
  /** Merchant-local date (`YYYY-MM-DD`) — drives the day groupings. */
  readonly serviceDate: string;
  readonly customerName: string;
  readonly customerNote: string | null;
  readonly merchantNote: string | null;
  readonly statusReason: string | null;
  readonly confirmedAt: string | null;
  readonly seatedAt: string | null;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  /**
   * Whether the Cancel button should be rendered.
   *
   * Answered by `ReservationStateMachine` rather than the browser: a UI that
   * decided this from the status string would eventually offer a cancel the
   * server refuses, and the customer would read that as a bug.
   */
  readonly canCancel: boolean;
}

/**
 * The shop's projection — adds the phone number (which the customer already
 * knows, having typed it) and the transitions this actor may perform.
 */
export interface MerchantReservationView extends CustomerReservationView {
  readonly contactPhone: string;
  /** The turn length this booking holds, copied at booking time. */
  readonly turnMinutes: number;
  readonly version: number;
  /**
   * What the board may do next, split by actor — the buttons are rendered from
   * this list rather than from a hard-coded lifecycle in the front end.
   */
  readonly allowedNextTransitions: {
    readonly merchant: readonly ReservationStatus[];
    readonly system: readonly ReservationStatus[];
  };
}

/** The shop's settings screen. */
export interface ReservationSettingsView {
  readonly policy: ReservationPolicy;
  readonly customerNotice: string | null;
  readonly acceptingNew: boolean;
}

/** The creation response. */
export interface ReservationCreatedView {
  readonly id: string;
  readonly reservationNo: string;
  readonly merchantId: string;
  readonly merchantName: string;
  readonly status: ReservationStatus;
  readonly partySize: number;
  readonly startsAt: string;
  readonly serviceDate: string;
  readonly timezone: string;
  /** Verbatim from the shop's settings. `null` when they wrote none. */
  readonly customerNotice: string | null;
  /**
   * True when the shop's `autoConfirm` accepted this on their behalf, so the
   * page can say 「已確認」 rather than 「等待店家確認」 without a second poll.
   */
  readonly autoConfirmed: boolean;
}

/**
 * The result of a transition, as returned to whoever made it.
 *
 * NOTE the field name is `reservationId`, not `id` — it comes from
 * `TransitionReservationResult`, which both controllers spread verbatim
 * (`{ ...result, reservation }`) rather than re-mapping. That is why this
 * interface has to mirror the USE CASE's shape and not an invented one: an
 * earlier draft declared `id` here, and because nothing references this type at
 * the construction site there was no compile error anywhere — the frontend
 * simply read `transition.id` and got `undefined`.
 *
 * `contract-check.js` now compares this against a live response in both
 * directions, which is what caught it.
 */
export interface ReservationTransitionView {
  readonly reservationId: string;
  readonly reservationNo: string;
  readonly fromStatus: ReservationStatus;
  readonly toStatus: ReservationStatus;
  readonly occurredAt: string;
  /** Obligations the API discharged; useful in the merchant's activity log. */
  readonly sideEffects: readonly string[];
  readonly allowedNextTransitions: readonly ReservationStatus[];
  readonly reservation: MerchantReservationView | CustomerReservationView;
}
