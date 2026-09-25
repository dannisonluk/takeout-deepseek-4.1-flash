import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import {
  CancellationPolicy,
  CancellationPolicyEngine,
  CancellationQuote,
  CancellationQuoteRequest,
  CancellationTier,
  DeepPartial,
  PricingEngine,
  PricingPolicy,
} from '@takeout/domain';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { PRICING_ENGINE } from '../../common/tokens';
import {
  CANCELLATION_CONFIG_SPECS,
  configNamespace,
  PRICING_CONFIG_SPECS,
  PricingConfigSpec,
  setConfigPath,
  validateConfigValue,
} from './pricing-config.registry';

/** Re-exported so feature modules can import the token from either place. */
export { PRICING_ENGINE };

/** Which layer supplied the live policy — surfaced on the admin config screen. */
export type PricingSource = 'platform_config' | 'environment' | 'runtime';

/**
 * Owns the two runtime-tunable policies for the process: what an order costs
 * (`PricingEngine`) and what a cancellation refunds
 * (`CancellationPolicyEngine`).
 *
 * Resolution order for both: `platform_config` row -> environment variable ->
 * code default.
 *
 * Each policy is immutable once resolved, and the pricing engine snapshots it
 * once per call, so an order priced while a config change is being applied sees
 * either the whole old rate or the whole new one — never half of each.
 */
@Injectable()
export class PricingConfigService implements OnModuleInit {
  private readonly logger = new Logger(PricingConfigService.name);
  /**
   * One engine for the lifetime of the process, whose policy is *replaced in
   * place*. Never reassign this field: the DI token hands this exact object to
   * `PlaceOrderUseCase` and friends, so a new instance would be invisible to
   * them. See `PricingEngine.usePolicy()`.
   */
  private readonly engine: PricingEngine;
  /**
   * The cancellation engine, replaced wholesale on reload.
   *
   * `CancellationPolicyEngine` is immutable by design — `withPolicy` returns a
   * *new* engine, because the policy is a per-request input and a shared
   * mutable one would let concurrent requests price each other's cancellations.
   * So unlike `engine`, this field is reassigned.
   *
   * That is safe **only** because nothing outside this class holds the engine:
   * `PRICING_ENGINE` is a DI token, and a token pointing at the old engine is
   * exactly the stale-reference bug documented in `init()`. Consumers therefore
   * call `quoteCancellation()`, which reads the current field, rather than
   * injecting an engine.
   */
  private cancellation = new CancellationPolicyEngine();
  /** In-flight or completed first load. Guarantees exactly one DB read. */
  private loading?: Promise<void>;
  private source: PricingSource = 'environment';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.engine = new PricingEngine(this.envPolicy());
  }

  /** Safety net for consumers that inject this service directly. Idempotent. */
  async onModuleInit(): Promise<void> {
    await this.init();
  }

  /**
   * Reads `platform_config` and installs the resolved policies.
   *
   * Idempotent: the first call does the work and every later caller awaits the
   * same promise.
   *
   * `PRICING_ENGINE` is produced by an ASYNC factory that awaits this before
   * resolving. That ordering is load-bearing. If the token were resolved by a
   * sync factory while the DB read happened in `onModuleInit`, the token would
   * already hold the env-only engine and the injected reference would never be
   * replaced — the `platform_config` rows would be read, logged, and then
   * silently ignored, and every order would be priced at the code default.
   */
  init(): Promise<void> {
    this.loading ??= this.applyResolvedPolicy();
    return this.loading;
  }

  /**
   * Re-read `platform_config` and swap the policies in, without a restart.
   *
   * Called by the admin config API. A fee change must take effect on the next
   * order, not on the next deploy — otherwise the operator changes the number,
   * watches nothing happen, and concludes the screen is broken.
   */
  async reload(): Promise<void> {
    this.loading = undefined;
    await this.init();
  }

  /** The engine in force right now. */
  get current(): PricingEngine {
    return this.engine;
  }

  /** The policy in force right now — a plain snapshot for the admin screen. */
  get currentPolicy(): PricingPolicy {
    return this.engine.currentPolicy;
  }

  get currentSource(): PricingSource {
    return this.source;
  }

  /** The cancellation policy in force right now, as a plain snapshot. */
  get cancellationPolicy(): CancellationPolicy {
    return this.cancellation.config;
  }

  /**
   * Price a cancellation using the policy in force.
   *
   * This is the only sanctioned way to reach the cancellation engine. Do not
   * add a DI token for it and do not cache the result of an accessor: the engine
   * is replaced on reload, so a held reference would silently keep applying the
   * refund percentages that were live when it was captured.
   */
  quoteCancellation(request: CancellationQuoteRequest): CancellationQuote {
    return this.cancellation.quote(request);
  }

  /**
   * Process-local policy override (tests).
   *
   * Observed by every holder of `PRICING_ENGINE`, because the policy is swapped
   * inside the one engine instance rather than by replacing the instance.
   */
  reconfigure(overrides: DeepPartial<PricingPolicy>): void {
    this.engine.usePolicy(overrides);
    this.source = 'runtime';
    this.logger.warn(
      `Pricing policy overridden at runtime: ` +
        `feePerMainItem=${this.engine.currentPolicy.platformFee.feePerMainItemMinor} minor units`,
    );
  }

  private async applyResolvedPolicy(): Promise<void> {
    const [pricingRows, cancellationRows] = await this.loadDbOverrides();

    /*
     * The env policy MUST be the base here, not the engine's code defaults.
     *
     * `new PricingEngine(overrides)` merges the overrides onto
     * `DEFAULT_PRICING_POLICY` — the *code* defaults. So passing only the DB
     * rows silently discards every environment variable that has no DB row,
     * and the documented middle layer becomes dead code: the resolved policy is
     * `DB -> code default`, not `DB -> env -> code default`. Merging the DB rows
     * onto `envPolicy()` is what restores the documented order.
     */
    // `usePolicy`, not a new engine — see the field comment on `engine`.
    this.engine.usePolicy(deepMerge(this.envPolicy(), pricingRows));

    const cancellationPolicy = this.resolveCancellationPolicy(cancellationRows);
    // Constructed, not mutated — the constructor is what range-checks every
    // ratio, so a bad `platform_config` row fails here rather than producing a
    // 150% refund on the next cancellation.
    this.cancellation = new CancellationPolicyEngine(cancellationPolicy);

    const hasOverrides = countLeaves(pricingRows) + countLeaves(cancellationRows) > 0;
    this.source = hasOverrides ? 'platform_config' : 'environment';

    const policy = this.engine.currentPolicy;
    this.logger.log(
      `Pricing policy resolved from ${this.source}: ` +
        `feePerMainItem=${policy.platformFee.feePerMainItemMinor} minor units, ` +
        `paymentFee=${policy.paymentFee.rateBps}bps+${policy.paymentFee.fixedMinor}`,
    );
    this.logger.log(
      `Cancellation policy resolved: grace=${cancellationPolicy.graceMinutes}min, ` +
        `free=${cancellationPolicy.refundBps[CancellationTier.FREE]}bps, ` +
        `noShow=${cancellationPolicy.refundBps[CancellationTier.NON_REFUNDABLE]}bps`,
    );
  }

  /**
   * The environment layer, derived from the registry.
   *
   * Deriving rather than hand-listing is what guarantees the keys the admin
   * console can edit are exactly the keys this service reads.
   */
  private envPolicy(): DeepPartial<PricingPolicy> {
    const policy: Record<string, unknown> = {
      platformFee: { currency: this.config.pricing.currency },
      paymentFee: { chargeOn: 'SUBTOTAL' },
    };

    for (const spec of PRICING_CONFIG_SPECS) {
      setConfigPath(policy, spec.path, spec.envFallback(this.config));
    }

    return policy as DeepPartial<PricingPolicy>;
  }

  /** The cancellation policy as it stands before any `platform_config` row. */
  private envCancellationPolicy(): Record<string, unknown> {
    const policy: Record<string, unknown> = {};
    for (const spec of CANCELLATION_CONFIG_SPECS) {
      setConfigPath(policy, spec.path, spec.envFallback(this.config));
    }
    return policy;
  }

  /**
   * Fold the DB rows for the cancellation namespace onto the environment layer
   * and shape the result into a `CancellationPolicy`.
   *
   * `deepMerge` of two `Record<string, unknown>` keeps this honest: a key the
   * operator never touched falls through to the environment value rather than
   * being lost, which is the same trap `applyResolvedPolicy` documents.
   */
  private resolveCancellationPolicy(rows: Record<string, unknown>): CancellationPolicy {
    const merged = deepMerge(this.envCancellationPolicy(), rows);
    const refundBps = merged.refundBps as Record<string, unknown>;
    const shaped: Record<string, number> = {};
    for (const tier of Object.values(CancellationTier)) {
      const value = refundBps[tier];
      shaped[tier] = typeof value === 'number' ? value : Number.NaN;
    }
    return {
      graceMinutes: Number(merged.graceMinutes),
      refundBps: shaped as unknown as CancellationPolicy['refundBps'],
    };
  }

  /**
   * Read both namespaces out of `platform_config` in one query.
   *
   * A malformed row is skipped with a warning rather than throwing: a
   * hand-edited value must not stop the API from booting, and must not silently
   * become a NaN. The environment value applies instead, and the log says so.
   */
  private async loadDbOverrides(): Promise<
    [Record<string, unknown>, Record<string, unknown>]
  > {
    try {
      const rows = await this.prisma.platformConfig.findMany({
        where: { key: { in: [...PRICING_CONFIG_SPECS, ...CANCELLATION_CONFIG_SPECS].map((s) => s.key) } },
      });
      const byKey = new Map(rows.map((row) => [row.key, row.value]));

      const pricing: Record<string, unknown> = {};
      const cancellation: Record<string, unknown> = {};

      for (const spec of [...PRICING_CONFIG_SPECS, ...CANCELLATION_CONFIG_SPECS]) {
        const raw = byKey.get(spec.key);
        if (raw === undefined) continue;

        const parsed = validateConfigValue(spec, raw);
        if (!parsed.ok) {
          this.logger.warn(
            `Ignoring invalid platform_config value for ${spec.key} (${parsed.reason}); ` +
              `using the environment default`,
          );
          continue;
        }

        setConfigPath(this.targetFor(spec, pricing, cancellation), spec.path, parsed.value);
      }

      return [pricing, cancellation];
    } catch (error) {
      // A config read failure must not stop the API from booting with env defaults.
      this.logger.warn(
        `Could not read platform_config, falling back to environment defaults: ${
          (error as Error).message
        }`,
      );
      return [{}, {}];
    }
  }

  /** Which of the two override objects a spec's key belongs to. */
  private targetFor(
    spec: PricingConfigSpec,
    pricing: Record<string, unknown>,
    cancellation: Record<string, unknown>,
  ): Record<string, unknown> {
    return configNamespace(spec.key) === 'cancellation' ? cancellation : pricing;
  }
}

/** Recursive merge of `patch` onto `base`. `undefined` leaves are skipped. */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>,
): T {
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const existing = output[key];
    const bothPlainObjects =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing);

    output[key] = bothPlainObjects
      ? deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return output as T;
}

/** Number of non-empty leaves — distinguishes "no rows" from "rows with no values". */
function countLeaves(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== 'object' || Array.isArray(value)) return 1;
  return Object.values(value).reduce<number>((sum, entry) => sum + countLeaves(entry), 0);
}

@Module({
  providers: [
    PricingConfigService,
    {
      provide: PRICING_ENGINE,
      /**
       * Async on purpose — the token must not resolve until `platform_config`
       * has been read. See `PricingConfigService.init()`.
       */
      useFactory: async (service: PricingConfigService): Promise<PricingEngine> => {
        await service.init();
        return service.current;
      },
      inject: [PricingConfigService],
    },
  ],
  exports: [PRICING_ENGINE, PricingConfigService],
})
export class PricingModule {}
