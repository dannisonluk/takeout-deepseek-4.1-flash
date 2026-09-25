import { Injectable } from '@nestjs/common';
import { MerchantStatus, Prisma, UserRole } from '@prisma/client';
import { Actor } from '../../../common/auth/actor';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { diffFields } from '../../../common/util/diff';
import {
  MerchantNotEditableError,
  MerchantSlugTakenError,
  OperatingHoursInvalidError,
} from '../domain/merchant.errors';
import { OperatingHourView, OwnedMerchantView } from '../interface/merchant.views';
import {
  CreateMerchantDto,
  OperatingHourDto,
  UpdateMerchantDto,
} from '../interface/dto/merchant.dto';

/**
 * Re-exported so the merchant controllers can name the type without importing
 * from `common/auth` as well. The definition lives in `common/auth/actor.ts`
 * because the admin module records audit entries with the same shape.
 */
export type { Actor };

/** Sensible starting hours so a newly approved merchant is immediately usable. */
const DEFAULT_OPEN_MINUTE = 11 * 60; // 11:00
const DEFAULT_CLOSE_MINUTE = 22 * 60; // 22:00

const ownedMerchantSelect = {
  id: true,
  slug: true,
  name: true,
  nameEn: true,
  description: true,
  status: true,
  acceptsOrders: true,
  autoAcceptOrders: true,
  phone: true,
  district: true,
  region: true,
  addressLine1: true,
  addressLine2: true,
  latitude: true,
  longitude: true,
  logoKey: true,
  coverImageKey: true,
  prepTimeMinutes: true,
  pickupWindowMinutes: true,
  acceptTimeoutMinutes: true,
  timezone: true,
  ratingAvg: true,
  ratingCount: true,
  ownerId: true,
  hours: {
    select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
    orderBy: { dayOfWeek: 'asc' },
  },
} as const;

/**
 * Merchant profile management.
 *
 * Deliberately does NOT expose `status`: approval and suspension are platform
 * decisions taken in the admin portal, not something an owner can set on
 * themselves. The omission is the authorisation boundary.
 */
@Injectable()
export class MerchantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 商戶申請入駐. The caller becomes the owner; approval is a separate admin act.
   *
   * Also promotes a plain customer to `MERCHANT_OWNER`, in the same
   * transaction. Without that the applicant owns a merchant but still presents
   * as a customer, so the web app would route them to the storefront and the
   * setup screens would be unreachable — the merchant is `PENDING_REVIEW`
   * either way, so this grants access to onboarding, not the ability to take
   * money.
   */
  async apply(ownerId: string, dto: CreateMerchantDto): Promise<OwnedMerchantView> {
    const existing = await this.prisma.merchant.findUnique({
      where: { slug: dto.slug },
      select: { id: true },
    });
    if (existing) throw new MerchantSlugTakenError(dto.slug);

    const merchant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.merchant.create({
        data: {
          ownerId,
          slug: dto.slug,
          name: dto.name,
          nameEn: dto.nameEn ?? null,
          description: dto.description ?? null,
          phone: dto.phone ?? null,
          addressLine1: dto.addressLine1,
          addressLine2: dto.addressLine2 ?? null,
          district: dto.district ?? null,
          region: dto.region ?? 'HK',
          latitude: dto.latitude,
          longitude: dto.longitude,
          timezone: dto.timezone ?? 'Asia/Hong_Kong',
          prepTimeMinutes: dto.prepTimeMinutes ?? 15,
          pickupWindowMinutes: dto.pickupWindowMinutes ?? 60,
          // Not ACTIVE. An unapproved merchant must not appear in discovery or
          // accept orders, and `findMerchantForOrdering` enforces that by status.
          status: MerchantStatus.PENDING_REVIEW,
          acceptsOrders: true,
          // A non-empty array: `create: []` is falsy and Prisma would drop the
          // nested write, leaving the merchant with no opening hours at all.
          hours: {
            create: Array.from({ length: 7 }, (_, dayOfWeek) => ({
              dayOfWeek,
              opensAtMinute: DEFAULT_OPEN_MINUTE,
              closesAtMinute: DEFAULT_CLOSE_MINUTE,
              isClosed: false,
            })),
          },
        },
        select: ownedMerchantSelect,
      });

      // The owner is also a member of their own staff. `resolveMerchantIds`
      // happens to union in merchants matched by `ownerId`, so a missing row
      // does not lock them out of the console today — but it does make the
      // owner invisible to anything that reads `merchant_staff` (the admin
      // user screen's staff count, and any future staff-level authorisation),
      // and it makes an applicant-created merchant behave differently from a
      // seeded one. One row, written in the same transaction as the merchant.
      await tx.merchantStaff.upsert({
        where: { merchantId_userId: { merchantId: created.id, userId: ownerId } },
        update: { isManager: true },
        create: { merchantId: created.id, userId: ownerId, isManager: true },
      });

      const applicant = await tx.user.findUnique({
        where: { id: ownerId },
        select: { role: true },
      });
      if (applicant && applicant.role === UserRole.CUSTOMER) {
        await tx.user.update({
          where: { id: ownerId },
          data: { role: UserRole.MERCHANT_OWNER },
        });
        await this.audit.record(
          {
            actorId: ownerId,
            actorRole: UserRole.MERCHANT_OWNER,
            action: 'user.role_change',
            targetType: 'User',
            targetId: ownerId,
            before: { role: UserRole.CUSTOMER },
            after: { role: UserRole.MERCHANT_OWNER, reason: 'merchant.apply' },
          },
          tx,
        );
      }

      await this.audit.record(
        {
          actorId: ownerId,
          actorRole: applicant?.role ?? UserRole.MERCHANT_OWNER,
          action: 'merchant.apply',
          targetType: 'Merchant',
          targetId: created.id,
          after: { slug: created.slug, name: created.name, status: created.status },
        },
        tx,
      );

      return created;
    });

    return this.toOwnedView(merchant, ownerId);
  }

  /** Merchants this principal owns or works for. */
  async listMine(userId: string, role: UserRole): Promise<OwnedMerchantView[]> {
    const rows = await this.prisma.merchant.findMany({
      where:
        role === UserRole.ADMIN
          ? {}
          : { OR: [{ ownerId: userId }, { staff: { some: { userId } } }] },
      select: ownedMerchantSelect,
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => this.toOwnedView(row, userId));
  }

  async getOwned(merchantId: string, viewerId: string): Promise<OwnedMerchantView> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: ownedMerchantSelect,
    });
    if (!merchant) throw new MerchantNotEditableError('UNKNOWN', '找不到此商戶');
    return this.toOwnedView(merchant, viewerId);
  }

  /**
   * The two columns the report needs: the shop's zone and its slug.
   *
   * A named narrow read rather than reusing `getOwned`, for the same reason
   * `MerchantClosureService.timezoneOf` exists: the report renders on every
   * page load, and projecting forty fields plus an `isOwner` flag to read two
   * is waste that shows up in a dashboard's latency. `null` rather than a throw
   * so the caller decides which HTTP answer a missing shop deserves.
   */
  async contextForAnalytics(
    merchantId: string,
  ): Promise<{ timezone: string; slug: string } | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { timezone: true, slug: true },
    });
    return merchant ?? null;
  }


  async update(
    merchantId: string,
    dto: UpdateMerchantDto,
    actor: Actor,
  ): Promise<OwnedMerchantView> {
    const current = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: ownedMerchantSelect,
    });
    if (!current) throw new MerchantNotEditableError('UNKNOWN', '找不到此商戶');

    // A closed merchant is read-only; a suspended one may fix its details so it
    // can be reinstated, but cannot go live by itself.
    if (current.status === MerchantStatus.CLOSED) {
      throw new MerchantNotEditableError(current.status, '已結業的商戶不可修改');
    }

    const diff = diffFields(current as unknown as Record<string, unknown>, dto as Record<string, unknown>);

    if (diff.changedKeys.length === 0) return this.toOwnedView(current, actor.userId);

    await this.prisma.$transaction(async (tx) => {
      await tx.merchant.update({
        where: { id: merchantId },
        data: {
          ...dto,
          ...(dto.nameEn === undefined ? {} : { nameEn: dto.nameEn || null }),
          ...(dto.description === undefined ? {} : { description: dto.description || null }),
          ...(dto.phone === undefined ? {} : { phone: dto.phone || null }),
          ...(dto.addressLine2 === undefined ? {} : { addressLine2: dto.addressLine2 || null }),
          ...(dto.district === undefined ? {} : { district: dto.district || null }),
          ...(dto.logoKey === undefined ? {} : { logoKey: dto.logoKey || null }),
          ...(dto.coverImageKey === undefined ? {} : { coverImageKey: dto.coverImageKey || null }),
        },
      });

      // Inside the transaction: an unaudited settings change must not commit.
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'merchant.update',
          targetType: 'Merchant',
          targetId: merchantId,
          before: diff.before,
          after: diff.after,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.getOwned(merchantId, actor.userId);
  }

  /** 接單 / 停單 — the switch the `MERCHANT_ACCEPTING` guard reads. */
  async setIntake(
    merchantId: string,
    accepting: boolean,
    actor: Actor,
  ): Promise<{ merchantId: string; accepting: boolean }> {
    const current = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { acceptsOrders: true, status: true },
    });
    if (!current) throw new MerchantNotEditableError('UNKNOWN', '找不到此商戶');

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
          after: { acceptsOrders: accepting },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return { merchantId, accepting };
  }

  /**
   * Replace the whole week.
   *
   * Validated as a set before anything is written: a merchant open 22:00–11:00
   * would make every pickup-slot check unsatisfiable, so it is rejected rather
   * than stored and debugged later.
   */
  async replaceHours(
    merchantId: string,
    hours: readonly OperatingHourDto[],
    actor: Actor,
  ): Promise<OperatingHourView[]> {
    const seen = new Set<number>();
    for (const hour of hours) {
      if (seen.has(hour.dayOfWeek)) {
        throw new OperatingHoursInvalidError(`星期 ${hour.dayOfWeek} 重複設定`, {
          dayOfWeek: hour.dayOfWeek,
        });
      }
      seen.add(hour.dayOfWeek);

      if (!hour.isClosed && hour.closesAtMinute <= hour.opensAtMinute) {
        throw new OperatingHoursInvalidError(
          `星期 ${hour.dayOfWeek} 的收店時間必須晚於開店時間（不支援跨夜營業）`,
          { dayOfWeek: hour.dayOfWeek, opensAtMinute: hour.opensAtMinute, closesAtMinute: hour.closesAtMinute },
        );
      }
    }

    const before = await this.prisma.merchantOperatingHour.findMany({
      where: { merchantId },
      select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
      orderBy: { dayOfWeek: 'asc' },
    });

    const saved = await this.prisma.$transaction(async (tx) => {
      const rows = await Promise.all(
        hours.map((hour) =>
          tx.merchantOperatingHour.upsert({
            where: { merchantId_dayOfWeek: { merchantId, dayOfWeek: hour.dayOfWeek } },
            update: {
              opensAtMinute: hour.opensAtMinute,
              closesAtMinute: hour.closesAtMinute,
              isClosed: hour.isClosed,
            },
            create: {
              merchantId,
              dayOfWeek: hour.dayOfWeek,
              opensAtMinute: hour.opensAtMinute,
              closesAtMinute: hour.closesAtMinute,
              isClosed: hour.isClosed,
            },
            select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
          }),
        ),
      );

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'merchant.hours_update',
          targetType: 'Merchant',
          targetId: merchantId,
          before: { hours: before },
          after: { hours: rows },
          ip: actor.ip ?? null,
        },
        tx,
      );

      return rows;
    });

    return saved.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
  }

  /**
   * `ratingAvg` is typed `unknown` because Prisma's `Decimal` arrives as a
   * string or a number depending on the driver path — the same reason
   * `catalog.read.ts` exports `ratingToNumber`.
   */
  private toOwnedView(
    row: Omit<OwnedMerchantView, 'isOwner' | 'hours' | 'ratingAvg'> & {
      readonly ownerId: string;
      readonly hours: readonly OperatingHourView[];
      readonly ratingAvg: unknown;
    },
    viewerId: string,
  ): OwnedMerchantView {
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
      ratingAvg: row.ratingAvg === null ? null : Number(row.ratingAvg),
      ratingCount: row.ratingCount,
      isOwner: row.ownerId === viewerId,
      hours: row.hours,
    };
  }
}

/** Re-exported so the admin module can reuse the same projection. */
export { ownedMerchantSelect };
export type { Prisma };
