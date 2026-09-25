import { Injectable } from '@nestjs/common';
import { MerchantStatus, OrderStatus, Prisma } from '@prisma/client';
import {
  ANALYTICS_TIER_LABEL,
  AnalyticsTier,
  isAnalyticsDowngrade,
  toAnalyticsTier,
} from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { ACTIVE_ORDER_STATUSES } from '../../../common/prisma-enums';
import { paginate } from '../../../common/validation/query';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ratingToNumber } from '../../merchants/application/catalog.read';
import { ownedMerchantSelect } from '../../merchants/application/merchant.service';
import {
  AnalyticsTierWriteView,
  analyticsTierView,
  describeLostCapabilities,
} from '../../merchants/interface/merchant.views';
import {
  allowedMerchantActions,
  applyMerchantAction,
} from '../../merchants/domain/merchant-status.machine';
import { AdminTargetNotFoundError } from '../domain/admin.errors';
import { AdminMerchantStatsView, AdminMerchantView } from '../interface/admin.views';
import { AdminMerchantQueryDto, MerchantActionDto } from '../interface/dto/admin.dto';

/**
 * Reuses the owner projection rather than re-listing the columns, so a field
 * added for the merchant portal cannot be missing from the console.
 */
const adminMerchantSelect = {
  ...ownedMerchantSelect,
  createdAt: true,
  owner: { select: { id: true, displayName: true, phone: true, email: true } },
  // Read here but NOT on `ownedMerchantSelect`: the merchant's own `/merchant/mine`
  // payload does not carry its tier, because the tier is a commercial fact the
  // report page reads from `/analytics` alongside the panels it gates. Adding it
  // to the owner projection would be a second source of truth for the same
  // string.
  analyticsTier: true,
} as const;

/**
 * Merchant administration — the approval queue and the lifecycle switches.
 *
 * The lifecycle itself is not implemented here: `applyMerchantAction` owns the
 * legal transitions and throws on an illegal one. This service only persists the
 * outcome and records who did it.
 */
@Injectable()
export class AdminMerchantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(
    query: AdminMerchantQueryDto,
  ): Promise<{ data: AdminMerchantView[]; total: number }> {
    const where: Prisma.MerchantWhereInput = {
      ...(query.status ? { status: query.status as MerchantStatus } : {}),
      ...(query.district ? { district: query.district } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { nameEn: { contains: query.q, mode: 'insensitive' } },
              { slug: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { take, skip } = paginate(query);
    const [rows, total] = await Promise.all([
      this.prisma.merchant.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take,
        skip,
        select: adminMerchantSelect,
      }),
      this.prisma.merchant.count({ where }),
    ]);

    // One stats pass for the whole page — a per-merchant query here would be a
    // textbook N+1 on the console's most-visited screen.
    const stats = await this.statsFor(rows.map((row) => row.id));

    return {
      data: rows.map((row) => toView(row, stats.get(row.id) ?? EMPTY_STATS)),
      total,
    };
  }

  async get(merchantId: string): Promise<AdminMerchantView> {
    const row = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: adminMerchantSelect,
    });
    if (!row) throw new AdminTargetNotFoundError('商戶', merchantId);

    const stats = await this.statsFor([merchantId]);
    return toView(row, stats.get(merchantId) ?? EMPTY_STATS);
  }

  /**
   * Approve, suspend, reinstate or close.
   *
   * Suspension and closure force `acceptsOrders` off: leaving it on would let a
   * paid order reach a kitchen nobody is watching. Approval deliberately does
   * *not* force it on — the merchant's own 接單/停單 switch stays theirs.
   */
  async act(
    merchantId: string,
    dto: MerchantActionDto,
    actor: Actor,
  ): Promise<AdminMerchantView> {
    const current = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, slug: true, name: true, status: true, acceptsOrders: true },
    });
    if (!current) throw new AdminTargetNotFoundError('商戶', merchantId);

    // Throws MERCHANT_STATUS_TRANSITION when the move is not legal from here.
    const outcome = applyMerchantAction(current.status, dto.action);

    await this.prisma.$transaction(async (tx) => {
      await tx.merchant.update({
        where: { id: merchantId },
        data: {
          status: outcome.to,
          ...(outcome.acceptsOrders === undefined
            ? {}
            : { acceptsOrders: outcome.acceptsOrders }),
        },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: `merchant.${dto.action.toLowerCase()}`,
          targetType: 'Merchant',
          targetId: merchantId,
          before: { status: outcome.from, acceptsOrders: current.acceptsOrders },
          after: {
            status: outcome.to,
            acceptsOrders: outcome.acceptsOrders ?? current.acceptsOrders,
            reason: dto.reason ?? null,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.get(merchantId);
  }

  /** The admin equivalent of 接單/停單, for when a merchant is unresponsive. */
  async setIntake(
    merchantId: string,
    accepting: boolean,
    actor: Actor,
  ): Promise<AdminMerchantView> {
    const current = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, acceptsOrders: true },
    });
    if (!current) throw new AdminTargetNotFoundError('商戶', merchantId);

    await this.prisma.$transaction(async (tx) => {
      await tx.merchant.update({ where: { id: merchantId }, data: { acceptsOrders: accepting } });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: accepting ? 'merchant.intake_open' : 'merchant.intake_paused',
          targetType: 'Merchant',
          targetId: merchantId,
          before: { acceptsOrders: current.acceptsOrders },
          after: { acceptsOrders: accepting, byPlatform: true },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.get(merchantId);
  }

  /**
   * 設定商戶報表權限 — set a shop's reporting entitlement.
   *
   * WHY THIS IS AN ADMIN ACT AND NOT A MERCHANT SETTING
   * ---------------------------------------------------
   * The tier is what the shop *bought*. If the merchant could set it, the paid
   * BI dashboard would be free, and the field would be a preference rather than
   * a commercial fact. It lives on the merchant row (not on the user) for the
   * same reason the schema says: a shop buys the feature, and the manager who
   * happens to hold the account today must not be able to take it with them.
   *
   * A downgrade is allowed but returns `warning`, because it silently removes
   * panels the shop may be using in a monthly process. The platform is entitled
   * to downgrade a non-paying shop — it just has to say so where an operator
   * sees it, rather than the shop discovering an empty comparison panel.
   */
  async setAnalyticsTier(
    merchantId: string,
    tier: AnalyticsTier,
    actor: Actor,
  ): Promise<AnalyticsTierWriteView> {
    const current = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, analyticsTier: true },
    });
    if (!current) throw new AdminTargetNotFoundError('商戶', merchantId);

    const before = toAnalyticsTier(current.analyticsTier);
    const isDowngrade = isAnalyticsDowngrade(before, tier);

    if (before !== tier) {
      await this.prisma.$transaction(async (tx) => {
        await tx.merchant.update({ where: { id: merchantId }, data: { analyticsTier: tier } });
        await this.audit.record(
          {
            actorId: actor.userId,
            actorRole: actor.role,
            action: isDowngrade ? 'merchant.analytics_downgrade' : 'merchant.analytics_upgrade',
            targetType: 'Merchant',
            targetId: merchantId,
            before: { analyticsTier: before },
            after: { analyticsTier: tier },
            ip: actor.ip ?? null,
          },
          tx,
        );
      });
    }

    return {
      merchantId,
      before: analyticsTierView(before),
      after: analyticsTierView(tier),
      isDowngrade,
      warning: isDowngrade
        ? `降級後此商戶將無法使用${describeLostCapabilities(before, tier)}，已匯出的檔案不受影響。`
        : null,
      message:
        before === tier
          ? `商戶報表權限維持於「${ANALYTICS_TIER_LABEL[tier]}」。`
          : `商戶報表權限已由「${ANALYTICS_TIER_LABEL[before]}」改為「${ANALYTICS_TIER_LABEL[tier]}」。`,
    };
  }

  /**
   * Per-merchant counters for a set of ids.
   *
   * Six grouped queries regardless of page size, and all of them hit an index
   * that already exists for the operational queries (`merchantId, status`).
   */
  private async statsFor(merchantIds: readonly string[]): Promise<Map<string, AdminMerchantStatsView>> {
    if (merchantIds.length === 0) return new Map();
    const ids = [...merchantIds];

    const [menuItems, categories, activeOrders, totalOrders, pendingPayouts, completedOrders] =
      await Promise.all([
        this.prisma.menuItem.groupBy({
          by: ['merchantId'],
          where: { merchantId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.menuCategory.groupBy({
          by: ['merchantId'],
          where: { merchantId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['merchantId'],
          where: { merchantId: { in: ids }, status: { in: [...ACTIVE_ORDER_STATUSES] } },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['merchantId'],
          where: { merchantId: { in: ids } },
          _count: { _all: true },
        }),
        this.prisma.merchantPayout.groupBy({
          by: ['merchantId'],
          where: { merchantId: { in: ids }, status: { in: ['PENDING', 'PROCESSING'] } },
          _sum: { netPayoutMinor: true },
        }),
        this.prisma.order.groupBy({
          by: ['merchantId'],
          where: { merchantId: { in: ids }, status: OrderStatus.COMPLETED },
          _sum: { subtotalMinor: true },
        }),
      ]);

    const countOf = (
      groups: readonly { merchantId: string; _count: { _all: number } }[],
    ): Map<string, number> =>
      new Map(groups.map((group) => [group.merchantId, group._count._all]));

    const items = countOf(menuItems);
    const cats = countOf(categories);
    const active = countOf(activeOrders);
    const total = countOf(totalOrders);
    const pending = new Map(
      pendingPayouts.map((group) => [group.merchantId, Number(group._sum.netPayoutMinor ?? 0n)]),
    );
    const gmv = new Map(
      completedOrders.map((group) => [group.merchantId, group._sum.subtotalMinor ?? 0]),
    );

    return new Map(
      ids.map((id) => [
        id,
        {
          menuItems: items.get(id) ?? 0,
          categories: cats.get(id) ?? 0,
          activeOrders: active.get(id) ?? 0,
          totalOrders: total.get(id) ?? 0,
          pendingPayoutMinor: pending.get(id) ?? 0,
          lifetimeGmvMinor: gmv.get(id) ?? 0,
        },
      ]),
    );
  }
}

const EMPTY_STATS: AdminMerchantStatsView = {
  menuItems: 0,
  categories: 0,
  activeOrders: 0,
  totalOrders: 0,
  pendingPayoutMinor: 0,
  lifetimeGmvMinor: 0,
};

function toView(
  row: Omit<
    AdminMerchantView,
    'stats' | 'allowedActions' | 'owner' | 'createdAt' | 'ratingAvg' | 'analytics'
  > & {
    readonly ownerId: string;
    /** The raw column is a `Date`; the view renders ISO strings. */
    readonly createdAt: Date;
    /** Prisma `Decimal` arrives as a string or a number — normalise on read. */
    readonly ratingAvg: unknown;
    /** Stored as a plain string; parsed through `toAnalyticsTier`, which fails closed. */
    readonly analyticsTier: string;
    readonly owner: {
      id: string;
      displayName: string;
      phone: string | null;
      email: string | null;
    } | null;
  },
  stats: AdminMerchantStatsView,
): AdminMerchantView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.nameEn,
    description: row.description,
    status: row.status,
    acceptsOrders: row.acceptsOrders,
    autoAcceptOrders: row.autoAcceptOrders,
    phone: row.phone,
    district: row.district,
    region: row.region,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    latitude: row.latitude,
    longitude: row.longitude,
    logoKey: row.logoKey,
    coverImageKey: row.coverImageKey,
    prepTimeMinutes: row.prepTimeMinutes,
    pickupWindowMinutes: row.pickupWindowMinutes,
    acceptTimeoutMinutes: row.acceptTimeoutMinutes,
    timezone: row.timezone,
    ratingAvg: ratingToNumber(row.ratingAvg),
    ratingCount: row.ratingCount,
    hours: row.hours,
    createdAt: row.createdAt.toISOString(),
    owner: row.owner,
    stats,
    // Served so the console renders only buttons the API would accept.
    allowedActions: allowedMerchantActions(row.status),
    // Parsed through the fail-closed reader, so a typo in the column cannot
    // make the console offer a paid tier's panels.
    analytics: analyticsTierView(toAnalyticsTier(row.analyticsTier)),
  };
}
