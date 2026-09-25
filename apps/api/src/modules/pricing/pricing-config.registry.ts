import { AppConfig } from '../../config/configuration';

/**
 * The registry of runtime-tunable settings.
 *
 * It began as pricing-only and now covers two namespaces — `pricing.*` (what an
 * order costs) and `cancellation.*` (what a cancellation refunds). Both resolve
 * the same way and both are edited from the same console screen, so they share
 * one registry; the namespace prefix is what decides which live policy a key
 * feeds.
 *
 * This is the single place that knows, for each `platform_config` key:
 *   * its type and legal range,
 *   * where the value lands inside the target policy,
 *   * what applies when no row exists (environment, then code default),
 *   * and the wording the admin console shows.
 *
 * Two things depend on it. `PricingConfigService` builds the live policies from
 * it, and `AdminConfigService` validates writes against it. Without a shared
 * registry the two drift, and the failure is quiet: the console accepts a value
 * the engine then ignores, or rejects one it would have honoured.
 *
 * A key that is NOT in this registry is refused rather than stored. A
 * `platform_config` row that no code reads is worse than no row at all — it
 * looks like it changed something.
 */
export type ConfigValueType = 'number' | 'boolean';

export interface PricingConfigSpec {
  /** The `platform_config.key`. */
  readonly key: string;
  /** Where the value lands inside the target policy. */
  readonly path: readonly string[];
  readonly type: ConfigValueType;
  /** Shown in the admin console, in the operator's language. */
  readonly description: string;
  readonly min?: number;
  readonly max?: number;
  /**
   * The value that applies when no `platform_config` row exists. Reads the
   * environment through `AppConfig`, which already applies the code default, so
   * this one function covers both lower layers of the resolution order.
   */
  readonly envFallback: (config: AppConfig) => number | boolean;
}

export const PRICING_CONFIG_SPECS: readonly PricingConfigSpec[] = [
  {
    key: 'pricing.platform_fee_per_main_item_minor',
    path: ['platformFee', 'feePerMainItemMinor'],
    type: 'number',
    min: 0,
    max: 1_000_000,
    description: '中介費：每件主餐收取的固定金額（minor units，350 = HK$3.50）',
    envFallback: (config) => config.pricing.feePerMainItemMinor,
  },
  {
    key: 'pricing.payment_fee_rate_bps',
    path: ['paymentFee', 'rateBps'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '支付手續費百分比（basis points，340 = 3.40%）',
    envFallback: (config) => config.payment.feeRateBps,
  },
  {
    key: 'pricing.payment_fee_fixed_minor',
    path: ['paymentFee', 'fixedMinor'],
    type: 'number',
    min: 0,
    max: 100_000,
    description: '支付手續費固定部分（minor units，235 = HK$2.35）',
    envFallback: (config) => config.payment.feeFixedMinor,
  },
  {
    key: 'pricing.count_add_on_items',
    path: ['platformFee', 'countAddOnItems'],
    type: 'boolean',
    description: '是否對加配菜／飲品亦收取按件中介費',
    envFallback: (config) => config.pricing.countAddOnItems,
  },
  {
    key: 'pricing.customer_service_fee_minor',
    path: ['customerServiceFeeMinor'],
    type: 'number',
    min: 0,
    max: 100_000,
    description: '向顧客收取的服務費（minor units，MVP 為 0）',
    envFallback: (config) => config.pricing.customerServiceFeeMinor,
  },
  {
    key: 'pricing.minimum_payout_minor',
    path: ['minimumPayoutMinor'],
    type: 'number',
    min: 0,
    max: 1_000_000,
    description: '商戶結算下限；低於此值會擲出 NEGATIVE_MERCHANT_PAYOUT',
    envFallback: (config) => config.pricing.minimumPayoutMinor,
  },
];

export function findPricingConfigSpec(key: string): PricingConfigSpec | undefined {
  return PRICING_CONFIG_SPECS.find((spec) => spec.key === key);
}

/**
 * Cancellation refund policy, tunable through exactly the same mechanism as the
 * pricing fee.
 *
 * These live in the same registry as the pricing keys rather than in a file of
 * their own for one concrete reason: `AdminConfigService` validates writes
 * against this registry and `PricingConfigService` builds the live policy from
 * it. Two registries would mean two resolution paths and two chances for the
 * console to accept a value the engine ignores.
 *
 * Every path lands inside `CancellationPolicy`. The tier segment is the literal
 * `CancellationTier` enum value, so the resolved object can be handed to
 * `new CancellationPolicyEngine(...)` without a translation layer.
 */
export const CANCELLATION_CONFIG_SPECS: readonly PricingConfigSpec[] = [
  {
    key: 'cancellation.grace_minutes',
    path: ['graceMinutes'],
    type: 'number',
    min: 0,
    max: 120,
    description: '商戶接單後幾分鐘內顧客仍可免費取消（「手誤」窗口）',
    envFallback: (config) => config.cancellation.graceMinutes,
  },
  {
    key: 'cancellation.refund_bps_free',
    path: ['refundBps', 'FREE'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '免費取消的退款比例（basis points，10000 = 全額）',
    envFallback: (config) => config.cancellation.refundBps.free,
  },
  {
    key: 'cancellation.refund_bps_late',
    path: ['refundBps', 'LATE'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '超過寬限期才取消的退款比例（廚房已備料）',
    envFallback: (config) => config.cancellation.refundBps.late,
  },
  {
    key: 'cancellation.refund_bps_non_refundable',
    path: ['refundBps', 'NON_REFUNDABLE'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '餐點已做好但顧客未取的退款比例',
    envFallback: (config) => config.cancellation.refundBps.nonRefundable,
  },
  {
    key: 'cancellation.refund_bps_merchant_fault',
    path: ['refundBps', 'MERCHANT_FAULT'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '商戶拒單或取消時的退款比例',
    envFallback: (config) => config.cancellation.refundBps.merchantFault,
  },
  {
    key: 'cancellation.refund_bps_platform_fault',
    path: ['refundBps', 'PLATFORM_FAULT'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '系統逾時導致訂單失效時的退款比例',
    envFallback: (config) => config.cancellation.refundBps.platformFault,
  },
  {
    key: 'cancellation.refund_bps_goodwill',
    path: ['refundBps', 'GOODWILL'],
    type: 'number',
    min: 0,
    max: 10_000,
    description: '管理員代顧客取消時的預設退款比例',
    envFallback: (config) => config.cancellation.refundBps.goodwill,
  },
];

/**
 * Every runtime-tunable key, across namespaces.
 *
 * The admin console iterates this; `PricingConfigService` splits it by the
 * prefix before the dot to decide which live policy a key feeds.
 */
export const ALL_CONFIG_SPECS: readonly PricingConfigSpec[] = [
  ...PRICING_CONFIG_SPECS,
  ...CANCELLATION_CONFIG_SPECS,
];

/** Namespace of a key — everything before the first dot. */
export function configNamespace(key: string): string {
  return key.slice(0, key.indexOf('.'));
}

export function findConfigSpec(key: string): PricingConfigSpec | undefined {
  return ALL_CONFIG_SPECS.find((spec) => spec.key === key);
}

export type ConfigValidation =
  | { readonly ok: true; readonly value: number | boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Type- and range-check a candidate value.
 *
 * Rejects non-integers explicitly. A fee of `3.5` minor units is meaningless —
 * there is no half cent — and `Number.isInteger` catches the class of bug where
 * a client sends major units (3.5) where minor units (350) are expected.
 */
export function validateConfigValue(spec: PricingConfigSpec, raw: unknown): ConfigValidation {
  if (spec.type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, reason: '必須是 true 或 false' };
    return { ok: true, value: raw };
  }

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, reason: '必須是數字' };
  }
  if (!Number.isInteger(raw)) {
    return { ok: false, reason: '必須是整數（minor units，HK$3.50 請填 350）' };
  }
  if (spec.min !== undefined && raw < spec.min) {
    return { ok: false, reason: `不可小於 ${spec.min}` };
  }
  if (spec.max !== undefined && raw > spec.max) {
    return { ok: false, reason: `不可大於 ${spec.max}` };
  }

  return { ok: true, value: raw };
}

/** Write `value` at `path`, creating intermediate plain objects as needed. */
export function setConfigPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

/**
 * Read `path` out of a resolved policy.
 *
 * Used by the admin console to show the value actually in force — reading it
 * from the live policy rather than re-deriving it means the screen cannot
 * disagree with what orders are being priced at.
 */
export function readConfigPath(source: unknown, path: readonly string[]): unknown {
  let cursor: unknown = source;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
