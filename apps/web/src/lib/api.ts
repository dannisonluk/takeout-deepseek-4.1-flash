import type {
  AdminMerchant,
  AdminOrder,
  AdminOrderSummary,
  AdminOutboxEvent,
  AdminOutboxStats,
  AdminPayout,
  AdminUser,
  AnalyticsTier,
  AnalyticsTierWriteResult,
  AuditLogEntry,
  AuthProfile,
  CloseSessionResult,
  ConfirmOrderResult,
  CreateDiningTableInput,
  CreateMenuItemInput,
  CreateMerchantInput,
  CustomerOrder,
  CustomerQueueEntryPoint,
  CustomerQueueTicket,
  CustomerRefundPage,
  CustomerRefundRequest,
  CustomerReservation,
  ClosureWriteResult,
  DashboardStats,
  DiningSessionStatus,
  DiningSessionTab,
  DiningTable,
  DistrictCount,
  FileRefundRequestInput,
  AdminRefundPage,
  MerchantAnalytics,
  MerchantClosure,
  MerchantDetail,
  MerchantOrder,
  MerchantQueue,
  MerchantRefundQueue,
  MerchantRefundRequest,
  MerchantReservation,
  MerchantSummary,
  MerchantTableBoard,
  OpenSessionResult,
  OperatingHour,
  OrderCreated,
  OtpRequested,
  OwnerMenu,
  OwnedMerchant,
  Paged,
  PaymentIntent,
  PickupSlots,
  PlaceOrderInput,
  PlaceReservationInput,
  PlatformConfigEntry,
  PricingPolicy,
  QueueSweepResult,
  QueueTransitionResult,
  Reconciliation,
  RefundRequestStatus,
  RefundTransition,
  ReservationAvailability,
  ReservationCreated,
  ReservationPage,
  ReservationReasonInput,
  ReservationSettings,
  ReservationTransition,
  ScanAndOrderInput,
  ScanAndOrderResult,
  ScannedTable,
  Session,
  SetClosureInput,
  TakeNumberInput,
  TakeNumberResult,
  TransitionRefundRequestInput,
  UpdateDiningTableInput,
  UpdateMerchantInput,
  UpdateReservationSettingsInput,
  UpdateWaitlistSettingsInput,
  WaitlistSettings,
} from './types';

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3000/v1';

/**
 * A non-2xx response, unwrapped.
 *
 * The API's error envelope is `{ error: { code, message, details } }`, and
 * `code` is the machine-readable part — a 409 could be `CATEGORY_IN_USE` or
 * `MERCHANT_STATUS_TRANSITION`, and the UI needs to tell them apart to decide
 * whether to offer a retry, a fix, or nothing at all.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** A field-level validation failure, flattened to one sentence. */
  get validationMessage(): string | null {
    const validation = this.details?.validation as { message?: string[] } | undefined;
    if (Array.isArray(validation?.message)) return validation.message.join('；');
    return null;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

// ---------------------------------------------------------------------------
//  Token store
// ---------------------------------------------------------------------------
/*
 * The access token lives in a module variable — never in localStorage — so an
 * XSS payload cannot read it back out of storage. The refresh token does have
 * to survive a page reload, so it goes to localStorage; that is the standard
 * trade-off and the reason the API rotates it on every use and revokes the
 * whole chain on reuse.
 */

const REFRESH_KEY = 'takeout.refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function loadStoredRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  refreshToken ??= window.localStorage.getItem(REFRESH_KEY);
  return refreshToken;
}

export function setTokens(next: { accessToken: string; refreshToken: string }): void {
  accessToken = next.accessToken;
  refreshToken = next.refreshToken;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(REFRESH_KEY, next.refreshToken);
  }
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  if (typeof window !== 'undefined') window.localStorage.removeItem(REFRESH_KEY);
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

/**
 * Called when a refresh fails — the session is genuinely over (rotated away,
 * revoked, or expired) and the user must log in again.
 */
export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

// ---------------------------------------------------------------------------
//  Core transport
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip the Authorization header — for login and public discovery. */
  anonymous?: boolean;
  /** Skip the refresh-and-retry path, so a failed refresh cannot recurse. */
  noRetry?: boolean;
  headers?: Record<string, string>;
  /** Next.js caching. Public discovery pages pass a revalidate window. */
  next?: { revalidate?: number | false };
  signal?: AbortSignal;
}

/**
 * One in-flight refresh, shared by every caller.
 *
 * Without this, a page that fires six requests at once with a stale token
 * triggers six refreshes. The API rotates the refresh token and revokes the
 * chain on reuse, so five of those six would fail AND kill the session — the
 * user gets logged out for loading a dashboard.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    const token = loadStoredRefreshToken();
    if (!token) return false;
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!response.ok) {
        clearTokens();
        return false;
      }
      const session = (await response.json()) as Session;
      setTokens(session);
      return true;
    } catch {
      // A network blip is not proof the session is dead. Keep the refresh token
      // so the next attempt can succeed; only a real 4xx clears it.
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous, noRetry, headers = {}, next, signal } = options;

  const send = async (): Promise<Response> =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(!anonymous && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(next ? { next } : {}),
      ...(signal ? { signal } : {}),
    });

  let response = await send();

  if (response.status === 401 && !anonymous && !noRetry) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send();
    } else {
      clearTokens();
      onSessionLost?.();
    }
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text ? safeJson(text) : null;

  if (!response.ok) {
    const envelope = parsed as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'UNKNOWN',
      envelope?.error?.message ?? `HTTP ${response.status}`,
      envelope?.error?.details,
    );
  }

  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Build a query string, dropping undefined/empty values. */
function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Download a CSV as a file, rather than as a parsed body.
 *
 * WHY THIS DOES NOT GO THROUGH `apiFetch`
 * ---------------------------------------
 * `apiFetch` decodes the body as JSON and never reads a header. A 匯出 is the
 * opposite of that: the payload is text, the filename lives in
 * `Content-Disposition`, and the row count lives in `X-Row-Count`. Routing it
 * through `apiFetch` would mean losing the filename and handing a blob to
 * `JSON.parse`.
 *
 * The 401 path is re-implemented rather than shared, deliberately: a download
 * has no response body to re-read on retry, so the retry has to start from the
 * request again. It stays short because `refreshSession()` — the part with the
 * in-flight mutex — is shared.
 */
export async function downloadCsv(
  path: string,
  fallbackFilename: string,
): Promise<{ filename: string; rowCount: number | null }> {
  const send = () =>
    fetch(`${API_BASE}${path}`, {
      headers: {
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        accept: 'text/csv',
      },
    });

  let response = await send();
  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send();
    } else {
      clearTokens();
      onSessionLost?.();
    }
  }

  if (!response.ok) {
    // The error envelope is still JSON even though the success body is not.
    const text = await response.text();
    const envelope = safeJson(text) as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      | null;
    throw new ApiError(
      response.status,
      envelope?.error?.code ?? 'UNKNOWN',
      envelope?.error?.message ?? `HTTP ${response.status}`,
      envelope?.error?.details,
    );
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackFilename;
  const rowHeader = response.headers.get('x-row-count');
  const rowCount = rowHeader === null ? null : Number(rowHeader);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick rather than immediately: Safari aborts a download
  // whose object URL is released in the same frame as the click.
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return { filename, rowCount: Number.isFinite(rowCount) ? rowCount : null };
}

// ---------------------------------------------------------------------------
//  Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // ---- auth --------------------------------------------------------------
  auth: {
    requestOtp: (phone: string) =>
      apiFetch<OtpRequested>('/auth/otp/request', {
        method: 'POST',
        body: { phone },
        anonymous: true,
      }),

    verifyOtp: (phone: string, code: string) =>
      apiFetch<Session>('/auth/otp/verify', {
        method: 'POST',
        body: { phone, code },
        anonymous: true,
      }),

    me: () => apiFetch<AuthProfile>('/auth/me'),

    logout: (token: string) =>
      apiFetch<{ revoked: boolean }>('/auth/logout', {
        method: 'POST',
        body: { refreshToken: token },
        anonymous: true,
        noRetry: true,
      }),
  },

  // ---- public discovery --------------------------------------------------
  discovery: {
    list: (params: {
      district?: string;
      q?: string;
      latitude?: number;
      longitude?: number;
      radiusKm?: number;
      acceptingOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {}) => apiFetch<Paged<MerchantSummary>>(`/merchants${qs(params)}`, { anonymous: true }),

    districts: () => apiFetch<DistrictCount[]>('/merchants/districts', { anonymous: true }),

    bySlug: (slug: string) =>
      apiFetch<MerchantDetail>(`/merchants/${encodeURIComponent(slug)}`, { anonymous: true }),

    pickupSlots: (slug: string) =>
      apiFetch<PickupSlots>(`/merchants/${encodeURIComponent(slug)}/pickup-slots`, {
        anonymous: true,
      }),
  },

  // ---- customer orders ---------------------------------------------------
  orders: {
    place: (input: PlaceOrderInput, idempotencyKey?: string) =>
      apiFetch<OrderCreated>('/orders', {
        method: 'POST',
        body: input,
        ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
      }),

    list: (params: { status?: 'ACTIVE' | 'ALL'; limit?: number; cursor?: string } = {}) =>
      apiFetch<{ data: CustomerOrder[]; nextCursor: string | null; hasMore: boolean }>(
        `/orders${qs(params)}`,
      ),

    get: (orderId: string) => apiFetch<CustomerOrder>(`/orders/${orderId}`),

    cancel: (orderId: string, reason: string) =>
      apiFetch<unknown>(`/orders/${orderId}/cancel`, { method: 'POST', body: { reason } }),

    paymentIntent: (orderId: string, returnUrl?: string) =>
      apiFetch<PaymentIntent>(`/orders/${orderId}/payment-intent`, {
        method: 'POST',
        body: returnUrl ? { returnUrl } : {},
      }),

    /**
     * Settle an order without a PSP. Development only — the API 404s this when
     * `PAYMENT_LIVE_MODE=true`, and the button that calls it is hidden unless
     * the payment intent reported `notice`, which is the same flag.
     */
    simulatePayment: (orderId: string) =>
      apiFetch<{ orderId: string; orderNo: string; status: string; paidAt: string; notice: string }>(
        `/orders/${orderId}/simulate-payment`,
        { method: 'POST' },
      ),
  },

  // ---- merchant portal ---------------------------------------------------
  merchant: {
    mine: () => apiFetch<OwnedMerchant[]>('/merchant/mine'),

    apply: (input: CreateMerchantInput) =>
      apiFetch<OwnedMerchant>('/merchant/apply', { method: 'POST', body: input }),

    get: (merchantId: string) => apiFetch<OwnedMerchant>(`/merchant/${merchantId}`),

    update: (merchantId: string, patch: UpdateMerchantInput) =>
      apiFetch<OwnedMerchant>(`/merchant/${merchantId}`, { method: 'PATCH', body: patch }),

    replaceHours: (merchantId: string, hours: OperatingHour[]) =>
      apiFetch<OwnedMerchant>(`/merchant/${merchantId}/hours`, { method: 'PUT', body: { hours } }),

    setIntake: (merchantId: string, accepting: boolean) =>
      apiFetch<OwnedMerchant>(`/merchant/${merchantId}/intake`, {
        method: 'POST',
        body: { accepting },
      }),

    pickupSlots: (merchantId: string) =>
      apiFetch<PickupSlots>(`/merchant/${merchantId}/pickup-slots`),
  },

  // ---- menu --------------------------------------------------------------
  menu: {
    get: (merchantId: string) => apiFetch<OwnerMenu>(`/merchant/${merchantId}/menu`),

    createCategory: (merchantId: string, body: { name: string; nameEn?: string; sortOrder?: number }) =>
      apiFetch<{ id: string; name: string }>(`/merchant/${merchantId}/menu/categories`, {
        method: 'POST',
        body,
      }),

    updateCategory: (
      merchantId: string,
      categoryId: string,
      body: { name?: string; nameEn?: string; sortOrder?: number; isActive?: boolean },
    ) =>
      apiFetch<{ id: string }>(`/merchant/${merchantId}/menu/categories/${categoryId}`, {
        method: 'PATCH',
        body,
      }),

    deleteCategory: (merchantId: string, categoryId: string) =>
      apiFetch<void>(`/merchant/${merchantId}/menu/categories/${categoryId}`, {
        method: 'DELETE',
      }),

    createItem: (merchantId: string, body: CreateMenuItemInput) =>
      apiFetch<{ id: string }>(`/merchant/${merchantId}/menu/items`, { method: 'POST', body }),

    updateItem: (merchantId: string, itemId: string, body: Partial<CreateMenuItemInput>) =>
      apiFetch<{ id: string }>(`/merchant/${merchantId}/menu/items/${itemId}`, {
        method: 'PATCH',
        body,
      }),

    setAvailability: (merchantId: string, itemId: string, availability: string) =>
      apiFetch<{ id: string }>(`/merchant/${merchantId}/menu/items/${itemId}/availability`, {
        method: 'PATCH',
        body: { availability },
      }),

    deleteItem: (merchantId: string, itemId: string) =>
      apiFetch<void>(`/merchant/${merchantId}/menu/items/${itemId}`, { method: 'DELETE' }),

    reorderItems: (merchantId: string, entries: { id: string; sortOrder: number }[]) =>
      apiFetch<unknown>(`/merchant/${merchantId}/menu/items/order`, {
        method: 'PUT',
        body: { entries },
      }),
  },

  // ---- kitchen board -----------------------------------------------------
  kitchen: {
    list: (merchantId: string, params: { status?: string; limit?: number; cursor?: string } = {}) =>
      apiFetch<{ data: MerchantOrder[]; nextCursor: string | null; hasMore: boolean }>(
        `/merchant/${merchantId}/orders${qs(params)}`,
      ),

    get: (merchantId: string, orderId: string) =>
      apiFetch<MerchantOrder>(`/merchant/${merchantId}/orders/${orderId}`),

    /**
     * The kitchen moves. Each is a named action rather than a generic
     * "set status" because the state machine authorises them differently —
     * a generic endpoint would have to re-derive which actor is calling.
     */
    act: (
      merchantId: string,
      orderId: string,
      action: 'accept' | 'reject' | 'cancel' | 'start-preparing' | 'mark-ready' | 'complete',
      reason?: string,
    ) =>
      apiFetch<unknown>(`/merchant/${merchantId}/orders/${orderId}/${action}`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),

    /**
     * 確認訂單 — take the money (for a pay-at-store order), take the order, and
     * say when it will be ready, in one call.
     *
     * The primary button on the kitchen board. It works for an online-paid
     * order too: the settle step is skipped when the order is already `PAID`.
     */
    confirm: (
      merchantId: string,
      orderId: string,
      body: { readyInMinutes?: number; note?: string } = {},
    ) =>
      apiFetch<ConfirmOrderResult>(`/merchant/${merchantId}/orders/${orderId}/confirm`, {
        method: 'POST',
        body,
      }),
  },

  // ---- 預約訂位 -------------------------------------------------------------
  reservations: {
    /**
     * The slot grid — PUBLIC, no token.
     *
     * Deliberately anonymous: a booking page must be able to render the shop's
     * opening hours before it knows who is looking. Putting the login wall in
     * front of this would hide the times from the very people deciding whether
     * to book.
     *
     * `from` is a `YYYY-MM-DD` local date (or a full instant). `partySize` only
     * affects the `bookable` flag on each slot, so a page can fetch one grid and
     * flip the party size without refetching.
     */
    availability: (
      merchantId: string,
      params: { from: string; to?: string; partySize?: number },
    ) =>
      apiFetch<ReservationAvailability>(
        `/merchants/${merchantId}/reservation-availability${qs(params)}`,
        { anonymous: true },
      ),

    /**
     * Book a table.
     *
     * The idempotency key is not optional in practice — a customer double-tap
     * on a slow connection must not create two tables' worth of booking. The
     * caller mints it once per attempt (the read model's `crypto.randomUUID()`).
     */
    place: (input: PlaceReservationInput, idempotencyKey?: string) =>
      apiFetch<ReservationCreated>('/reservations', {
        method: 'POST',
        body: input,
        ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
      }),

    list: (params: { status?: 'ACTIVE' | 'ALL'; limit?: number } = {}) =>
      apiFetch<ReservationPage<CustomerReservation>>(`/reservations${qs(params)}`),

    get: (reservationId: string) =>
      apiFetch<CustomerReservation>(`/reservations/${reservationId}`),

    cancel: (reservationId: string, input: ReservationReasonInput = {}) =>
      apiFetch<ReservationTransition>(`/reservations/${reservationId}/cancel`, {
        method: 'POST',
        body: input,
      }),
  },

  // ---- merchant reservation book (訂位簿) -----------------------------------
  bookings: {
    list: (
      merchantId: string,
      params: { date?: string; status?: 'ACTIVE' | 'ALL'; limit?: number } = {},
    ) =>
      apiFetch<ReservationPage<MerchantReservation>>(
        `/merchant/${merchantId}/reservations${qs(params)}`,
      ),

    get: (merchantId: string, reservationId: string) =>
      apiFetch<MerchantReservation>(`/merchant/${merchantId}/reservations/${reservationId}`),

    settings: (merchantId: string) =>
      apiFetch<ReservationSettings>(`/merchant/${merchantId}/reservations/settings`),

    /**
     * Replace the book's settings.
     *
     * PUT rather than PATCH: the form always submits the whole object, and a
     * partial write is how a merchant ends up with a `maxPartySize` they
     * thought they had changed.
     */
    saveSettings: (merchantId: string, input: UpdateReservationSettingsInput) =>
      apiFetch<ReservationSettings>(`/merchant/${merchantId}/reservations/settings`, {
        method: 'PUT',
        body: input,
      }),

    /**
     * The six moves the shop can make, as named actions.
     *
     * Named rather than a generic "set status" because the state machine
     * authorises them differently, and because the board renders its buttons
     * from `allowedNextTransitions` — the name here is what that list contains.
     */
    act: (
      merchantId: string,
      reservationId: string,
      action: 'confirm' | 'decline' | 'seat' | 'complete' | 'no-show' | 'cancel',
      input: ReservationReasonInput = {},
    ) =>
      apiFetch<ReservationTransition>(
        `/merchant/${merchantId}/reservations/${reservationId}/${action}`,
        { method: 'POST', body: input },
      ),
  },

  // ---- 特別休息日 -----------------------------------------------------------
  closures: {
    /**
     * The shop's dated rest days. `from` defaults server-side to today in the
     * SHOP's timezone — passing it from here would use the browser's date and
     * hide the day a +08 shop most plausibly wants to close.
     */
    list: (merchantId: string, params: { from?: string } = {}) =>
      apiFetch<MerchantClosure[]>(`/merchant/${merchantId}/closures${qs(params)}`),

    get: (merchantId: string, serviceDate: string) =>
      apiFetch<MerchantClosure>(`/merchant/${merchantId}/closures/${serviceDate}`),

    /**
     * Close a day, or change why it is closed.
     *
     * PUT on a single date — a day either is a rest day or is not. The response
     * says what the cascade did, which is what the settings screen shows as a
     * real number rather than a generic "saved".
     */
    set: (merchantId: string, serviceDate: string, input: SetClosureInput) =>
      apiFetch<ClosureWriteResult>(`/merchant/${merchantId}/closures/${serviceDate}`, {
        method: 'PUT',
        body: input,
      }),

    /**
     * Reopen a day. Does NOT re-book the parties the closure cancelled — that
     * asymmetry is deliberate (see the API's `MerchantClosureService.remove`).
     */
    remove: (merchantId: string, serviceDate: string) =>
      apiFetch<void>(`/merchant/${merchantId}/closures/${serviceDate}`, { method: 'DELETE' }),
  },

  // ---- 退款申請工單 ---------------------------------------------------------
  refunds: {
    /**
     * File a ticket against one of my own orders.
     *
     * Filed against the ORDER rather than as a bare `POST /refund-requests`,
     * because the order is the thing being complained about. The API answers
     * 404 (not 403) for somebody else's order, so a stranger cannot probe ids.
     */
    file: (orderId: string, input: FileRefundRequestInput) =>
      apiFetch<CustomerRefundRequest>(`/orders/${orderId}/refund-request`, {
        method: 'POST',
        body: input,
      }),

    /** My own tickets, newest first. */
    mine: (params: { limit?: number; offset?: number } = {}) =>
      apiFetch<CustomerRefundPage>(`/refund-requests${qs(params)}`),

    get: (refundRequestId: string) =>
      apiFetch<CustomerRefundRequest>(`/refund-requests/${refundRequestId}`),

    /**
     * Withdraw my own ticket.
     *
     * A dedicated endpoint rather than a generic status PATCH, and it asks for
     * no reason: withdrawing is not a negotiation, and a form field would make
     * people not do it.
     */
    withdraw: (refundRequestId: string) =>
      apiFetch<RefundTransition<CustomerRefundRequest>>(
        `/refund-requests/${refundRequestId}/cancel`,
        { method: 'POST', body: {} },
      ),

    /** The shop's queue, with the per-status counts that drive its tabs. */
    queue: (
      merchantId: string,
      params: { status?: RefundRequestStatus | 'ACTIVE' | 'ALL'; limit?: number; offset?: number } = {},
    ) =>
      apiFetch<MerchantRefundQueue>(`/merchant/${merchantId}/refund-requests${qs(params)}`),

    merchantGet: (merchantId: string, refundRequestId: string) =>
      apiFetch<MerchantRefundRequest>(
        `/merchant/${merchantId}/refund-requests/${refundRequestId}`,
      ),

    /**
     * Move a ticket as the shop.
     *
     * One endpoint for every move, because the state machine — not the path —
     * decides which combination of fields is legal. `RESOLVED_OFFLINE` without
     * an amount or a reference is refused by the machine (422) rather than
     * recorded as an empty claim.
     */
    merchantAct: (
      merchantId: string,
      refundRequestId: string,
      input: TransitionRefundRequestInput,
    ) =>
      apiFetch<RefundTransition>(
        `/merchant/${merchantId}/refund-requests/${refundRequestId}/transition`,
        { method: 'POST', body: input },
      ),

    /** Platform-wide, read-only apart from the unblock transition. */
    adminList: (
      params: { status?: RefundRequestStatus | 'ACTIVE' | 'ALL'; merchantId?: string; limit?: number; offset?: number } = {},
    ) => apiFetch<AdminRefundPage>(`/admin/refund-requests${qs(params)}`),

    adminGet: (refundRequestId: string) =>
      apiFetch<MerchantRefundRequest>(`/admin/refund-requests/${refundRequestId}`),

    /**
     * The same machine and the same use case as the shop's endpoint, with
     * `ADMIN` recorded as the actor — so support cannot reach a state a shop
     * could not, and the audit trail says who really moved it.
     */
    adminAct: (refundRequestId: string, input: TransitionRefundRequestInput) =>
      apiFetch<RefundTransition>(`/admin/refund-requests/${refundRequestId}/transition`, {
        method: 'POST',
        body: input,
      }),
  },

  // ---- 商戶營業報表 ---------------------------------------------------------
  analytics: {
    /**
     * The report for a window.
     *
     * `from`/`to` are merchant-local `YYYY-MM-DD`. Omit them and the API
     * defaults to the last 30 SHOP-LOCAL days — which is the behaviour the page
     * wants on first load, because the browser's "today" is not the shop's.
     */
    report: (merchantId: string, params: { from?: string; to?: string } = {}) =>
      apiFetch<MerchantAnalytics>(`/merchant/${merchantId}/analytics${qs(params)}`),

    /**
     * 匯出 Excel — the raw rows as a CSV file.
     *
     * Free on every tier, including 標準. That is a product rule, not a default:
     * the platform charges for computation, never for access to a shop's own
     * data. `downloadCsv` reads the filename out of `Content-Disposition`, so
     * the downloaded name and the audited name are the same string.
     */
    exportCsv: (merchantId: string, params: { from?: string; to?: string } = {}) =>
      downloadCsv(
        `/merchant/${merchantId}/orders/export.csv${qs(params)}`,
        `orders-${merchantId}.csv`,
      ),
  },

  // ---- 現場候位 -------------------------------------------------------------
  waitlist: {
    /**
     * The take-a-number page state.
     *
     * Anonymous, deliberately: requiring a login before a guest can pull a
     * queue number would lose most of the queue at the first tap. `phone`
     * recovers the guest's own ticket, and is what the host would ring.
     */
    entryPoint: (merchantId: string, params: { phone?: string } = {}) =>
      apiFetch<CustomerQueueEntryPoint>(
        `/merchants/${merchantId}/queue${qs(params)}`,
        { anonymous: true },
      ),

    /** Take a number. Public — the guest is standing in a doorway. */
    take: (merchantId: string, input: TakeNumberInput) =>
      apiFetch<TakeNumberResult>(`/merchants/${merchantId}/queue`, {
        method: 'POST',
        body: input,
        anonymous: true,
      }),

    /**
     * The guest's own ticket, polled while they wait.
     *
     * `phone` is required: it is the ownership check. A wrong phone gives 404
     * rather than 403, so a guessed id does not confirm a ticket exists.
     */
    myTicket: (entryId: string, phone: string) =>
      apiFetch<CustomerQueueTicket>(`/queue/tickets/${entryId}${qs({ phone })}`, {
        anonymous: true,
      }),

    /** Leave the queue. Only legal while still waiting — the machine decides. */
    cancelTicket: (entryId: string, phone: string) =>
      apiFetch<{ entryId: string; ticketNo: string; status: string; message: string }>(
        `/queue/tickets/${entryId}/cancel${qs({ phone })}`,
        { method: 'POST', body: {}, anonymous: true },
      ),

    /** The host board: the live queue, today's log, the counts, the settings. */
    board: (merchantId: string, params: { date?: string } = {}) =>
      apiFetch<MerchantQueue>(`/merchant/${merchantId}/queue${qs(params)}`),

    settings: (merchantId: string) =>
      apiFetch<WaitlistSettings>(`/merchant/${merchantId}/queue/settings`),

    updateSettings: (merchantId: string, input: UpdateWaitlistSettingsInput) =>
      apiFetch<WaitlistSettings>(`/merchant/${merchantId}/queue/settings`, {
        method: 'PATCH',
        body: input,
      }),

    /**
     * Call, seat, or mark a guest a no-show.
     *
     * One endpoint for every move rather than a route per verb: the legal moves
     * depend on the current status, and three routes would each have to
     * re-implement the same state-machine check. Which moves are legal is
     * answered by `allowedNextTransitions` on every board row.
     */
    transition: (
      merchantId: string,
      entryId: string,
      to: string,
      reason?: string,
    ) =>
      apiFetch<QueueTransitionResult>(
        `/merchant/${merchantId}/queue/${entryId}/transition`,
        { method: 'POST', body: reason ? { to, reason } : { to } },
      ),

    /**
     * Mark every overdue called ticket a no-show.
     *
     * `dryRun` reports what would happen without doing it — which is what the
     * board's confirmation shows.
     */
    sweep: (merchantId: string, dryRun = false) =>
      apiFetch<QueueSweepResult>(`/merchant/${merchantId}/queue/sweep`, {
        method: 'POST',
        body: { dryRun },
      }),
  },

  // ---- 店內點餐 -------------------------------------------------------------
  dining: {
    /**
     * Resolve a scanned TABLE code.
     *
     * Anonymous, and the ONE call the scan page makes before a sitting exists.
     * It returns the shop, the table, the sitting and the tab-so-far in one
     * response, so the menu renders without a second round-trip.
     */
    scan: (qrToken: string) =>
      apiFetch<ScannedTable>(`/dine/table/${encodeURIComponent(qrToken)}`, {
        anonymous: true,
      }),

    /**
     * Start a sitting (or join the one already open) and get the one-time token.
     *
     * Idempotent server-side: two guests at one table must not produce two
     * bills. The second scanner joins the first one's sitting AND receives that
     * sitting's own token, so both phones order onto the same tab.
     */
    openSession: (qrToken: string, partySize?: number) =>
      apiFetch<OpenSessionResult>(`/dine/table/${encodeURIComponent(qrToken)}/session`, {
        method: 'POST',
        body: partySize === undefined ? {} : { partySize },
        anonymous: true,
      }),

    /** The running tab, keyed on the one-time token. Polled by the guest. */
    tab: (guestToken: string) =>
      apiFetch<DiningSessionTab>(`/dine/s/${encodeURIComponent(guestToken)}/tab`, {
        anonymous: true,
      }),

    /** Send a round. The order itself goes through the ordinary checkout path. */
    sendRound: (guestToken: string, input: ScanAndOrderInput) =>
      apiFetch<ScanAndOrderResult>(`/dine/s/${encodeURIComponent(guestToken)}/orders`, {
        method: 'POST',
        body: input,
        anonymous: true,
      }),

    /** The whole floor: every table, its sitting, its running total. */
    board: (merchantId: string) =>
      apiFetch<MerchantTableBoard>(`/merchant/${merchantId}/dining`),

    createTable: (merchantId: string, input: CreateDiningTableInput) =>
      apiFetch<DiningTable>(`/merchant/${merchantId}/dining/tables`, {
        method: 'POST',
        body: input,
      }),

    updateTable: (merchantId: string, tableId: string, input: UpdateDiningTableInput) =>
      apiFetch<DiningTable>(`/merchant/${merchantId}/dining/tables/${tableId}`, {
        method: 'PATCH',
        body: input,
      }),

    /** Open a sitting from the board — the host seating a party. */
    openTable: (merchantId: string, tableId: string) =>
      apiFetch<{ sessionId: string; guestToken: string; message: string }>(
        `/merchant/${merchantId}/dining/tables/${tableId}/session`,
        { method: 'POST', body: {} },
      ),

    /** The tab for one sitting — what the host checks before settling. */
    sessionTab: (merchantId: string, sessionId: string) =>
      apiFetch<DiningSessionTab>(`/merchant/${merchantId}/dining/sessions/${sessionId}`),

    /** Close a sitting. `status` defaults to `CLOSED`; `ABANDONED` is the other. */
    closeSession: (merchantId: string, sessionId: string, status?: DiningSessionStatus) =>
      apiFetch<CloseSessionResult>(
        `/merchant/${merchantId}/dining/sessions/${sessionId}/close`,
        { method: 'POST', body: status === undefined ? {} : { status } },
      ),
  },

  // ---- admin console -----------------------------------------------------
  admin: {
    dashboard: () => apiFetch<DashboardStats>('/admin/dashboard'),
    health: () => apiFetch<{ database: boolean; redis: boolean }>('/admin/health'),

    users: {
      list: (params: { role?: string; q?: string; isActive?: boolean; limit?: number; offset?: number } = {}) =>
        apiFetch<Paged<AdminUser>>(`/admin/users${qs(params)}`),
      get: (userId: string) => apiFetch<AdminUser>(`/admin/users/${userId}`),
      update: (
        userId: string,
        body: { displayName?: string; role?: string; isActive?: boolean; locale?: string },
      ) => apiFetch<AdminUser>(`/admin/users/${userId}`, { method: 'PATCH', body }),
      revokeSessions: (userId: string) =>
        apiFetch<{ revoked: number }>(`/admin/users/${userId}/revoke-sessions`, { method: 'POST' }),
    },

    merchants: {
      list: (params: { status?: string; q?: string; district?: string; limit?: number; offset?: number } = {}) =>
        apiFetch<Paged<AdminMerchant>>(`/admin/merchants${qs(params)}`),
      get: (merchantId: string) => apiFetch<AdminMerchant>(`/admin/merchants/${merchantId}`),
      act: (
        merchantId: string,
        action: 'APPROVE' | 'SUSPEND' | 'REINSTATE' | 'CLOSE',
        reason?: string,
      ) =>
        apiFetch<AdminMerchant>(`/admin/merchants/${merchantId}/action`, {
          method: 'POST',
          body: reason ? { action, reason } : { action },
        }),
      setIntake: (merchantId: string, accepting: boolean) =>
        apiFetch<AdminMerchant>(`/admin/merchants/${merchantId}/intake`, {
          method: 'POST',
          body: { accepting },
        }),

      /**
       * Set a shop's reporting tier.
       *
       * Returns the before/after tier blocks and, on a downgrade, prose naming
       * what is being taken away — the console shows that rather than a generic
       * "saved", because an operator confirming a downgrade needs to know what
       * the shop stops seeing.
       */
      setAnalyticsTier: (merchantId: string, tier: AnalyticsTier) =>
        apiFetch<AnalyticsTierWriteResult>(`/admin/merchants/${merchantId}/analytics-tier`, {
          method: 'POST',
          body: { tier },
        }),
    },

    orders: {
      list: (params: {
        status?: string;
        merchantId?: string;
        customerId?: string;
        from?: string;
        to?: string;
        q?: string;
        limit?: number;
        offset?: number;
      } = {}) => apiFetch<Paged<AdminOrderSummary>>(`/admin/orders${qs(params)}`),
      get: (orderId: string) => apiFetch<AdminOrder>(`/admin/orders/${orderId}`),
      transition: (orderId: string, to: string, reason: string) =>
        apiFetch<{ order: AdminOrder; fromStatus: string; toStatus: string; sideEffects: string[] }>(
          `/admin/orders/${orderId}/transition`,
          { method: 'POST', body: { to, reason } },
        ),
      refund: (orderId: string, reason: string, amountMinor?: number) =>
        apiFetch<{
          order: AdminOrder;
          refund: { id: string; amountMinor: number; status: string };
          notice: string | null;
        }>(`/admin/orders/${orderId}/refund`, {
          method: 'POST',
          body: amountMinor === undefined ? { reason } : { reason, amountMinor },
        }),
    },

    config: {
      list: () => apiFetch<PlatformConfigEntry[]>('/admin/config'),
      pricing: () => apiFetch<PricingPolicy>('/admin/config/pricing'),
      upsert: (key: string, value: number | boolean, description?: string) =>
        apiFetch<PlatformConfigEntry>(`/admin/config/${encodeURIComponent(key)}`, {
          method: 'PUT',
          body: description === undefined ? { value } : { value, description },
        }),
      remove: (key: string) =>
        apiFetch<void>(`/admin/config/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    },

    finance: {
      payouts: (params: { status?: string; merchantId?: string; limit?: number; offset?: number } = {}) =>
        apiFetch<
          Paged<AdminPayout> & { totals: { pendingNetMinor: number; paidNetMinor: number } }
        >(`/admin/payouts${qs(params)}`),
      payout: (payoutId: string) => apiFetch<AdminPayout>(`/admin/payouts/${payoutId}`),
      markPaid: (payoutId: string, reference?: string) =>
        apiFetch<AdminPayout>(`/admin/payouts/${payoutId}/mark-paid`, {
          method: 'POST',
          body: reference ? { reference } : {},
        }),
      markFailed: (payoutId: string, reason: string) =>
        apiFetch<AdminPayout>(`/admin/payouts/${payoutId}/mark-failed`, {
          method: 'POST',
          body: { reason },
        }),
      reconciliation: (params: { from?: string; to?: string; merchantId?: string; limit?: number } = {}) =>
        apiFetch<Reconciliation>(`/admin/reconciliation${qs(params)}`),
    },

    ops: {
      outboxStats: () => apiFetch<AdminOutboxStats>('/admin/outbox/stats'),
      outbox: (params: { status?: string; eventType?: string; aggregateId?: string; limit?: number; offset?: number } = {}) =>
        apiFetch<Paged<AdminOutboxEvent>>(`/admin/outbox${qs(params)}`),
      retryOutbox: (eventId: string) =>
        apiFetch<AdminOutboxEvent>(`/admin/outbox/${eventId}/retry`, { method: 'POST' }),
      deadLetter: (eventId: string) =>
        apiFetch<AdminOutboxEvent>(`/admin/outbox/${eventId}/dead-letter`, { method: 'POST' }),
      audit: (params: { actorId?: string; targetType?: string; action?: string; limit?: number; offset?: number } = {}) =>
        apiFetch<Paged<AuditLogEntry>>(`/admin/audit${qs(params)}`),
    },
  },
};
