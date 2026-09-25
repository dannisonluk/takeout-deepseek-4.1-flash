import { Injectable } from '@nestjs/common';
import { MerchantStatus, OrderStatus, UserRole } from '@prisma/client';
import { ACTIVE_ORDER_STATUSES } from '../../../common/prisma-enums';
import { serviceDateIn } from '../../../common/time/service-date';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RedisService } from '../../../infrastructure/redis/redis.service';
import { AdminConfigService } from './admin-config.service';
import { DashboardStatsView } from '../interface/admin.views';

const HKT = 'Asia/Hong_Kong';

/**
 * The console landing page.
 *
 * Every figure is a single aggregate query rather than a loop over rows, and
 * "today" means today in the platform's operating timezone — an order placed at
 * 00:30 HKT belongs to that HKT day even though its UTC timestamp is the
 * previous one. Getting this wrong makes the daily numbers disagree with the
 * merchants' own reports, which is how a dashboard loses trust.
 */
@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: AdminConfigService,
  ) {}

  async stats(now: Date = new Date()): Promise<DashboardStatsView> {
    const today = serviceDateIn(HKT, now);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3_600_000);

    const [
      merchantGroups,
      acceptingOrders,
      todayOrders,
      activeOrders,
      orderStatusGroups,
      userGroups,
      activeToday,
      pendingPayouts,
      paidLast30Days,
      outboxGroups,
      oldestPending,
    ] = await Promise.all([
      this.prisma.merchant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.merchant.count({ where: { status: MerchantStatus.ACTIVE, acceptsOrders: true } }),
      this.prisma.order.aggregate({
        where: { serviceDate: today },
        _count: { _all: true },
        _sum: {
          subtotalMinor: true,
          platformFeeMinor: true,
          merchantPayoutMinor: true,
        },
      }),
      this.prisma.order.count({
        where: { status: { in: [...ACTIVE_ORDER_STATUSES] } },
      }),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['role'], _count: { _all: true } }),
      this.prisma.user.count({ where: { lastLoginAt: { gte: dayAgo } } }),
      this.prisma.merchantPayout.aggregate({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
        _count: { _all: true },
        _sum: { netPayoutMinor: true },
      }),
      this.prisma.merchantPayout.aggregate({
        where: { status: 'PAID', paidAt: { gte: monthAgo } },
        _sum: { netPayoutMinor: true },
      }),
      this.prisma.outboxEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.outboxEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);

    const disabledUsers = await this.prisma.user.count({ where: { isActive: false } });
    const merchantStatusCount = (status: MerchantStatus): number =>
      merchantGroups.find((group) => group.status === status)?._count._all ?? 0;
    const userRoleCount = (role: UserRole): number =>
      userGroups.find((group) => group.role === role)?._count._all ?? 0;
    const outboxCount = (status: string): number =>
      outboxGroups.find((group) => group.status === status)?._count._all ?? 0;

    return {
      generatedAt: now.toISOString(),
      merchants: {
        total: merchantGroups.reduce((sum, group) => sum + group._count._all, 0),
        active: merchantStatusCount(MerchantStatus.ACTIVE),
        pendingReview: merchantStatusCount(MerchantStatus.PENDING_REVIEW),
        suspended: merchantStatusCount(MerchantStatus.SUSPENDED),
        closed: merchantStatusCount(MerchantStatus.CLOSED),
        acceptingOrders,
      },
      orders: {
        today: todayOrders._count._all,
        todayGmvMinor: todayOrders._sum.subtotalMinor ?? 0,
        todayPlatformFeeMinor: todayOrders._sum.platformFeeMinor ?? 0,
        todayPayoutMinor: todayOrders._sum.merchantPayoutMinor ?? 0,
        active: activeOrders,
        byStatus: Object.fromEntries(
          orderStatusGroups.map((group) => [group.status, group._count._all]),
        ),
      },
      users: {
        total: userGroups.reduce((sum, group) => sum + group._count._all, 0),
        customers: userRoleCount(UserRole.CUSTOMER),
        merchantUsers:
          userRoleCount(UserRole.MERCHANT_OWNER) + userRoleCount(UserRole.MERCHANT_STAFF),
        admins: userRoleCount(UserRole.ADMIN),
        disabled: disabledUsers,
        activeToday,
      },
      payouts: {
        pendingCount: pendingPayouts._count._all,
        // BigInt from the aggregate: convert once, here, rather than letting a
        // BigInt reach JSON.stringify and throw at the edge.
        pendingNetMinor: Number(pendingPayouts._sum.netPayoutMinor ?? 0n),
        paidLast30DaysMinor: Number(paidLast30Days._sum.netPayoutMinor ?? 0n),
      },
      ops: {
        outboxPending: outboxCount('PENDING'),
        outboxFailed: outboxCount('FAILED'),
        outboxDeadLetter: outboxCount('DEAD_LETTER'),
        redisConnected: this.redis.isConnected,
        // A backlog with a stale head is the signature of a stuck relay — the
        // one ops problem that silently loses notifications.
        oldestPendingAt: oldestPending?.createdAt.toISOString() ?? null,
      },
      pricing: this.config.currentPolicy(),
    };
  }
}
