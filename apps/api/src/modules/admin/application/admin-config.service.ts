import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { CancellationTier } from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { PricingConfigService } from '../../pricing/pricing.module';
import {
  ALL_CONFIG_SPECS,
  configNamespace,
  findConfigSpec,
  PricingConfigSpec,
  readConfigPath,
  validateConfigValue,
} from '../../pricing/pricing-config.registry';
import { PlatformConfigInvalidError } from '../domain/admin.errors';
import {
  CancellationPolicyView,
  PlatformConfigHistoryView,
  PlatformConfigView,
  PricingPolicyView,
} from '../interface/admin.views';
import { UpsertPlatformConfigDto } from '../interface/dto/admin.dto';

/** The two things a write to `platform_config` can be. */
type ConfigWriteAction = 'UPSERT' | 'DELETE' | 'ROLLBACK';

/**
 * Runtime configuration.
 *
 * The list endpoint returns the **registry union the stored rows**, not just the
 * rows. That matters: it means the console shows every knob the platform has,
 * including ones that have never been overridden, with the value that would
 * apply if the operator cleared them. A screen that only showed existing rows
 * would hide the existence of the setting entirely.
 *
 * Writes are validated against the registry, recorded in
 * `platform_config_history`, and then the live policies are reloaded in place —
 * so a fee change is in force on the next order rather than on the next deploy.
 *
 * The history table is not redundant with `AuditLog`. Audit answers "what did
 * this operator do"; history answers "what was this *key* set to on any past
 * date, and can I put it back" — which is the question actually asked when a
 * fee change turns out to have been a mistake.
 */
@Injectable()
export class AdminConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly pricing: PricingConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(): Promise<PlatformConfigView[]> {
    const keys = ALL_CONFIG_SPECS.map((spec) => spec.key);
    const rows = await this.prisma.platformConfig.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const names = await this.displayNames(rows.map((row) => row.updatedById));
    const pricing = this.pricing.currentPolicy;
    const cancellation = this.pricing.cancellationPolicy;

    return ALL_CONFIG_SPECS.map((spec) => {
      const row = byKey.get(spec.key);
      const parsed = row ? validateConfigValue(spec, row.value) : null;
      const namespace = configNamespace(spec.key);

      return {
        key: spec.key,
        value: row?.value ?? null,
        valueType: parsed?.ok === true ? spec.type : row ? typeof row.value : spec.type,
        description: row?.description ?? spec.description,
        hasOverride: Boolean(row),
        updatedAt: row?.updatedAt.toISOString() ?? null,
        updatedById: row?.updatedById ?? null,
        updatedByName: row?.updatedById ? (names.get(row.updatedById) ?? null) : null,
        isPricingKey: namespace === 'pricing',
        namespace,
        fallback: spec.envFallback(this.config),
        // Read off the live policy, so this figure is by construction the one
        // orders are priced (or refunds calculated) with — not a re-derivation
        // that could drift.
        effectiveValue: readConfigPath(
          namespace === 'cancellation' ? cancellation : pricing,
          spec.path,
        ),
      };
    });
  }

  /**
   * Create or update a key.
   *
   * An unknown key is refused. A `platform_config` row that no code reads looks
   * like it changed something and changes nothing, which is the worst possible
   * outcome for a configuration screen.
   */
  async upsert(key: string, dto: UpsertPlatformConfigDto, actor: Actor): Promise<PlatformConfigView> {
    const spec = this.requireSpec(key);
    const parsed = validateConfigValue(spec, dto.value);
    if (!parsed.ok) throw new PlatformConfigInvalidError(key, parsed.reason);

    await this.write(key, spec, parsed.value, dto.description ?? null, 'UPSERT', actor);
    await this.pricing.reload();

    const views = await this.list();
    return views.find((view) => view.key === key)!;
  }

  /**
   * Delete a row, reverting the key to its environment / code default.
   *
   * Not a "delete the setting" operation — the setting still exists, it just
   * stops being overridden. The response makes that visible by returning the
   * fallback that is now in force.
   */
  async remove(key: string, actor: Actor): Promise<PlatformConfigView> {
    const spec = this.requireSpec(key);

    const before = await this.prisma.platformConfig.findUnique({ where: { key } });
    if (before) {
      await this.write(key, spec, null, null, 'DELETE', actor);
      await this.pricing.reload();
    }
    // Idempotent either way: removing an override that is not there is already
    // the desired state, so it is not an error.

    const views = await this.list();
    return views.find((view) => view.key === key)!;
  }

  /**
   * Every recorded write for one key, newest first.
   *
   * Rows are never pruned. The table grows by one row per configuration change,
   * which for a platform with a handful of knobs is a rounding error next to
   * `order_status_events`.
   */
  async history(key: string, limit = 50): Promise<PlatformConfigHistoryView[]> {
    this.requireSpec(key);

    const rows = await this.prisma.platformConfigHistory.findMany({
      where: { key },
      orderBy: { changedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const names = await this.displayNames(rows.map((row) => row.changedById));

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      action: row.action,
      previousValue: row.previousValue ?? null,
      newValue: row.newValue ?? null,
      description: row.description ?? null,
      changedAt: row.changedAt.toISOString(),
      changedById: row.changedById ?? null,
      changedByName: row.changedById ? (names.get(row.changedById) ?? null) : null,
    }));
  }

  /**
   * Put a key back to the value it held in a given history row.
   *
   * This writes a **new** history row rather than deleting the ones in between.
   * A configuration trail with holes in it cannot answer "what was the fee on
   * 14 March", which is the only reason to keep one.
   *
   * Reverting to a row whose `previousValue` is `null` means removing the
   * override entirely, so the environment / code default comes back into force.
   */
  async rollback(key: string, historyId: string, actor: Actor): Promise<PlatformConfigView> {
    const spec = this.requireSpec(key);

    const target = await this.prisma.platformConfigHistory.findUnique({ where: { id: historyId } });
    if (!target || target.key !== key) {
      throw new NotFoundException(`No history entry ${historyId} for ${key}`);
    }

    const restore = target.previousValue ?? null;
    if (restore === null) {
      await this.write(key, spec, null, null, 'ROLLBACK', actor);
    } else {
      const parsed = validateConfigValue(spec, restore);
      if (!parsed.ok) {
        // Refused rather than coerced: an old row could predate a tightened
        // range, and silently writing an out-of-range value back is exactly how
        // a rollback becomes an outage.
        throw new PlatformConfigInvalidError(
          key,
          `無法還原：歷史值 ${JSON.stringify(restore)} 已不符合目前的規則（${parsed.reason}）`,
        );
      }
      await this.write(key, spec, parsed.value, target.description ?? null, 'ROLLBACK', actor);
    }

    await this.pricing.reload();

    const views = await this.list();
    return views.find((view) => view.key === key)!;
  }

  /** The policy in force right now, as a plain JSON snapshot. */
  currentPolicy(): PricingPolicyView {
    const policy = this.pricing.currentPolicy;
    return {
      platformFee: {
        feePerMainItemMinor: policy.platformFee.feePerMainItemMinor,
        currency: policy.platformFee.currency,
        countAddOnItems: policy.platformFee.countAddOnItems,
      },
      paymentFee: {
        rateBps: policy.paymentFee.rateBps,
        fixedMinor: policy.paymentFee.fixedMinor,
        chargeOn: policy.paymentFee.chargeOn,
      },
      customerServiceFeeMinor: policy.customerServiceFeeMinor,
      minimumPayoutMinor: policy.minimumPayoutMinor,
      source: this.pricing.currentSource,
    };
  }

  /** The cancellation policy in force right now. */
  currentCancellationPolicy(): CancellationPolicyView {
    const policy = this.pricing.cancellationPolicy;
    const refundBps: Record<string, number> = {};
    for (const tier of Object.values(CancellationTier)) {
      refundBps[tier] = policy.refundBps[tier];
    }
    return {
      graceMinutes: policy.graceMinutes,
      refundBps,
      source: this.pricing.currentSource,
    };
  }

  private requireSpec(key: string): PricingConfigSpec {
    const spec = findConfigSpec(key);
    if (!spec) {
      throw new PlatformConfigInvalidError(
        key,
        `未知的設定鍵。可設定的鍵為：${ALL_CONFIG_SPECS.map((entry) => entry.key).join('、')}`,
      );
    }
    return spec;
  }

  /**
   * The one place a `platform_config` row changes.
   *
   * Every path — set, clear, roll back — goes through here, so it is impossible
   * to add a fourth one that forgets to write history. The row, the history
   * entry and the audit entry land in a single transaction: a fee that changed
   * without a record of who changed it is the failure mode this exists to
   * prevent.
   */
  private async write(
    key: string,
    spec: PricingConfigSpec,
    value: number | boolean | null,
    description: string | null,
    action: ConfigWriteAction,
    actor: Actor,
  ): Promise<void> {
    const before = await this.prisma.platformConfig.findUnique({ where: { key } });

    await this.prisma.$transaction(async (tx) => {
      if (value === null) {
        await tx.platformConfig.deleteMany({ where: { key } });
      } else {
        await tx.platformConfig.upsert({
          where: { key },
          update: {
            value: value as never,
            description: description ?? before?.description ?? spec.description,
            updatedById: actor.userId,
          },
          create: {
            key,
            value: value as never,
            description: description ?? spec.description,
            updatedById: actor.userId,
          },
        });
      }

      await tx.platformConfigHistory.create({
        data: {
          key,
          action,
          previousValue: (before?.value ?? null) as never,
          newValue: (value ?? null) as never,
          description: description ?? before?.description ?? spec.description,
          changedById: actor.userId,
        },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action:
            action === 'UPSERT'
              ? 'platform_config.update'
              : action === 'DELETE'
                ? 'platform_config.delete'
                : 'platform_config.rollback',
          targetType: 'PlatformConfig',
          targetId: null,
          before: { key, value: before?.value ?? null },
          after:
            value === null
              ? { key, value: spec.envFallback(this.config), revertedToDefault: true }
              : { key, value },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
  }

  private async displayNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map();

    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
