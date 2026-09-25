import type { AnalyticsCapability, AnalyticsTier, DiningSessionStatus, MerchantStatus, OrderStatus, RefundReasonCode, RefundRequestStatus, ReservationActor, ReservationStatus, UserRole, WaitlistStatus } from './types';

/**
 * Display helpers.
 *
 * Every one of these is pure and takes minor units. There is deliberately no
 * `parseMoney` — the app never turns a formatted string back into a number.
 */

const HKD = new Intl.NumberFormat('zh-HK', {
  style: 'currency',
  currency: 'HKD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Minor units to HK$. `350` -> `HK$3.50`.
 *
 * Rounds to the nearest cent rather than truncating: a fee computed in basis
 * points can land on a fraction of a cent, and always rounding down would make
 * the platform's own revenue silently under-report.
 */
export function money(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return HKD.format(Math.round(minor) / 100);
}

/** Compact form for stat tiles: `HK$1,234` with no cents. */
export function moneyCompact(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return HKD.format(Math.round(minor) / 100).replace(/\.00$/, '');
}

/** `350` -> `$3.50`. For table cells where the HK prefix would repeat. */
export function moneyBare(minor: number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return (minor / 100).toFixed(2);
}

export function basisPoints(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
//  Time
// ---------------------------------------------------------------------------

/**
 * Format in a specific timezone.
 *
 * `timeZone` is a parameter rather than a global because a pickup slot belongs
 * to the MERCHANT's clock, not the viewer's. Rendering a Central kitchen's
 * 15:00 slot as 23:00 because the admin is travelling is a real bug.
 */
export function dateTime(value: string | null | undefined, timeZone = 'Asia/Hong_Kong'): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function timeOnly(value: string | null | undefined, timeZone = 'Asia/Hong_Kong'): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

export function dateOnly(value: string | null | undefined, timeZone = 'Asia/Hong_Kong'): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-HK', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}

/** "3 分鐘前" / "2 小時前" / a date once it is older than a week. */
export function relative(value: string | null | undefined): string {
  if (!value) return '—';
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 0) return '剛剛';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分鐘前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小時前`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 日前`;
  return dateOnly(value);
}

/** Seconds to "1 分 20 秒" — used for the outbox backlog age. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小時 ${Math.floor((seconds % 3600) / 60)} 分`;
}

/** `660` -> `11:00`. Minutes from local midnight, as stored on opening hours. */
export function minuteOfDay(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The calendar date *in a given zone*, as `YYYY-MM-DD`.
 *
 * `new Date().toISOString().slice(0, 10)` answers "what is today in UTC",
 * which is the wrong day for a +8 shop between 00:00 and 08:00 local. Every
 * date picker and day grouping in the reservation screens needs the merchant's
 * answer, not the browser's — `en-CA` is the locale that formats as ISO.
 */
export function localDateKey(value: string | Date = new Date(), timeZone = 'Asia/Hong_Kong'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** `2026-09-29` -> `9月29日（二）`. For day tabs and the booking header. */
export function localDateLabel(dateKey: string, timeZone = 'Asia/Hong_Kong'): string {
  const at = noonUtc(dateKey);
  if (!at) return dateKey;
  const parts = new Intl.DateTimeFormat('zh-HK', {
    timeZone,
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}${get('day')}（${get('weekday').replace('週', '')}）`;
}

/**
 * `n` calendar days after `dateKey`, still as `YYYY-MM-DD`.
 *
 * Arithmetic on the DATE part only, via UTC noon — using `setDate` on a local
 * `Date` would reintroduce the browser's zone, which is the bug this whole
 * group of helpers exists to avoid.
 */
export function addDays(dateKey: string, n: number): string {
  const at = noonUtc(dateKey);
  if (!at) return dateKey;
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

/** Whether `dateKey` is before today in the merchant's zone. */
export function isPastDate(dateKey: string, timeZone = 'Asia/Hong_Kong'): boolean {
  return dateKey < localDateKey(new Date(), timeZone);
}

/**
 * `YYYY-MM-DD` -> UTC noon on that date, or `null` if it is not a date.
 *
 * Noon rather than midnight so the instant stays on the intended calendar day
 * for every real UTC offset, which is what lets the label and the day arithmetic
 * both be written against UTC without a zone.
 */
function noonUtc(dateKey: string): Date | null {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** `0..6` -> `週日`. */
export function weekday(dayOfWeek: number): string {
  return `週${WEEKDAYS[dayOfWeek] ?? '?'}`;
}

/**
 * A live countdown to an absolute deadline, as `mm:ss`.
 *
 * Returns `null` once the deadline has passed, so callers can switch to an
 * overdue state instead of rendering `-00:03`.
 */
export function countdown(deadline: string | null | undefined): string | null {
  if (!deadline) return null;
  const remaining = Math.floor((new Date(deadline).getTime() - Date.now()) / 1000);
  if (remaining <= 0) return null;
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
//  Labels
// ---------------------------------------------------------------------------

/**
 * Status labels and tones.
 *
 * One table, used by the customer app, the kitchen board and the admin console.
 * When the lifecycle changes, this is the only frontend file that changes —
 * which is why it is not three copies of a switch statement.
 */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '待付款',
  PAID: '待接單',
  ACCEPTED: '已接單',
  PREPARING: '製作中',
  READY_FOR_PICKUP: '可取餐',
  COMPLETED: '已完成',
  REJECTED: '已拒單',
  CANCELLED: '已取消',
  EXPIRED: '已逾時',
  REFUNDED: '已退款',
};

export type Tone = 'neutral' | 'info' | 'warn' | 'ok' | 'danger' | 'accent';

export const ORDER_STATUS_TONE: Record<OrderStatus, Tone> = {
  PENDING_PAYMENT: 'warn',
  PAID: 'info',
  ACCEPTED: 'info',
  PREPARING: 'accent',
  READY_FOR_PICKUP: 'ok',
  COMPLETED: 'neutral',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
  REFUNDED: 'danger',
};

/** Statuses that still need somebody to act. */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = [
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
];

export const MERCHANT_STATUS_LABEL: Record<MerchantStatus, string> = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待審核',
  ACTIVE: '營業中',
  SUSPENDED: '已暫停',
  CLOSED: '已結業',
};

export const MERCHANT_STATUS_TONE: Record<MerchantStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_REVIEW: 'warn',
  ACTIVE: 'ok',
  SUSPENDED: 'danger',
  CLOSED: 'neutral',
};

export const MERCHANT_ACTION_LABEL: Record<string, string> = {
  APPROVE: '核准上線',
  SUSPEND: '暫停營業',
  REINSTATE: '恢復營業',
  CLOSE: '結業',
};

export const ROLE_LABEL: Record<UserRole, string> = {
  CUSTOMER: '顧客',
  MERCHANT_OWNER: '商戶擁有人',
  MERCHANT_STAFF: '商戶員工',
  ADMIN: '平台管理員',
};

export const AVAILABILITY_LABEL: Record<string, string> = {
  AVAILABLE: '供應中',
  SOLD_OUT: '今日售罄',
  HIDDEN: '已下架',
};

export const AVAILABILITY_TONE: Record<string, Tone> = {
  AVAILABLE: 'ok',
  SOLD_OUT: 'warn',
  HIDDEN: 'neutral',
};

export const PAYOUT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待結算',
  PROCESSING: '結算中',
  PAID: '已付款',
  FAILED: '付款失敗',
};

export const PAYOUT_STATUS_TONE: Record<string, Tone> = {
  PENDING: 'warn',
  PROCESSING: 'info',
  PAID: 'ok',
  FAILED: 'danger',
};

export const OUTBOX_STATUS_LABEL: Record<string, string> = {
  PENDING: '待發送',
  PUBLISHED: '已發送',
  FAILED: '發送失敗',
  DEAD_LETTER: '已隔離',
};

export const OUTBOX_STATUS_TONE: Record<string, Tone> = {
  PENDING: 'warn',
  PUBLISHED: 'ok',
  FAILED: 'danger',
  DEAD_LETTER: 'danger',
};

export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING: '待付款',
  AUTHORIZED: '已授權',
  CAPTURED: '已收款',
  FAILED: '付款失敗',
  CANCELLED: '已取消',
  REFUNDED: '已全額退款',
  PARTIALLY_REFUNDED: '已部分退款',
};

export const PAYMENT_MODE_LABEL: Record<string, string> = {
  ONLINE: '線上付款',
  PAY_AT_STORE: '到店付款',
};

export const REFUND_STATUS_LABEL: Record<string, string> = {
  PENDING: '處理中',
  SUCCEEDED: '已退款',
  FAILED: '退款失敗',
};

// ---------------------------------------------------------------------------
//  退款申請工單 (refund-request tickets)
// ---------------------------------------------------------------------------

/**
 * The ticket lifecycle, in words a customer reads without being taught.
 *
 * Note what `RESOLVED_OFFLINE` says: 「已線下處理」, not 「已退款」. The shop told
 * the platform what it handed over; the platform did not verify it and did not
 * process it. Rendering it as a refund would make the platform claim a
 * settlement it was never part of.
 *
 * The names carry a `REFUND_REQUEST_` prefix because `REFUND_STATUS_LABEL`
 * above is a DIFFERENT thing — the payment-provider refund the pay-now path
 * occasionally records. Two lifecycles, two vocabularies.
 */
export const REFUND_REQUEST_STATUS_LABEL: Record<RefundRequestStatus, string> = {
  OPEN: '待店家處理',
  IN_DISCUSSION: '商議中',
  RESOLVED_OFFLINE: '已線下處理',
  DECLINED: '店家拒絕',
  CANCELLED: '已撤回',
};

export const REFUND_REQUEST_STATUS_TONE: Record<RefundRequestStatus, Tone> = {
  OPEN: 'warn',
  IN_DISCUSSION: 'info',
  RESOLVED_OFFLINE: 'ok',
  DECLINED: 'danger',
  CANCELLED: 'neutral',
};

/** Short form for a filter chip or a queue tab. */
export const REFUND_REQUEST_SHORT_LABEL: Record<RefundRequestStatus, string> = {
  OPEN: '待處理',
  IN_DISCUSSION: '商議中',
  RESOLVED_OFFLINE: '已處理',
  DECLINED: '已拒絕',
  CANCELLED: '已撤回',
};

/** Why the customer says they want money back. */
export const REFUND_REASON_LABEL: Record<RefundReasonCode, string> = {
  NEVER_RECEIVED: '沒有收到餐點',
  WRONG_ITEM: '餐點送錯',
  QUALITY: '品質問題',
  LATE: '等候過久',
  DUPLICATE_CHARGE: '重複收費',
  OTHER: '其他',
};

/** The reasons a customer can choose when filing. Closed list, mirrors the API. */
export const REFUND_REASON_CODES: RefundReasonCode[] = [
  'NEVER_RECEIVED',
  'WRONG_ITEM',
  'QUALITY',
  'LATE',
  'DUPLICATE_CHARGE',
  'OTHER',
];

/** A ticket that still needs someone to act — the queue's default tab. */
export const ACTIVE_REFUND_REQUEST_STATUSES: RefundRequestStatus[] = ['OPEN', 'IN_DISCUSSION'];

export function isActiveRefundRequest(status: RefundRequestStatus): boolean {
  return ACTIVE_REFUND_REQUEST_STATUSES.includes(status);
}

/**
 * How a target status is labelled and toned when it becomes a button.
 *
 * `RESOLVED_OFFLINE` says 「已線下處理」 for the same reason the label table
 * does — the shop is recording an off-platform settlement, not the platform
 * performing one.
 */
export const REFUND_ACTION_SPEC: Record<
  RefundRequestStatus,
  { label: string; variant: 'primary' | 'danger' | 'default'; needsDetails: boolean }
> = {
  OPEN: { label: '重開', variant: 'default', needsDetails: false },
  IN_DISCUSSION: { label: '開始商議', variant: 'primary', needsDetails: false },
  RESOLVED_OFFLINE: { label: '標記已線下處理', variant: 'primary', needsDetails: true },
  DECLINED: { label: '拒絕申請', variant: 'danger', needsDetails: false },
  CANCELLED: { label: '撤回', variant: 'danger', needsDetails: false },
};

// ---------------------------------------------------------------------------
//  預約訂位
// ---------------------------------------------------------------------------

/**
 * The reservation lifecycle, in the order a party moves through it.
 *
 * The happy path only — `DECLINED` / `CANCELLED` / `NO_SHOW` are terminal side
 * exits and are rendered as a state, never as a step in the strip.
 */
export const RESERVATION_PROGRESS: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED'];

export function reservationProgressIndex(status: ReservationStatus): number {
  return RESERVATION_PROGRESS.indexOf(status);
}

export const RESERVATION_STATUS_LABEL: Record<ReservationStatus, string> = {
  PENDING: '待店家確認',
  CONFIRMED: '已確認',
  SEATED: '已入座',
  COMPLETED: '已完成',
  DECLINED: '店家婉拒',
  CANCELLED: '已取消',
  NO_SHOW: '未出席',
};

export const RESERVATION_STATUS_TONE: Record<ReservationStatus, Tone> = {
  PENDING: 'warn',
  CONFIRMED: 'ok',
  SEATED: 'accent',
  COMPLETED: 'neutral',
  DECLINED: 'danger',
  CANCELLED: 'neutral',
  NO_SHOW: 'danger',
};

/** The short label a board column or filter chip shows. */
export const RESERVATION_SHORT_LABEL: Record<ReservationStatus, string> = {
  PENDING: '待確認',
  CONFIRMED: '已確認',
  SEATED: '已入座',
  COMPLETED: '已完成',
  DECLINED: '已婉拒',
  CANCELLED: '已取消',
  NO_SHOW: '未出席',
};

export const RESERVATION_ACTOR_LABEL: Record<ReservationActor, string> = {
  CUSTOMER: '顧客',
  MERCHANT: '店家',
  SYSTEM: '系統',
  ADMIN: '平台',
};

/** Statuses that still hold seats — the ones a board shows by default. */
export const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = ['PENDING', 'CONFIRMED', 'SEATED'];

export function isActiveReservation(status: ReservationStatus): boolean {
  return ACTIVE_RESERVATION_STATUSES.includes(status);
}

/** Where an order sits on the pickup timeline, for the progress strip. */
export const PICKUP_PROGRESS: OrderStatus[] = [
  'PAID',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'COMPLETED',
];

export function progressIndex(status: OrderStatus): number {
  return PICKUP_PROGRESS.indexOf(status);
}

/**
 * Whether an order has stopped moving.
 *
 * Duplicated from `packages/domain` rather than imported: the web bundle does
 * not depend on the domain package (it would drag the pricing engine into the
 * browser for one predicate). `scripts/contract-check.js` does not cover this,
 * so if the domain list changes, change this one.
 */
export const TERMINAL_ORDER_STATUSES: OrderStatus[] = [
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
];

export function isTerminalOrder(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/** `+85290000001` -> `+852 9000 0001`. Falls back to the raw value. */
export function phone(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /^\+852(\d{4})(\d{4})$/.exec(value);
  return match ? `+852 ${match[1]} ${match[2]}` : value;
}

// ---------------------------------------------------------------------------
//  商戶營業報表 — tier labels and tones (Task #20)
// ---------------------------------------------------------------------------

/**
 * The tier's display label.
 *
 * Read off the API response in the pages (`view.tier.label`) rather than
 * re-declared here, and these maps exist for the cases where the page holds a
 * bare tier string — the admin console's select, for instance, which has no
 * response to read from before a merchant is chosen. The two must agree; the
 * domain is the authority.
 */
export const ANALYTICS_TIER_LABEL: Record<AnalyticsTier, string> = {
  NONE: '標準',
  BASIC: '進階報表',
  PRO: '專業報表',
};

export const ANALYTICS_TIER_BLURB: Record<AnalyticsTier, string> = {
  NONE: '訂單明細與 Excel 匯出，永久免費。',
  BASIC: '營業額趨勢、菜品排行、時段分佈。',
  PRO: '包含進階報表全部功能，另加同期比較。',
};

export const ANALYTICS_TIER_TONE: Record<AnalyticsTier, Tone> = {
  NONE: 'neutral',
  BASIC: 'info',
  PRO: 'accent',
};

export const ANALYTICS_TIERS: AnalyticsTier[] = ['NONE', 'BASIC', 'PRO'];

/** What each capability panel is called, for the report page's headers. */
export const ANALYTICS_CAPABILITY_LABEL: Record<AnalyticsCapability, string> = {
  DAILY_ROLLUP: '每日營業額',
  ITEM_MIX: '菜品排行',
  HOUR_OF_DAY: '時段分佈',
  CHANNEL_MIX: '取餐／付款方式分佈',
  COMPARISON: '同期比較',
};

/** `PRO` ranks above `BASIC` above `NONE` — used by the admin downgrade check. */
export function analyticsTierRank(tier: AnalyticsTier): number {
  return tier === 'PRO' ? 2 : tier === 'BASIC' ? 1 : 0;
}

/**
 * `+12.4%` / `-3.1%` / `—`.
 *
 * `null` rather than `0` when there is no baseline, because "no previous window"
 * and "flat" are different facts and a `0.0%` badge would claim the latter.
 */
export function percentChange(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function percentChangeTone(value: number | null | undefined): Tone {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return 'neutral';
  }
  return value > 0 ? 'ok' : 'danger';
}

/** `14` -> `14:00`, for the hour-of-day axis. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

// ---------------------------------------------------------------------------
//  現場候位 — queue labels and tones (Task #21)
// ---------------------------------------------------------------------------

export const WAITLIST_STATUS_LABEL: Record<WaitlistStatus, string> = {
  WAITING: '候位中',
  CALLED: '已叫號',
  SEATED: '已入座',
  NO_SHOW: '過號',
  CANCELLED: '已取消',
};

export const WAITLIST_STATUS_SHORT_LABEL: Record<WaitlistStatus, string> = {
  WAITING: '候位',
  CALLED: '叫號',
  SEATED: '入座',
  NO_SHOW: '過號',
  CANCELLED: '取消',
};

export const WAITLIST_STATUS_TONE: Record<WaitlistStatus, Tone> = {
  WAITING: 'info',
  // 叫號 is the state that needs the host's attention, so it is the loud one.
  CALLED: 'warn',
  SEATED: 'ok',
  NO_SHOW: 'danger',
  CANCELLED: 'neutral',
};

/** Still the host's job. */
export const ACTIVE_WAITLIST_STATUSES: WaitlistStatus[] = ['WAITING', 'CALLED'];

export function isActiveWaitlist(status: WaitlistStatus): boolean {
  return ACTIVE_WAITLIST_STATUSES.includes(status);
}

/**
 * What each host-board action is called.
 *
 * The board renders a button per value of `allowedNextTransitions`, so this map
 * has to cover every transition the machine permits — a missing key would
 * render a button with a raw enum on it.
 */
export const WAITLIST_ACTION_LABEL: Record<WaitlistStatus, string> = {
  WAITING: '放回候位',
  CALLED: '叫號',
  SEATED: '入座',
  NO_SHOW: '標記過號',
  CANCELLED: '取消號碼',
};

/**
 * Which of the moves needs a reason or a confirmation.
 *
 * Seating and calling are the happy path and are one-tap — a host with a guest
 * standing in front of them should not be made to fill in a form. The two
 * terminal verdicts are the ones worth a dialog, because they are the two that
 * cannot be undone and both are a claim about a guest who is not there.
 */
export const WAITLIST_ACTION_NEEDS_CONFIRM: WaitlistStatus[] = ['NO_SHOW', 'CANCELLED'];

/** The colour of an order's wait, for the board's age chips. */
export function waitTone(minutes: number | null | undefined): Tone {
  if (minutes === null || minutes === undefined) return 'neutral';
  if (minutes >= 60) return 'danger';
  if (minutes >= 30) return 'warn';
  return 'ok';
}

/** `75` -> `1 小時 15 分`. Chinese, because that is what the host reads aloud. */
export function waitDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} 小時` : `${hours} 小時 ${rest} 分`;
}

// ---------------------------------------------------------------------------
//  店內點餐 — dining labels and tones (Task #22)
// ---------------------------------------------------------------------------

export const DINING_SESSION_STATUS_LABEL: Record<DiningSessionStatus, string> = {
  OPEN: '用餐中',
  CLOSED: '已結帳',
  ABANDONED: '已離場',
};

export const DINING_SESSION_STATUS_TONE: Record<DiningSessionStatus, Tone> = {
  OPEN: 'ok',
  CLOSED: 'neutral',
  ABANDONED: 'warn',
};

/**
 * How long a table has been sitting, as a colour.
 *
 * Tuned to a table-turn: under 45 minutes is a healthy sitting, an hour is one
 * the host starts watching, and 90 minutes in a shop that turns tables in 45 is
 * a party that has settled in. The thresholds are deliberately generous — a
 * board that flags every normal dinner as late is a board the host stops
 * reading.
 */
export function seatedTone(minutes: number | null | undefined): Tone {
  if (minutes === null || minutes === undefined) return 'neutral';
  if (minutes >= 90) return 'danger';
  if (minutes >= 60) return 'warn';
  return 'ok';
}
