/**
 * 商戶營業報表 — what a shop is entitled to see, and what it is not.
 *
 * Two separate questions live here, and keeping them separate is the whole
 * point of this file:
 *
 *   1. **Is this shop entitled to the feature at all?** That is the tier,
 *      a commercial fact about the merchant. It does not depend on who is
 *      looking, and it must not: the entitled manager leaves, the entitlement
 *      stays with the shop.
 *   2. **What may this tier see inside the feature?** That is a capability
 *      question, answered by `analyticsCapabilities()`.
 *
 * The raw Excel export is **free for every tier, including `NONE`**. It is the
 * table, not the analysis: a shop that cannot get its own orders out in a
 * spreadsheet is a shop that cannot do its own bookkeeping, and charging for
 * that would be charging for access to data the shop already owns. The paid
 * tiers buy *computation* — aggregation, comparison windows, cohorts.
 */

/**
 * What a merchant has bought.
 *
 * Mirrors `AnalyticsTier` in the Prisma schema, but is declared here because
 * the authorisation rules are business logic and must be unit-testable without
 * a database. The two are kept in step at the repository boundary.
 */
export enum AnalyticsTier {
  /** Free. Raw rows only — the export every shop gets. */
  NONE = 'NONE',
  /** Computed aggregates: revenue by day, item mix, hour-of-day. */
  BASIC = 'BASIC',
  /** Everything, including comparison windows. */
  PRO = 'PRO',
}

/** A single thing a report page can ask to render. */
export type AnalyticsCapability =
  /** Daily revenue / order / payout roll-up over a date range. */
  | 'DAILY_ROLLUP'
  /** Which items sold, how many, and what they contributed. */
  | 'ITEM_MIX'
  /** Orders bucketed by hour of the merchant-local day. */
  | 'HOUR_OF_DAY'
  /** The same window one period earlier, side by side. */
  | 'COMPARISON'
  /** Fulfilment / payment-mode split, incl. walk-in and dine-in. */
  | 'CHANNEL_MIX';

/**
 * Which capabilities each tier unlocks.
 *
 * `NONE` is deliberately **not** empty of all reporting — the export is
 * unconditional and lives outside this table, because a capability map is the
 * wrong place to encode "you may have your own data".
 */
const CAPABILITIES: Readonly<Record<AnalyticsTier, readonly AnalyticsCapability[]>> = {
  [AnalyticsTier.NONE]: [],
  [AnalyticsTier.BASIC]: ['DAILY_ROLLUP', 'ITEM_MIX', 'HOUR_OF_DAY', 'CHANNEL_MIX'],
  [AnalyticsTier.PRO]: [
    'DAILY_ROLLUP',
    'ITEM_MIX',
    'HOUR_OF_DAY',
    'CHANNEL_MIX',
    'COMPARISON',
  ],
};

/** Human-facing label, used by both the merchant's own page and the admin console. */
export const ANALYTICS_TIER_LABEL: Readonly<Record<AnalyticsTier, string>> = {
  [AnalyticsTier.NONE]: '標準',
  [AnalyticsTier.BASIC]: '進階報表',
  [AnalyticsTier.PRO]: '專業報表',
};

/** One line describing what the tier buys, for the upgrade prompt. */
export const ANALYTICS_TIER_BLURB: Readonly<Record<AnalyticsTier, string>> = {
  [AnalyticsTier.NONE]: '訂單明細與 Excel 匯出，永久免費。',
  [AnalyticsTier.BASIC]: '營業額趨勢、菜品排行、時段分佈。',
  [AnalyticsTier.PRO]: '包含進階報表全部功能，另加同期比較。',
};

const TIER_ORDER: Readonly<Record<AnalyticsTier, number>> = {
  [AnalyticsTier.NONE]: 0,
  [AnalyticsTier.BASIC]: 1,
  [AnalyticsTier.PRO]: 2,
};

/** Parse a stored string without trusting it — an unknown value degrades to `NONE`. */
export function toAnalyticsTier(value: string | null | undefined): AnalyticsTier {
  switch (value) {
    case AnalyticsTier.BASIC:
      return AnalyticsTier.BASIC;
    case AnalyticsTier.PRO:
      return AnalyticsTier.PRO;
    default:
      // Fail CLOSED. A typo in a config row must not hand out paid features.
      return AnalyticsTier.NONE;
  }
}

/**
 * Whether this tier unlocks a given capability.
 *
 * The entitlement is derived from the tier table rather than stored per
 * merchant, so adding a capability is one edit here instead of a migration.
 */
export function hasAnalyticsCapability(
  tier: AnalyticsTier,
  capability: AnalyticsCapability,
): boolean {
  return CAPABILITIES[tier].includes(capability);
}

/** Everything this tier may render, for the page to decide what to hide. */
export function analyticsCapabilities(tier: AnalyticsTier): readonly AnalyticsCapability[] {
  return CAPABILITIES[tier];
}

/**
 * Whether a shop is on a **paid** reporting plan.
 *
 * Used for the user-facing marker ("進階報表") that the owner asked for, and to
 * decide whether the upgrade prompt is worth showing. It is *not* an
 * authorisation check — use `hasAnalyticsCapability` for those.
 */
export function isPaidAnalyticsTier(tier: AnalyticsTier): boolean {
  return TIER_ORDER[tier] > TIER_ORDER[AnalyticsTier.NONE];
}

/** Compare two tiers, for "downgrade warning" copy. */
export function analyticsTierRank(tier: AnalyticsTier): number {
  return TIER_ORDER[tier];
}

/** Whether `next` is a downgrade from `current`. */
export function isAnalyticsDowngrade(current: AnalyticsTier, next: AnalyticsTier): boolean {
  return TIER_ORDER[next] < TIER_ORDER[current];
}

/**
 * The export is licence-free on purpose: **every** tier may take the raw data.
 *
 * Exposed as a function rather than a constant so the rule has one name and can
 * be asserted in a test — a comment saying "this is free" is not a rule.
 */
export function canExportRawData(_tier: AnalyticsTier): boolean {
  return true;
}
