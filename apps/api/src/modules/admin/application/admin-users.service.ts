import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { Actor } from '../../../common/auth/actor';
import { diffFields } from '../../../common/util/diff';
import { paginate } from '../../../common/validation/query';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AdminTargetNotFoundError, LastAdminError, SelfModificationError } from '../domain/admin.errors';
import { AdminUserView } from '../interface/admin.views';
import { AdminUserQueryDto, UpdateUserDto } from '../interface/dto/admin.dto';

const userSelect = {
  id: true,
  displayName: true,
  phone: true,
  email: true,
  role: true,
  isActive: true,
  locale: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

type UserRow = {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
  role: UserRole;
  isActive: boolean;
  locale: string;
  lastLoginAt: Date | null;
  createdAt: Date;
};

/**
 * User administration.
 *
 * Two rules protect the platform from its own operators:
 *
 *  1. **An admin cannot demote or disable themselves.** Otherwise a single
 *     mis-click removes the console's only keyholder and there is no route back
 *     in that does not involve the database.
 *  2. **The last enabled admin cannot be removed by anyone.** A peer demoting
 *     the final admin has the same effect, just less obviously.
 *
 * Disabling a user also revokes their live refresh tokens. That does not cut
 * them off instantly — `JwtAuthGuard` validates the access token's signature
 * without a database read, so an issued token stays valid for its remaining TTL
 * (15 minutes by default). Revoking the refresh tokens is what stops that
 * window from becoming the 30-day refresh lifetime.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: AdminUserQueryDto): Promise<{ data: AdminUserView[]; total: number }> {
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.q
        ? {
            OR: [
              { displayName: { contains: query.q, mode: 'insensitive' } },
              { phone: { contains: query.q } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { take, skip } = paginate(query);
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: userSelect,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: await this.decorate(rows), total };
  }

  async get(userId: string): Promise<AdminUserView> {
    const row = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!row) throw new AdminTargetNotFoundError('使用者', userId);
    return (await this.decorate([row]))[0];
  }

  async update(userId: string, dto: UpdateUserDto, actor: Actor): Promise<AdminUserView> {
    const current = await this.prisma.user.findUnique({ where: { id: userId }, select: userSelect });
    if (!current) throw new AdminTargetNotFoundError('使用者', userId);

    if (userId === actor.userId) {
      if (dto.role !== undefined && dto.role !== current.role) {
        throw new SelfModificationError('角色');
      }
      if (dto.isActive === false) throw new SelfModificationError('啟用狀態');
    }

    const roleDowngrade = dto.role !== undefined && dto.role !== UserRole.ADMIN;
    const losesAdmin =
      current.role === UserRole.ADMIN && (roleDowngrade || dto.isActive === false);
    if (losesAdmin) await this.assertAnotherAdminRemains(userId);

    const patch: Record<string, unknown> = {};
    if (dto.displayName !== undefined) patch.displayName = dto.displayName;
    if (dto.role !== undefined) patch.role = dto.role;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;
    if (dto.locale !== undefined) patch.locale = dto.locale;

    const diff = diffFields(current as unknown as Record<string, unknown>, patch);
    if (diff.changedKeys.length === 0) return this.get(userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: patch });

      let revoked = 0;
      if (dto.isActive === false) {
        const result = await tx.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        revoked = result.count;
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'user.update',
          targetType: 'User',
          targetId: userId,
          before: diff.before,
          after: { ...diff.after, ...(revoked > 0 ? { revokedSessions: revoked } : {}) },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.get(userId);
  }

  /** Force every device to sign in again — the response to a suspected compromise. */
  async revokeSessions(userId: string, actor: Actor): Promise<{ revoked: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new AdminTargetNotFoundError('使用者', userId);

    return this.prisma.$transaction(async (tx) => {
      const result = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'user.revoke_sessions',
          targetType: 'User',
          targetId: userId,
          after: { revoked: result.count },
          ip: actor.ip ?? null,
        },
        tx,
      );

      return { revoked: result.count };
    });
  }

  /**
   * Refuse to leave the platform with nobody who can administer it.
   *
   * Counts *enabled* admins excluding the target: an admin who is already
   * disabled does not count as a way back in.
   */
  private async assertAnotherAdminRemains(excludeUserId: string): Promise<void> {
    const remaining = await this.prisma.user.count({
      where: { role: UserRole.ADMIN, isActive: true, id: { not: excludeUserId } },
    });
    if (remaining === 0) {
      throw new LastAdminError('系統必須至少保留一位啟用中的管理員');
    }
  }

  /**
   * Attach the counts the console shows.
   *
   * Two queries for the whole page rather than per-row includes: `activeSessions`
   * needs a filter on `revokedAt`/`expiresAt`, which a plain relation count
   * cannot express, so it is a `groupBy` over the page's user ids.
   */
  private async decorate(rows: readonly UserRow[]): Promise<AdminUserView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    const [merchantCounts, staffCounts, orderCounts, sessionCounts] = await Promise.all([
      this.prisma.merchant.groupBy({
        by: ['ownerId'],
        where: { ownerId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.merchantStaff.groupBy({
        by: ['userId'],
        where: { userId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.order.groupBy({
        by: ['customerId'],
        where: { customerId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.refreshToken.groupBy({
        by: ['userId'],
        where: { userId: { in: ids }, revokedAt: null, expiresAt: { gt: new Date() } },
        _count: { _all: true },
      }),
    ]);

    const lookup = <T extends { _count: { _all: number } }>(
      groups: readonly T[],
      key: keyof T,
    ): Map<string, number> =>
      new Map(groups.map((group) => [String(group[key]), group._count._all]));

    const owned = lookup(merchantCounts, 'ownerId');
    const staff = lookup(staffCounts, 'userId');
    const orders = lookup(orderCounts, 'customerId');
    const sessions = lookup(sessionCounts, 'userId');

    return rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      phone: row.phone,
      email: row.email,
      role: row.role,
      isActive: row.isActive,
      locale: row.locale,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      ownedMerchantCount: owned.get(row.id) ?? 0,
      staffMerchantCount: staff.get(row.id) ?? 0,
      orderCount: orders.get(row.id) ?? 0,
      activeSessionCount: sessions.get(row.id) ?? 0,
    }));
  }
}
