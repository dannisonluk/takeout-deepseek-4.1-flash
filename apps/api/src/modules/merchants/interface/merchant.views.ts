import { MerchantStatus, MenuItemAvailability } from '@prisma/client';
import {
  ANALYTICS_TIER_BLURB,
  ANALYTICS_TIER_LABEL,
  AnalyticsCapability,
  // The DOMAIN enum, not the Prisma one. Both are generated from the same
  // vocabulary but they are different TS types, and every helper here
  // (`analyticsCapabilities`, `isPaidAnalyticsTier`) speaks the domain's. Using
  // Prisma's would compile only after a cast, and a cast is what lets the two
  // drift apart unnoticed.
  AnalyticsTier,
  analyticsCapabilities,
  canExportRawData,
  isPaidAnalyticsTier,
} from '@takeout/domain';

/** Public operating window for one weekday, in the merchant's local timezone. */
export interface OperatingHourView {
  readonly dayOfWeek: number;
  readonly opensAtMinute: number;
  readonly closesAtMinute: number;
  readonly isClosed: boolean;
}

export interface MenuItemView {
  readonly id: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly nameEn: string | null;
  readonly description: string | null;
  readonly imageKey: string | null;
  readonly imageBlurhash: string | null;
  /** Minor units. HK$58.00 => 5800. */
  readonly priceMinor: number;
  readonly currency: string;
  /** The flag that drives the per-item platform fee. */
  readonly isMainItem: boolean;
  readonly availability: MenuItemAvailability;
  readonly dailyQuota: number | null;
  /**
   * `quota - sold - held` for the merchant's current service day.
   * `null` means unlimited, `0` means sold out today.
   */
  readonly remainingToday: number | null;
  readonly prepTimeMinutes: number | null;
  readonly sortOrder: number;
}

export interface MenuCategoryView {
  readonly id: string;
  readonly name: string;
  readonly nameEn: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly items: readonly MenuItemView[];
}

/** List projection — everything a card in a discovery grid needs, nothing more. */
export interface MerchantSummaryView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly nameEn: string | null;
  readonly description: string | null;
  readonly status: MerchantStatus;
  readonly district: string | null;
  readonly region: string;
  readonly addressLine1: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly logoKey: string | null;
  readonly coverImageKey: string | null;
  readonly prepTimeMinutes: number;
  readonly pickupWindowMinutes: number;
  readonly acceptsOrders: boolean;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  /** Straight-line km from the requested origin. `null` when no origin given. */
  readonly distanceKm: number | null;
}

/** Detail projection — adds the menu, hours and the fields only an owner sees. */
export interface MerchantDetailView extends MerchantSummaryView {
  readonly phone: string | null;
  readonly addressLine2: string | null;
  readonly timezone: string;
  readonly acceptTimeoutMinutes: number;
  readonly autoAcceptOrders: boolean;
  readonly hours: readonly OperatingHourView[];
  readonly categories: readonly MenuCategoryView[];
}

/** Owner-facing projection: the raw row, including what is hidden from customers. */
export interface OwnedMerchantView {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly nameEn: string | null;
  readonly description: string | null;
  readonly status: MerchantStatus;
  readonly acceptsOrders: boolean;
  readonly autoAcceptOrders: boolean;
  readonly phone: string | null;
  readonly district: string | null;
  readonly region: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly logoKey: string | null;
  readonly coverImageKey: string | null;
  readonly prepTimeMinutes: number;
  readonly pickupWindowMinutes: number;
  readonly acceptTimeoutMinutes: number;
  readonly timezone: string;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  readonly isOwner: boolean;
  readonly hours: readonly OperatingHourView[];
}

/**
 * The owner's menu editor payload.
 *
 * `uncategorised` is a separate bucket rather than a synthetic category: a
 * menu item may legitimately have no category (`categoryId` is nullable, and
 * `ON DELETE SET NULL` can put an item there), and inventing a fake category id
 * would make the client send that id back on the next save.
 */
export interface OwnerMenuView {
  readonly merchantId: string;
  /** Merchant-local service date the `remainingToday` figures belong to. */
  readonly serviceDate: string;
  readonly categories: readonly MenuCategoryView[];
  readonly uncategorised: readonly MenuItemView[];
  readonly totals: {
    readonly categories: number;
    readonly items: number;
    readonly mainItems: number;
  };
}

/** One collectable time. Times are ISO 8601 UTC; `label` is merchant-local. */
export interface PickupSlotView {
  readonly startAt: string;
  readonly endAt: string;
  /** `HH:mm` in the merchant's timezone, for display next to the slot. */
  readonly label: string;
  /** 0 = today, 1 = tomorrow … in the merchant's timezone. Drives group headers. */
  readonly dayOffset: number;
}

/**
 * The bookable slots for a merchant.
 *
 * Served by the API rather than derived in the browser so the customer can only
 * ever pick a time the order endpoint will accept — the opening-hours and
 * lead-time rules have exactly one implementation.
 */
export interface PickupSlotsView {
  readonly merchantId: string;
  readonly timezone: string;
  readonly stepMinutes: number;
  /** How long the kitchen holds a collection slot open. */
  readonly windowMinutes: number;
  readonly earliestAt: string;
  readonly latestAt: string;
  /** True when the merchant is inside opening hours right now — enables 即時製作. */
  readonly acceptingNow: boolean;
  /**
   * Why not, when `acceptingNow` is false. `null` when the shop is open.
   *
   * One of `NO_HOURS_CONFIGURED` | `CLOSED_TODAY` | `CLOSED_FOR_CLOSURE` |
   * `OUTSIDE_HOURS`. The customer app shows a different line for each rather
   * than a generic 「暫停接單」 — a rest day the shop planned is not the same
   * thing as closing time, and confusing the two makes the shop look broken.
   */
  readonly closedReason: string | null;
  /**
   * The first 特別休息日 inside the booking horizon, `YYYY-MM-DD`, or `null`.
   *
   * Deliberately singular: the banner says "this shop is shut on <date>". A
   * shop planning a week off gets a week of closed slots and one date — the
   * slots are the list, and repeating them in prose would be noise.
   */
  readonly closureDate: string | null;
  readonly slots: readonly PickupSlotView[];
}

// ============================================================================
//  商戶營業報表 — BI entitlement and the report itself
// ============================================================================

/**
 * The user-facing marker for what a shop has bought.
 *
 * Exposed as its own nested object rather than flattened into the report,
 * because it is the answer to a *different question* ("what does this shop
 * have?") and the settings screen, the report page and the admin console all
 * read it. Flattening it into three different views is how the three end up
 * disagreeing about what a tier is called.
 */
export interface AnalyticsTierView {
  readonly tier: AnalyticsTier;
  /** 標準 / 進階報表 / 專業報表 — the label the owner sees. */
  readonly label: string;
  /** One line describing what it buys, for the upgrade prompt. */
  readonly blurb: string;
  /** True for BASIC and PRO — drives the badge on the merchant's own page. */
  readonly isPaid: boolean;
  /** The capability names this tier unlocks, in render order. */
  readonly capabilities: readonly string[];
  /**
   * Always `true`, on every tier including `NONE`.
   *
   * Carried in the response rather than left implicit so the page cannot
   * "helpfully" hide the export button for a free shop — the one thing a
   * free-tier merchant must be able to do is take their own data out.
   */
  readonly canExportRawData: boolean;
}

/** Revenue / orders / money for one trading day. */
export interface AnalyticsDailyRowView {
  /** Merchant-local `YYYY-MM-DD`. */
  readonly date: string;
  readonly orderCount: number;
  /** Orders attempted that day which never traded. */
  readonly voidCount: number;
  readonly revenueMinor: number;
  readonly platformFeeMinor: number;
  readonly payoutMinor: number;
  readonly averageOrderValueMinor: number;
}

export interface AnalyticsItemRowView {
  readonly name: string;
  readonly quantity: number;
  readonly revenueMinor: number;
  readonly isMainItem: boolean;
}

export interface AnalyticsHourRowView {
  readonly hour: number;
  readonly orderCount: number;
  readonly revenueMinor: number;
}

export interface AnalyticsChannelRowView {
  readonly key: string;
  readonly orderCount: number;
  readonly revenueMinor: number;
}

/** The whole report, as the merchant's report page reads it. */
export interface MerchantAnalyticsView {
  readonly merchantId: string;
  readonly tier: AnalyticsTierView;
  /** The window the figures cover. `to` is inclusive. */
  readonly window: {
    readonly from: string;
    readonly to: string;
    readonly days: number;
  };
  readonly totals: {
    readonly orderCount: number;
    readonly voidCount: number;
    readonly revenueMinor: number;
    readonly platformFeeMinor: number;
    readonly payoutMinor: number;
    readonly averageOrderValueMinor: number;
    readonly itemCount: number;
  };
  /**
   * The previous, equal-length window. `null` on a tier without `COMPARISON`,
   * which is the whole difference between BASIC and PRO.
   */
  readonly comparison: {
    readonly label: string;
    readonly from: string;
    readonly to: string;
    /** `null` when the previous window had no baseline to compare against. */
    readonly revenueChangePercent: number | null;
    readonly orderCountChangePercent: number | null;
    readonly averageOrderValueChangePercent: number | null;
  } | null;
  /**
   * Empty arrays rather than omitted keys on a tier that lacks the capability.
   *
   * An empty `daily` and a missing `daily` render differently in a client that
   * does `view.daily.map(...)`, and the report page has to work for a `NONE`
   * shop too. The tier block is what says *why* it is empty.
   */
  readonly daily: readonly AnalyticsDailyRowView[];
  readonly itemMix: readonly AnalyticsItemRowView[];
  readonly hourOfDay: readonly AnalyticsHourRowView[];
  readonly channels: readonly AnalyticsChannelRowView[];
}

/** The result of asking to set a shop's tier, including the downgrade warning. */
export interface AnalyticsTierWriteView {
  readonly merchantId: string;
  readonly before: AnalyticsTierView;
  readonly after: AnalyticsTierView;
  /** True when capabilities were taken away. */
  readonly isDowngrade: boolean;
  /** What the operator is told before confirming a downgrade. `null` otherwise. */
  readonly warning: string | null;
  readonly message: string;
}

/**
 * Build the tier block.
 *
 * Lives next to the interface rather than in a service because there are three
 * callers — the admin console, the merchant's report page and the settings
 * screen — and a second implementation of "what is this tier called" is exactly
 * how the admin console ends up saying 專業 while the merchant's page says PRO.
 */
export function analyticsTierView(tier: AnalyticsTier): AnalyticsTierView {
  return {
    tier,
    label: ANALYTICS_TIER_LABEL[tier],
    blurb: ANALYTICS_TIER_BLURB[tier],
    isPaid: isPaidAnalyticsTier(tier),
    capabilities: [...analyticsCapabilities(tier)],
    canExportRawData: canExportRawData(tier),
  };
}

/**
 * The capabilities a downgrade takes away, as prose.
 *
 * Reports what is LOST rather than what remains: an operator confirming a
 * downgrade needs to know what the shop is about to stop seeing, and "you keep
 * the daily rollup" is the answer to a different question.
 */
export function describeLostCapabilities(
  before: AnalyticsTier,
  after: AnalyticsTier,
): string {
  const lost = analyticsCapabilities(before).filter(
    (capability) => !analyticsCapabilities(after).includes(capability),
  );
  if (lost.length === 0) return '任何功能';
  return lost.map((capability) => CAPABILITY_LABEL[capability]).join('、');
}

const CAPABILITY_LABEL: Readonly<Record<AnalyticsCapability, string>> = {
  DAILY_ROLLUP: '每日營業額',
  ITEM_MIX: '菜品排行',
  HOUR_OF_DAY: '時段分佈',
  CHANNEL_MIX: '取餐／付款方式分佈',
  COMPARISON: '同期比較',
};


