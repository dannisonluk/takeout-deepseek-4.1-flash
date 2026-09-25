/**
 * The API contract, mirrored.
 *
 * These are hand-written rather than generated because the API's views are
 * hand-written too, and a generator would happily produce a type for a field
 * nobody meant to expose. Each interface here has a one-to-one counterpart in
 * `apps/api/src/**\/interface/*.views.ts`; when one moves, both move.
 *
 * Money is ALWAYS `*Minor`: an integer count of cents. Nothing in this app is
 * allowed to do arithmetic on a formatted string.
 */

// ---------------------------------------------------------------------------
//  Enums — string unions, matching the Prisma enums
// ---------------------------------------------------------------------------

export type UserRole = 'CUSTOMER' | 'MERCHANT_OWNER' | 'MERCHANT_STAFF' | 'ADMIN';

export type MerchantStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export type MenuItemAvailability = 'AVAILABLE' | 'SOLD_OUT' | 'HIDDEN';

/** The lifecycle, in order. See `packages/domain/src/order/order-status.ts`. */
export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY_FOR_PICKUP'
  | 'COMPLETED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED';

export type PaymentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED';

/**
 * How the customer intends to pay.
 *
 * `PAY_AT_STORE` is a real choice, not a fallback: the order waits for the
 * merchant to confirm receipt and no card intent is ever opened for it.
 */
export type PaymentMode = 'ONLINE' | 'PAY_AT_STORE';

/** The one sentence to show next to an order's status. Built by the API. */
export interface PickupNotice {
  tone: 'info' | 'ok' | 'warn' | 'danger';
  title: string;
  message: string;
}

export type RefundStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type PayoutStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED';

export type OutboxStatus = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'DEAD_LETTER';

export type MerchantAdminAction = 'APPROVE' | 'SUSPEND' | 'REINSTATE' | 'CLOSE';

/**
 * 預約訂位's lifecycle.
 *
 * `PENDING` / `CONFIRMED` / `SEATED` are *active* — they hold seats. The other
 * four are terminal and have released them. The split matters on every screen
 * in this feature, so it lives next to the union rather than being re-derived
 * from a status string in each page.
 */
export type ReservationStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'SEATED'
  | 'COMPLETED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'NO_SHOW';

/** Who drove a transition. Used for the merchant's activity log. */
export type ReservationActor = 'CUSTOMER' | 'MERCHANT' | 'SYSTEM' | 'ADMIN';

// ---------------------------------------------------------------------------
//  Auth
// ---------------------------------------------------------------------------

export interface AuthProfile {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  role: UserRole;
  locale: string;
  /** Merchants this principal may act for — the same list in the JWT. */
  merchantIds: string[];
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: AuthProfile;
}

export interface OtpRequested {
  phone: string;
  expiresInSeconds: number;
  retryAfterSeconds: number;
  /** Only returned outside production. Shown in the UI as a dev convenience. */
  devCode?: string;
}

// ---------------------------------------------------------------------------
//  Merchants & menu
// ---------------------------------------------------------------------------

export interface OperatingHour {
  /** 0 = Sunday … 6 = Saturday. */
  dayOfWeek: number;
  opensAtMinute: number;
  closesAtMinute: number;
  isClosed: boolean;
}

export interface MenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  nameEn: string | null;
  description: string | null;
  imageKey: string | null;
  imageBlurhash: string | null;
  priceMinor: number;
  currency: string;
  /** Drives the per-item platform fee. Changing it changes what the merchant banks. */
  isMainItem: boolean;
  availability: MenuItemAvailability;
  dailyQuota: number | null;
  /** `quota - sold - held` for the current service day. `null` = unlimited. */
  remainingToday: number | null;
  prepTimeMinutes: number | null;
  sortOrder: number;
}

export interface MenuCategory {
  id: string;
  name: string;
  nameEn: string | null;
  sortOrder: number;
  isActive: boolean;
  items: MenuItem[];
}

/** List projection — what a discovery card needs. */
export interface MerchantSummary {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  status: MerchantStatus;
  district: string | null;
  region: string;
  addressLine1: string;
  latitude: number;
  longitude: number;
  logoKey: string | null;
  coverImageKey: string | null;
  prepTimeMinutes: number;
  pickupWindowMinutes: number;
  acceptsOrders: boolean;
  ratingAvg: number | null;
  ratingCount: number;
  distanceKm: number | null;
}

export interface MerchantDetail extends MerchantSummary {
  phone: string | null;
  addressLine2: string | null;
  timezone: string;
  acceptTimeoutMinutes: number;
  autoAcceptOrders: boolean;
  hours: OperatingHour[];
  categories: MenuCategory[];
}

/** Owner-facing: the raw row, including what customers must not see. */
export interface OwnedMerchant {
  id: string;
  slug: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  status: MerchantStatus;
  acceptsOrders: boolean;
  autoAcceptOrders: boolean;
  phone: string | null;
  district: string | null;
  region: string;
  addressLine1: string;
  addressLine2: string | null;
  latitude: number;
  longitude: number;
  logoKey: string | null;
  coverImageKey: string | null;
  prepTimeMinutes: number;
  pickupWindowMinutes: number;
  acceptTimeoutMinutes: number;
  timezone: string;
  ratingAvg: number | null;
  ratingCount: number;
  isOwner: boolean;
  hours: OperatingHour[];
}

export interface OwnerMenu {
  merchantId: string;
  /** Merchant-local service date the `remainingToday` figures belong to. */
  serviceDate: string;
  categories: MenuCategory[];
  /** Items with no category. A real bucket, not a synthetic category. */
  uncategorised: MenuItem[];
  totals: { categories: number; items: number; mainItems: number };
}

export interface PickupSlot {
  startAt: string;
  endAt: string;
  /** `HH:mm` in the merchant's timezone. */
  label: string;
  /** 0 = today, 1 = tomorrow … Drives the group headers. */
  dayOffset: number;
}

export interface PickupSlots {
  merchantId: string;
  timezone: string;
  stepMinutes: number;
  windowMinutes: number;
  earliestAt: string;
  latestAt: string;
  /** Inside opening hours right now — enables 即時製作. */
  acceptingNow: boolean;
  /**
   * Why not, when `acceptingNow` is false. `null` when the shop is open.
   *
   * One of `NO_HOURS_CONFIGURED` | `CLOSED_TODAY` | `CLOSED_FOR_CLOSURE` |
   * `OUTSIDE_HOURS`. Shown as a distinct line per reason rather than a generic
   * 「暫停接單」: a rest day the shop planned is not the same thing as closing
   * time, and confusing the two makes the shop look broken.
   */
  closedReason: string | null;
  /**
   * The first 特別休息日 inside the 24-hour booking horizon, `YYYY-MM-DD`, or
   * `null`. Singular on purpose — the banner names one date.
   */
  closureDate: string | null;
  slots: PickupSlot[];
}

// ---- 特別休息日 ------------------------------------------------------------

/** The reasons the shop can give. Mirrors the API enum exactly. */
export type ClosureReason =
  | 'PUBLIC_HOLIDAY'
  | 'STAFF_HOLIDAY'
  | 'PRIVATE_EVENT'
  | 'MAINTENANCE'
  | 'OTHER';

/** Label shown in the picker. The order is the order they are offered in. */
export const CLOSURE_REASON_LABELS: { value: ClosureReason; label: string }[] = [
  { value: 'PUBLIC_HOLIDAY', label: '公眾假期' },
  { value: 'STAFF_HOLIDAY', label: '員工休假' },
  { value: 'PRIVATE_EVENT', label: '包場活動' },
  { value: 'MAINTENANCE', label: '維修保養' },
  { value: 'OTHER', label: '其他' },
];

/** One dated rest day, as the merchant's rest-day screen reads it. */
export interface MerchantClosure {
  id: string;
  /** Merchant-local `YYYY-MM-DD`. */
  serviceDate: string;
  reason: ClosureReason;
  note: string | null;
  /**
   * When the auto-cancel sweep last ran. `null` means "not yet" — a day in the
   * past still showing `null` means the sweep never completed.
   */
  cancelledReservationsAt: string | null;
  cancelledReservationCount: number;
  createdAt: string;
}

/** What saving a rest day reports about the bookings it cancelled. */
export interface ClosureWriteResult {
  closure: MerchantClosure;
  /** Bookings cancelled by this call. `0` when the latch was already set. */
  cancelledReservations: number;
  /** True when a previous save had already swept this date. */
  alreadySwept: boolean;
  /** Active bookings still on the closed day after a capped sweep. */
  remainingActive: number;
  /** Prose for the banner, built server-side so the numbers cannot drift. */
  message: string;
}

export interface SetClosureInput {
  reason: ClosureReason;
  note?: string | null;
}

export interface DistrictCount {
  district: string;
  count: number;
}

export interface Paged<T> {
  data: T[];
  total: number;
}

// ---------------------------------------------------------------------------
//  Orders
// ---------------------------------------------------------------------------

export interface OrderLine {
  menuItemId: string | null;
  nameSnapshot: string;
  imageKeySnapshot: string | null;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  isMainItem: boolean;
}

export interface OrderCreated {
  id: string;
  orderNo: string;
  pickupCode: string | null;
  status: OrderStatus;
  paymentMode: PaymentMode;
  scheduledPickupAt: string | null;
  /** The pre-order estimate. The merchant's promise supersedes it. */
  estimatedReadyAt: string;
  /** What the confirmation screen must show. Never re-word it client-side. */
  pickupNotice: PickupNotice | null;
  currency: string;
  items: OrderLine[];
  pricing: {
    mainItemCount: number;
    subtotalMinor: number;
    platformFeeMinor: number;
    paymentProcessingFeeMinor: number;
    customerServiceFeeMinor: number;
    totalMinor: number;
    merchantPayoutMinor: number;
  };
}

/** Customer projection. Commission split is deliberately absent. */
export interface CustomerOrder {
  id: string;
  orderNo: string;
  pickupCode: string | null;
  merchantId: string;
  merchantName: string;
  merchantSlug: string;
  /** The merchant's clock. Every time on this order must be rendered in it. */
  merchantTimezone: string;
  status: OrderStatus;
  fulfilmentMode: string;
  paymentMode: PaymentMode;
  /** What the customer asked for. `null` = 即時製作. */
  scheduledPickupAt: string | null;
  /** What the merchant promised. `null` until they confirm. */
  estimatedReadyAt: string | null;
  readyInMinutes: number | null;
  merchantNote: string | null;
  pickupNotice: PickupNotice | null;
  createdAt: string;
  items: OrderLine[];
  totalMinor: number;
  currency: string;
  customerNote: string | null;
  /**
   * Every refund ticket filed against this order, newest first.
   *
   * Present so the order page can offer 「申請退款」 without a second request,
   * and — more importantly — can tell "no ticket yet" from "one is already
   * open". The latter must not show a button: filing again is a 409 the
   * customer would read as a bug.
   */
  refundRequests: OrderRefundSummary[];
}

/** One ticket, as the order page needs it. The full ticket lives at /refunds/:id. */
export interface OrderRefundSummary {
  id: string;
  status: RefundRequestStatus;
  reasonCode: RefundReasonCode;
  requestedAmountMinor: number | null;
  createdAt: string;
}

/** Merchant projection — adds the money split, because the merchant is settled. */
export interface MerchantOrder extends CustomerOrder {
  subtotalMinor: number;
  platformFeeMinor: number;
  paymentFeeMinor: number;
  merchantPayoutMinor: number;
  mainItemCount: number;
  acceptDeadlineAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
}

export interface PaymentIntent {
  orderId: string;
  orderNo: string;
  provider: string;
  providerRef: string;
  clientSecret: string | null;
  redirectUrl: string | null;
  status: 'REQUIRES_ACTION' | 'PENDING' | 'AUTHORIZED' | 'CAPTURED';
  amountMinor: number;
  currency: string;
  /** Non-null when no real PSP was contacted. Must be shown, never swallowed. */
  notice: string | null;
}

// ---------------------------------------------------------------------------
//  Admin
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  locale: string;
  lastLoginAt: string | null;
  createdAt: string;
  ownedMerchantCount: number;
  staffMerchantCount: number;
  orderCount: number;
  activeSessionCount: number;
}

export interface AdminMerchantStats {
  menuItems: number;
  categories: number;
  activeOrders: number;
  totalOrders: number;
  pendingPayoutMinor: number;
  lifetimeGmvMinor: number;
}

export interface AdminMerchant extends Omit<OwnedMerchant, 'isOwner'> {
  createdAt: string;
  owner: { id: string; displayName: string; phone: string | null; email: string | null } | null;
  stats: AdminMerchantStats;
  /**
   * Derived from the same table that validates the write, so the console can
   * never offer a button the API would reject. Empty means terminal.
   */
  allowedActions: MerchantAdminAction[];
  /**
   * 商戶營業報表 — the reporting plan, read from the same projection the tier
   * write returns so the console's select cannot disagree with what was stored.
   */
  analytics: AnalyticsTierView;
}

export interface AdminOrderSummary {
  id: string;
  orderNo: string;
  pickupCode: string | null;
  status: OrderStatus;
  createdAt: string;
  serviceDate: string;
  scheduledPickupAt: string | null;
  currency: string;
  subtotalMinor: number;
  platformFeeMinor: number;
  totalMinor: number;
  merchantPayoutMinor: number;
  mainItemCount: number;
  itemCount: number;
  paidMinor: number;
  refundedMinor: number;
  customer: { id: string; displayName: string; phone: string | null; email: string | null } | null;
  merchant: { id: string; slug: string; name: string } | null;
}

export interface AdminPayment {
  id: string;
  provider: string;
  status: PaymentStatus;
  providerRef: string | null;
  amountMinor: number;
  processingFeeMinor: number;
  currency: string;
  failureCode: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  createdAt: string;
  refundedMinor: number;
}

export interface AdminRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  reason: string;
  status: RefundStatus;
  providerRef: string | null;
  requestedBy: string;
  createdAt: string;
  settledAt: string | null;
}

export interface AdminOrderEvent {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actor: string;
  actorName: string | null;
  reason: string | null;
  sideEffects: string[];
  createdAt: string;
}

export interface AdminOrder {
  id: string;
  orderNo: string;
  pickupCode: string | null;
  status: OrderStatus;
  fulfilmentMode: string;
  priority: string;
  createdAt: string;
  serviceDate: string;
  scheduledPickupAt: string | null;
  prepTimeMinutes: number;
  acceptDeadlineAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  currency: string;
  subtotalMinor: number;
  platformFeeMinor: number;
  paymentFeeMinor: number;
  customerServiceFeeMinor: number;
  totalMinor: number;
  merchantPayoutMinor: number;
  mainItemCount: number;
  pricingSnapshot: {
    currency: string;
    totalMinor: number;
    mainItemCount: number;
    subtotalMinor: number;
    platformFeeMinor: number;
    /**
     * Only `paymentProcessingFeeMinor` exists — the admin view spells the
     * payment fee out in full because it is the *platform's* view of a fee the
     * customer never sees, unlike `AdminPayment.processingFeeMinor`. There is no
     * short alias; an earlier draft of this file declared one and the contract
     * check caught it.
     */
    paymentProcessingFeeMinor: number;
    customerServiceFeeMinor: number;
    merchantPayoutMinor: number;
    appliedPolicy: {
      feePerMainItemMinor: number;
      paymentFeeRateBps: number;
      paymentFeeFixedMinor: number;
      countAddOnItems: boolean;
    };
  };
  customerNote: string | null;
  contactPhone: string | null;
  customer: { id: string; displayName: string; phone: string | null; email: string | null } | null;
  merchant: { id: string; slug: string; name: string } | null;
  items: OrderLine[];
  payments: AdminPayment[];
  refunds: AdminRefund[];
  statusEvents: AdminOrderEvent[];
  allowedAdminTransitions: OrderStatus[];
}

export interface AdminPayout {
  id: string;
  merchantId: string;
  merchantName: string;
  merchantSlug: string;
  status: PayoutStatus;
  periodStart: string;
  periodEnd: string;
  currency: string;
  grossSubtotalMinor: number;
  platformFeeMinor: number;
  paymentFeeMinor: number;
  netPayoutMinor: number;
  orderCount: number;
  lineCount: number;
  reference: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface ReconciliationRow {
  merchantId: string;
  merchantName: string;
  serviceDate: string;
  ordersPlatformFeeMinor: number;
  payoutPlatformFeeMinor: number;
  deltaMinor: number;
  unsettledOrders: number;
}

export interface Reconciliation {
  from: string;
  to: string;
  rows: ReconciliationRow[];
  totalDeltaMinor: number;
  mismatchedDays: number;
}

export interface PlatformConfigEntry {
  key: string;
  value: number | boolean | string | null;
  valueType: 'number' | 'boolean';
  description: string;
  hasOverride: boolean;
  updatedAt: string | null;
  updatedById: string | null;
  updatedByName: string | null;
  /** True when the pricing engine reads this key. */
  isPricingKey: boolean;
  /** `pricing` | `cancellation` — which live policy consumes this key. */
  namespace: string;
  /** The env / code value that applies when there is no override. */
  fallback: number | boolean;
  /** What is actually in force right now. */
  effectiveValue: number | boolean;
}

export interface PricingPolicy {
  platformFee: {
    feePerMainItemMinor: number;
    currency: string;
    countAddOnItems: boolean;
  };
  paymentFee: { rateBps: number; fixedMinor: number; chargeOn: string };
  customerServiceFeeMinor: number;
  minimumPayoutMinor: number;
  /** Which layer supplied the live policy. */
  source: 'platform_config' | 'environment' | 'runtime';
}

export interface DashboardStats {
  generatedAt: string;
  merchants: {
    total: number;
    active: number;
    pendingReview: number;
    suspended: number;
    closed: number;
    acceptingOrders: number;
  };
  orders: {
    today: number;
    todayGmvMinor: number;
    todayPlatformFeeMinor: number;
    todayPayoutMinor: number;
    active: number;
    byStatus: Record<string, number>;
  };
  users: {
    total: number;
    customers: number;
    merchantUsers: number;
    admins: number;
    disabled: number;
    activeToday: number;
  };
  payouts: { pendingCount: number; pendingNetMinor: number; paidLast30DaysMinor: number };
  ops: {
    outboxPending: number;
    outboxFailed: number;
    outboxDeadLetter: number;
    redisConnected: boolean;
    oldestPendingAt: string | null;
  };
  pricing: PricingPolicy;
}

export interface AdminOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  version: number;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  availableAt: string;
  publishedAt: string | null;
  createdAt: string;
}

export interface AdminOutboxStats {
  byStatus: Record<string, number>;
  oldestPendingAt: string | null;
  /** The symptom of a stuck relay. A count alone cannot show it. */
  oldestPendingAgeSeconds: number | null;
  deadLetterCount: number;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
//  Requests
// ---------------------------------------------------------------------------

export interface PlaceOrderInput {
  merchantId: string;
  items: { menuItemId: string; quantity: number }[];
  scheduledPickupAt?: string;
  customerNote?: string;
  contactPhone?: string;
  fulfilmentMode?: 'SELF_PICKUP' | 'DELIVERY';
  /** Omit for the default (`ONLINE`). */
  paymentMode?: PaymentMode;
}

/** What `POST /merchant/:id/orders/:orderId/confirm` returns. */
export interface ConfirmOrderResult {
  orderId: string;
  orderNo: string;
  /** `true` when this call also recorded the counter payment. */
  settledOffline: boolean;
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  estimatedReadyAt: string | null;
  readyInMinutes: number | null;
  allowedNextTransitions: OrderStatus[];
}

export interface CreateMenuItemInput {
  categoryId?: string | null;
  name: string;
  nameEn?: string;
  description?: string;
  priceMinor: number;
  isMainItem?: boolean;
  availability?: MenuItemAvailability;
  dailyQuota?: number | null;
  prepTimeMinutes?: number | null;
  sortOrder?: number;
}

export interface CreateMerchantInput {
  slug: string;
  name: string;
  nameEn?: string;
  description?: string;
  phone?: string;
  addressLine1: string;
  addressLine2?: string;
  district?: string;
  region?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  prepTimeMinutes?: number;
  pickupWindowMinutes?: number;
}

/**
 * `PATCH /v1/merchant/:merchantId`.
 *
 * A superset of the create input: the settings screen can change fields an
 * applicant never fills in (the accept timeout, auto-accept) and the merchant's
 * own logo/cover keys. `slug` is absent on purpose — it is the permanent public
 * URL, and renaming it would break every shared link, so the API does not
 * accept it here either.
 */
export interface UpdateMerchantInput extends Partial<Omit<CreateMerchantInput, 'slug'>> {
  acceptTimeoutMinutes?: number;
  autoAcceptOrders?: boolean;
  logoKey?: string;
  coverImageKey?: string;
}

// ---------------------------------------------------------------------------
//  預約訂位 — mirrors `apps/api/src/modules/reservation/interface/reservation.view.ts`
// ---------------------------------------------------------------------------

/**
 * The tunable shape of a shop's reservation book.
 *
 * Same nine fields as `ReservationPolicy` in `packages/domain`. The front end
 * reads it to render the settings form and to label the booking grid; it never
 * decides anything with it — every rule is enforced server-side, and the UI
 * mirrors rather than re-implements.
 */
export interface ReservationPolicy {
  /** The book is off until the shop turns it on. */
  enabled: boolean;
  /** Accept bookings without the shop having to confirm each one. */
  autoConfirm: boolean;
  /** Start times fall on this grid, in minutes from the hour. */
  slotMinutes: number;
  /** How long a table is held for one party. */
  turnMinutes: number;
  /** Seats available at each start time — not tables. */
  seatsPerSlot: number;
  minPartySize: number;
  maxPartySize: number;
  /** Cannot book sooner than this from now. */
  leadTimeMinutes: number;
  /** Cannot book further ahead than this. */
  advanceDays: number;
}

/** One bookable start time on the grid. */
export interface ReservationSlot {
  /** The UTC instant to send back as `startsAt`. */
  startsAt: string;
  /** Seats still free at this start, after everything already booked. */
  remaining: number;
  /** True when a party of the requested size fits. */
  bookable: boolean;
}

/**
 * The booking page's whole read model — grid, policy and prose in one call.
 *
 * `notice` is generated server-side and is never empty, so the page has nothing
 * to invent when the book is closed or paused.
 *
 * Note the shape of `policy`: it is NOT the full `ReservationPolicy`. The API
 * strips `enabled`, `autoConfirm` and `seatsPerSlot` from it for this endpoint
 * and hoists what a customer may know to the top level (`enabled`,
 * `acceptingNew`). The seat count in particular is deliberately absent — a
 * customer has no business reading the shop's capacity, only whether their own
 * party fits, which is what each slot's `bookable` flag answers.
 */
export interface ReservationAvailability {
  timezone: string;
  /** The shop has reservations switched on at all. */
  enabled: boolean;
  /** Switched on, but not taking new bookings right now (paused / not ACTIVE). */
  acceptingNew: boolean;
  /** The shop's own prose, verbatim. `null` when they wrote none. */
  customerNotice: string | null;
  policy: {
    slotMinutes: number;
    turnMinutes: number;
    minPartySize: number;
    maxPartySize: number;
    leadTimeMinutes: number;
    advanceDays: number;
  };
  /** The window these slots cover, as instants. */
  windowStart: string;
  windowEnd: string;
  /** The sentence to show above the grid. Never empty. */
  notice: string;
  /**
   * 特別休息日 inside the window, as `YYYY-MM-DD`, ascending.
   *
   * Present so the booking page can grey out the calendar rather than showing
   * an empty grid with no explanation — "no slots" and "we are shut that day"
   * are different answers.
   */
  closedDates: string[];
  slots: ReservationSlot[];
  bookableCount: number;
}

/** What the customer sees of one booking. */
export interface CustomerReservation {
  id: string;
  reservationNo: string;
  merchantId: string;
  merchantName: string;
  merchantSlug: string;
  merchantTimezone: string;
  status: ReservationStatus;
  partySize: number;
  startsAt: string;
  /** Merchant-local date (`YYYY-MM-DD`) — drives the day groupings. */
  serviceDate: string;
  customerName: string;
  customerNote: string | null;
  merchantNote: string | null;
  statusReason: string | null;
  confirmedAt: string | null;
  seatedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  /**
   * Whether to render the Cancel button.
   *
   * Answered by the server's state machine. Deciding this from `status` in the
   * browser would eventually offer a cancel the API then refuses, and the
   * customer would read that as a bug.
   */
  canCancel: boolean;
}

/** The shop's projection of one booking. */
export interface MerchantReservation extends CustomerReservation {
  contactPhone: string;
  /** The turn length this booking holds, copied at booking time. */
  turnMinutes: number;
  version: number;
  /**
   * What the board may do next, split by actor.
   *
   * The action buttons are rendered FROM this list rather than from a
   * hard-coded lifecycle here — which is exactly what stops a button appearing
   * that the server would refuse.
   */
  allowedNextTransitions: {
    merchant: ReservationStatus[];
    system: ReservationStatus[];
  };
}

/** The shop's settings screen. */
export interface ReservationSettings {
  policy: ReservationPolicy;
  customerNotice: string | null;
  /** Mirrors the policy flag, but is what the merchant's toggle writes. */
  acceptingNew: boolean;
}

/** What `POST /reservations` returns. */
export interface ReservationCreated {
  id: string;
  reservationNo: string;
  merchantId: string;
  merchantName: string;
  status: ReservationStatus;
  partySize: number;
  startsAt: string;
  serviceDate: string;
  timezone: string;
  /** Verbatim from the shop's settings. `null` when they wrote none. */
  customerNotice: string | null;
  /**
   * True when `autoConfirm` accepted this on the shop's behalf — lets the
   * confirmation panel say 「已確認」 without a second poll.
   */
  autoConfirmed: boolean;
}

/**
 * The result of any transition.
 *
 * The id field is `reservationId`, NOT `id` — both controllers return the use
 * case's `TransitionReservationResult` verbatim. This was wrong in the first
 * draft and nothing caught it: the API side declared its own view type but
 * never referenced it when building the response, so there was no compile error
 * on either side. `contract-check.js` compares a live transition response in
 * both directions and now guards it.
 */
export interface ReservationTransition {
  reservationId: string;
  reservationNo: string;
  fromStatus: ReservationStatus;
  toStatus: ReservationStatus;
  /** When the transition was recorded. */
  occurredAt: string;
  /** Obligations the API discharged, e.g. `RELEASE_SLOT_SEATS`. */
  sideEffects: string[];
  /** The actor's next legal moves, after this transition. */
  allowedNextTransitions: ReservationStatus[];
  reservation: MerchantReservation | CustomerReservation;
}

/** `GET /reservations` and `GET /merchant/:id/reservations` both cursor by `hasMore`. */
export interface ReservationPage<T> {
  data: T[];
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
//  退款申請工單 (refund-request tickets)
// ---------------------------------------------------------------------------

/**
 * A refund ticket's lifecycle.
 *
 * **There is deliberately no `REFUNDED` status.** The platform is booking-only:
 * the customer opens the complaint here, and the shop and the customer settle it
 * between themselves. `RESOLVED_OFFLINE` records what the shop *says* it handed
 * over — it is a claim the platform never verified and never processed. If this
 * union ever grows a `REFUNDED`, the platform is asserting something it cannot
 * know, and the shop's books become wrong.
 */
export type RefundRequestStatus =
  | 'OPEN'
  | 'IN_DISCUSSION'
  | 'RESOLVED_OFFLINE'
  | 'DECLINED'
  | 'CANCELLED';

/** Why the customer says they want money back. A closed list, for triage. */
export type RefundReasonCode =
  | 'NEVER_RECEIVED'
  | 'WRONG_ITEM'
  | 'QUALITY'
  | 'LATE'
  | 'DUPLICATE_CHARGE'
  | 'OTHER';

/** One refund ticket, as the customer sees it. */
export interface CustomerRefundRequest {
  id: string;
  orderId: string;
  orderNo: string;
  merchantId: string;
  status: RefundRequestStatus;
  reasonCode: RefundReasonCode;
  /** The customer's ask, in minor units. Advisory — the shop decides. */
  requestedAmountMinor: number | null;
  orderTotalMinor: number;
  currency: string;
  customerNote: string | null;
  /** The shop's reply, shown verbatim. */
  merchantNote: string | null;
  /**
   * What the shop says it handed back. **A claim, not a settlement record** —
   * the UI must not render this as "refunded by the platform".
   */
  settledAmountMinor: number | null;
  settlementReference: string | null;
  resolvedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The only move the customer normally has is withdrawing. From the server. */
  allowedNextTransitions: RefundRequestStatus[];
}

/** The shop's projection — adds who is talking and what the order now says. */
export interface MerchantRefundRequest extends CustomerRefundRequest {
  customerId: string;
  customerName: string;
  /** The order's current status, denormalised so the queue needs no join. */
  orderStatus: string;
  version: number;
}

/** The shop's queue plus the per-tab counts. Complete map — absent = 0. */
export interface MerchantRefundQueue {
  data: MerchantRefundRequest[];
  total: number;
  counts: Record<RefundRequestStatus, number>;
}

export interface CustomerRefundPage {
  data: CustomerRefundRequest[];
  total: number;
}

export interface AdminRefundPage {
  data: MerchantRefundRequest[];
  total: number;
}

/** The result of moving one ticket. The field is `refundRequestId`, not `id`. */
export interface RefundTransition<T = MerchantRefundRequest> {
  refundRequestId: string;
  orderId: string;
  orderNo: string;
  fromStatus: RefundRequestStatus;
  toStatus: RefundRequestStatus;
  occurredAt: string;
  /** e.g. `NOTIFY_CUSTOMER`. Never anything money-shaped. */
  sideEffects: string[];
  allowedNextTransitions: RefundRequestStatus[];
  refundRequest: T;
}

export interface FileRefundRequestInput {
  reasonCode: RefundReasonCode;
  /** Advisory ask in minor units. Must be ≤ the order total. */
  requestedAmountMinor?: number;
  /** Required when `reasonCode` is `OTHER`. */
  note?: string;
}

export interface TransitionRefundRequestInput {
  to: RefundRequestStatus;
  merchantNote?: string;
  /** Only meaningful for `RESOLVED_OFFLINE`. A claim. */
  settledAmountMinor?: number;
  settlementReference?: string;
}

// --- Requests ---------------------------------------------------------------

/**
 * `POST /reservations`.
 *
 * `startsAt` is the ISO instant taken verbatim from the chosen slot — the grid
 * already holds the exact boundary, so the page never re-derives a local time.
 */
export interface PlaceReservationInput {
  merchantId: string;
  startsAt: string;
  partySize: number;
  customerName: string;
  contactPhone: string;
  /** Allergies, a high chair, a birthday. */
  customerNote?: string;
  /** Echoed back from the availability response; the API ignores it. */
  merchantSlug?: string;
}

/** The optional prose on any merchant transition. */
export interface ReservationReasonInput {
  reason?: string;
  /** The shop's reply to the customer, shown verbatim. */
  merchantNote?: string;
}

/**
 * `PUT /merchant/:id/reservations/settings`.
 *
 * A whole-object replace, but every field is optional on the wire so the form
 * can send only what it changed. `customerNotice: null` clears it.
 */
export interface UpdateReservationSettingsInput {
  enabled?: boolean;
  autoConfirm?: boolean;
  slotMinutes?: number;
  turnMinutes?: number;
  seatsPerSlot?: number;
  minPartySize?: number;
  maxPartySize?: number;
  leadTimeMinutes?: number;
  advanceDays?: number;
  customerNotice?: string | null;
}

// ============================================================================
//  商戶營業報表 — BI entitlement + the report (Task #20)
// ============================================================================

/**
 * Hand-mirrored from `AnalyticsTier` in `@takeout/domain`.
 *
 * Kept as a string union rather than imported: this file is the ONE place the
 * web app's view of the API is written down, and it deliberately does not
 * depend on the domain package — the browser bundle should not carry the whole
 * state machine to render a label.
 */
export type AnalyticsTier = 'NONE' | 'BASIC' | 'PRO';

/** The capability names a tier unlocks. Mirrors `AnalyticsCapability`. */
export type AnalyticsCapability =
  | 'DAILY_ROLLUP'
  | 'ITEM_MIX'
  | 'HOUR_OF_DAY'
  | 'COMPARISON'
  | 'CHANNEL_MIX';

/**
 * The user-facing marker for what a shop has bought.
 *
 * `canExportRawData` is always `true` and is carried in the response rather
 * than assumed, so the page cannot hide the export button on a free shop. The
 * one thing a `NONE` merchant must be able to do is take their own data out.
 */
export interface AnalyticsTierView {
  tier: AnalyticsTier;
  /** 標準 / 進階報表 / 專業報表. */
  label: string;
  blurb: string;
  /** True for BASIC and PRO — drives the badge. */
  isPaid: boolean;
  capabilities: AnalyticsCapability[];
  canExportRawData: boolean;
}

export interface AnalyticsDailyRow {
  /** Merchant-local `YYYY-MM-DD`. */
  date: string;
  orderCount: number;
  voidCount: number;
  revenueMinor: number;
  platformFeeMinor: number;
  payoutMinor: number;
  averageOrderValueMinor: number;
}

export interface AnalyticsItemRow {
  name: string;
  quantity: number;
  revenueMinor: number;
  isMainItem: boolean;
}

export interface AnalyticsHourRow {
  hour: number;
  orderCount: number;
  revenueMinor: number;
}

export interface AnalyticsChannelRow {
  key: string;
  orderCount: number;
  revenueMinor: number;
}

export interface MerchantAnalytics {
  merchantId: string;
  tier: AnalyticsTierView;
  /** `to` is inclusive. */
  window: { from: string; to: string; days: number };
  totals: {
    orderCount: number;
    voidCount: number;
    revenueMinor: number;
    platformFeeMinor: number;
    payoutMinor: number;
    averageOrderValueMinor: number;
    itemCount: number;
  };
  /**
   * The previous, equal-length window. `null` on a tier without `COMPARISON`,
   * which is the whole difference between BASIC and PRO.
   */
  comparison: {
    label: string;
    from: string;
    to: string;
    revenueChangePercent: number | null;
    orderCountChangePercent: number | null;
    averageOrderValueChangePercent: number | null;
  } | null;
  /**
   * Empty arrays rather than missing keys on a tier that lacks the capability —
   * an empty `daily` and an absent one render differently in `.map()`.
   */
  daily: AnalyticsDailyRow[];
  itemMix: AnalyticsItemRow[];
  hourOfDay: AnalyticsHourRow[];
  channels: AnalyticsChannelRow[];
}

export interface AnalyticsTierWriteResult {
  merchantId: string;
  before: AnalyticsTierView;
  after: AnalyticsTierView;
  /** True when capabilities were taken away. */
  isDowngrade: boolean;
  /** What the operator is warned about before confirming. `null` otherwise. */
  warning: string | null;
  message: string;
}

// ============================================================================
//  現場候位 — the walk-in queue (Task #21)
// ============================================================================

export type WaitlistStatus = 'WAITING' | 'CALLED' | 'SEATED' | 'NO_SHOW' | 'CANCELLED';

/**
 * A guest's own ticket.
 *
 * Deliberately small: this is what one person reads on a phone, one-handed,
 * possibly walking. It carries no other party's name or number.
 */
export interface CustomerQueueTicket {
  id: string;
  /** `A-014` — the number the guest was told. */
  ticketNo: string;
  status: WaitlistStatus;
  /** 候位中 / 已叫號 / 已入座 — pre-labelled server-side. */
  statusLabel: string;
  partySize: number;
  guestName: string;
  joinedAt: string;
  /** 1-based among tickets still ahead or equal. `0` once the ticket ended. */
  position: number;
  ahead: number;
  /** `null` when it cannot be estimated — deliberately not `0`. */
  estimatedWaitMinutes: number | null;
  /** What the guest was quoted when they joined. */
  quotedMinutes: number | null;
  calledAt: string | null;
  /** Deadline to appear after being called — drives the countdown. */
  callDeadlineAt: string | null;
  seatedAt: string | null;
  cancelledAt: string | null;
  statusReason: string | null;
  canCancel: boolean;
  customerNotice: string | null;
}

/** The whole take-a-number page payload for one merchant. */
export interface CustomerQueueEntryPoint {
  merchantId: string;
  merchantName: string;
  merchantSlug: string;
  timezone: string;
  /** False hides the entry point entirely. */
  enabled: boolean;
  /** False while the shop is shut and does not take tickets when shut. */
  acceptingNow: boolean;
  /**
   * `'CLOSED'` when the shop is shut, `'DISABLED'` when the feature is off.
   * Two values, not a boolean, because the guest takes a different action.
   */
  closedReason: 'CLOSED' | 'DISABLED' | null;
  policy: {
    minPartySize: number;
    maxPartySize: number;
    averageTurnMinutes: number;
    callTimeoutMinutes: number;
  };
  customerNotice: string | null;
  queueLength: number;
  estimatedWaitMinutes: number;
  myTicket: CustomerQueueTicket | null;
}

/** One row of the host board. */
export interface MerchantQueueEntry {
  id: string;
  ticketNo: string;
  status: WaitlistStatus;
  statusLabel: string;
  statusShortLabel: string;
  partySize: number;
  guestName: string;
  contactPhone: string;
  note: string | null;
  joinedAt: string;
  position: number;
  ahead: number;
  estimatedWaitMinutes: number | null;
  calledAt: string | null;
  callDeadlineAt: string | null;
  seatedAt: string | null;
  cancelledAt: string | null;
  statusReason: string | null;
  waitedMinutes: number;
  version: number;
  /**
   * What the host may do next, computed by the same state machine the write
   * path uses. Rendering buttons from this rather than a hand-written table is
   * what stops the board offering a move the server would refuse.
   */
  allowedNextTransitions: WaitlistStatus[];
}

export interface MerchantQueue {
  merchantId: string;
  /** Merchant-local `YYYY-MM-DD` of the queue being shown. */
  serviceDate: string;
  timezone: string;
  enabled: boolean;
  acceptingNow: boolean;
  customerNotice: string | null;
  policy: {
    enabled: boolean;
    acceptWhenClosed: boolean;
    minPartySize: number;
    maxPartySize: number;
    averageTurnMinutes: number;
    callTimeoutMinutes: number;
  };
  /** Tickets still waiting or called — the live queue. */
  active: MerchantQueueEntry[];
  /** Everything that ended today, newest first. */
  completed: MerchantQueueEntry[];
  counts: {
    waiting: number;
    called: number;
    seated: number;
    noShow: number;
    cancelled: number;
  };
  /** The next ticket number that would be issued, e.g. `A-015`. */
  nextTicketNo: string;
}

export interface WaitlistSettings {
  merchantId: string;
  policy: MerchantQueue['policy'];
  customerNotice: string | null;
  /** Whether the shop is open right now, so 開關 has context. */
  openNow: boolean;
}

export interface TakeNumberResult {
  ticket: CustomerQueueTicket;
  /** Prose for the confirmation, built server-side so the number cannot drift. */
  message: string;
}

export interface QueueTransitionResult {
  entryId: string;
  ticketNo: string;
  fromStatus: WaitlistStatus;
  toStatus: WaitlistStatus;
  occurredAt: string;
  /** Obligations the caller must discharge. */
  sideEffects: string[];
  callDeadlineAt: string | null;
  allowedNextTransitions: WaitlistStatus[];
  entry: MerchantQueueEntry;
}

export interface QueueSweepResult {
  merchantId: string;
  markedNoShow: number;
  skipped: number;
  message: string;
}

/** `POST /merchants/:id/queue`. */
export interface TakeNumberInput {
  partySize: number;
  guestName: string;
  contactPhone: string;
  note?: string;
}

/** `PATCH /merchant/:id/queue/settings`. A patch — only what is present is written. */
export interface UpdateWaitlistSettingsInput {
  enabled?: boolean;
  acceptWhenClosed?: boolean;
  minPartySize?: number;
  maxPartySize?: number;
  averageTurnMinutes?: number;
  callTimeoutMinutes?: number;
  customerNotice?: string | null;
}

// ============================================================================
//  店內點餐 — dine-in (Task #22)
// ============================================================================

export type DiningSessionStatus = 'OPEN' | 'CLOSED' | 'ABANDONED';

/** A sitting, without its line items. What the board renders per table. */
export interface DiningSessionSummary {
  id: string;
  tableId: string;
  tableCode: string;
  status: DiningSessionStatus;
  statusLabel: string;
  partySize: number | null;
  serviceDate: string;
  openedAt: string;
  closedAt: string | null;
  /** How long the table has been sitting. Drives "已經 42 分鐘" and the age colour. */
  seatedMinutes: number;
  /** Running total across everything ordered this sitting. */
  totalMinor: number;
  /** How many rounds this table has placed. */
  orderCount: number;
  /** How many main dishes — what the platform fee is charged on. */
  mainItemCount: number;
  version: number;
}

/** One table, as the merchant's floor plan lists it. */
export interface DiningTable {
  id: string;
  code: string;
  label: string | null;
  seats: number;
  isActive: boolean;
  qrToken: string;
  /** The QR URL a shop prints on the label. Built server-side. */
  qrUrl: string;
  /** The live sitting, if the table is in use. */
  session: DiningSessionSummary | null;
}

export interface MerchantTableBoard {
  merchantId: string;
  timezone: string;
  serviceDate: string;
  tables: DiningTable[];
  counts: {
    total: number;
    active: number;
    occupied: number;
    free: number;
    /** Planned covers across the open sittings. */
    seatedGuests: number;
  };
}

/** One line on a tab. */
export interface DiningTabLine {
  orderId: string;
  orderNo: string;
  status: string;
  statusLabel: string;
  quantity: number;
  lineTotalMinor: number;
  createdAt: string;
  /** False for a voided round, so the tab greys it rather than hiding it. */
  countsTowardTotal: boolean;
}

export interface DiningSessionTab {
  session: DiningSessionSummary;
  merchantId: string;
  merchantName: string;
  lines: DiningTabLine[];
  subtotalMinor: number;
  totalMinor: number;
  /** False once the sitting is closed; the page then shows the settled bill. */
  canOrderMore: boolean;
  settledAt: string | null;
}

/**
 * What a scanned table QR resolves to.
 *
 * ONE response with everything the page needs: which restaurant, which table,
 * whether there is a sitting, what is on the tab. A second round-trip before
 * the menu can render is a spinner in front of a waiter.
 */
export interface ScannedTable {
  merchantId: string;
  merchantName: string;
  merchantSlug: string;
  timezone: string;
  tableId: string;
  tableCode: string;
  tableLabel: string | null;
  seats: number;
  /** False renders "此餐廳未開放掃碼點餐" rather than a broken menu. */
  diningEnabled: boolean;
  openNow: boolean;
  /** `null` means the table is free — the page then offers 開始用餐. */
  session: DiningSessionSummary | null;
  /** Present ONLY on this response — the board never receives a token. */
  qrToken: string;
}

/** The result of opening a sitting from a scanned table. */
export interface OpenSessionResult {
  session: DiningSessionSummary;
  /**
   * 一次性入座碼 — the token every subsequent round is keyed on.
   *
   * Returned ONLY here, and only to the guest who just opened the sitting. The
   * table's static QR is not enough to order, so the page must capture this.
   */
  guestToken: string;
  /** The URL the guest's phone should settle on after opening. */
  orderingUrl: string;
  message: string;
}

/** The result of mailing a round, as the guest's page receives it. */
export interface ScanAndOrderResult {
  order: {
    id: string;
    orderNo: string;
    status: string;
    subtotalMinor: number;
    totalMinor: number;
    currency: string;
  };
  session: DiningSessionSummary;
  tab: DiningSessionTab;
  message: string;
}

export interface CloseSessionResult {
  session: DiningSessionSummary;
  tab: DiningSessionTab;
  message: string;
}

/** `POST /dine/table/:qrToken/session`. */
export interface OpenDiningSessionInput {
  partySize?: number;
}

/** `POST /dine/s/:guestToken/orders`. */
export interface ScanAndOrderInput {
  items: { menuItemId: string; quantity: number }[];
  customerNote?: string;
  contactPhone?: string;
  idempotencyKey?: string;
}

/** `POST /merchant/:id/dining/tables`. */
export interface CreateDiningTableInput {
  code: string;
  label?: string | null;
  seats?: number;
  isActive?: boolean;
}

/** `PATCH /merchant/:id/dining/tables/:tableId`. */
export interface UpdateDiningTableInput {
  label?: string | null;
  seats?: number;
  isActive?: boolean;
  /** Mints a fresh token, invalidating the printed code for this table. */
  rotateQr?: boolean;
}
