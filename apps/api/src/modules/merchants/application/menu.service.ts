import { Injectable } from '@nestjs/common';
import { MenuItemAvailability, Prisma } from '@prisma/client';
import { serviceDateIn } from '../../../common/time/service-date';
import { diffFields } from '../../../common/util/diff';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  DuplicateCategoryNameError,
  MenuCategoryInUseError,
  MenuCategoryMismatchError,
  MenuCategoryNotFoundError,
  MenuItemNotFoundError,
  MerchantNotEditableError,
} from '../domain/merchant.errors';
import {
  MenuCategoryView,
  MenuItemView,
  OwnerMenuView,
} from '../interface/merchant.views';
import {
  CreateMenuCategoryDto,
  CreateMenuItemDto,
  ReorderEntryDto,
  UpdateMenuCategoryDto,
  UpdateMenuItemDto,
} from '../interface/dto/menu.dto';
import { menuItemSelectFor, toMenuItemView } from './catalog.read';
import { Actor } from './merchant.service';

/** Category columns an owner may see and edit. */
const categorySelect = {
  id: true,
  name: true,
  nameEn: true,
  sortOrder: true,
  isActive: true,
} as const;

/**
 * Menu management — categories and dishes.
 *
 * Two rules shape most of this file:
 *
 *  1. **`isMainItem` is a money field.** It is the multiplier in
 *     `Platform_Fee = Count(Ordered_Main_Items) × feePerMainItem`. Changing it
 *     changes what the customer pays and what the merchant receives, so every
 *     write that touches it is audited with the before/after value rather than
 *     folded into a generic "menu updated" entry.
 *
 *  2. **Quota is per service day, not per row.** `menu_item_daily_stock` is
 *     seeded from `menu_items.dailyQuota` the first time an item is ordered on
 *     a given day and then never re-read. Editing `dailyQuota` therefore has to
 *     push the new cap into today's (and any future) stock row, or the merchant
 *     would change the number on screen and watch nothing happen.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ==========================================================================
  //  Read
  // ==========================================================================

  /** The owner's editor payload: everything, including HIDDEN items. */
  async listOwn(merchantId: string): Promise<OwnerMenuView> {
    const serviceDate = await this.serviceDateFor(merchantId);

    const [categories, uncategorised] = await Promise.all([
      this.prisma.menuCategory.findMany({
        where: { merchantId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          ...categorySelect,
          items: {
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: menuItemSelectFor(serviceDate),
          },
        },
      }),
      // Items whose category was deleted, or which were never filed. Keeping
      // them out of the category list means the editor cannot render them
      // twice or lose them.
      this.prisma.menuItem.findMany({
        where: { merchantId, categoryId: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: menuItemSelectFor(serviceDate),
      }),
    ]);

    const categoryViews: MenuCategoryView[] = categories.map((category) => ({
      id: category.id,
      name: category.name,
      nameEn: category.nameEn,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      items: category.items.map(toMenuItemView),
    }));
    const looseItems = uncategorised.map(toMenuItemView);

    return {
      merchantId,
      serviceDate: toDateOnly(serviceDate),
      categories: categoryViews,
      uncategorised: looseItems,
      totals: {
        categories: categoryViews.length,
        items:
          categoryViews.reduce((sum, category) => sum + category.items.length, 0) +
          looseItems.length,
        mainItems: [...categoryViews.flatMap((c) => c.items), ...looseItems].filter(
          (item) => item.isMainItem,
        ).length,
      },
    };
  }

  // ==========================================================================
  //  Categories
  // ==========================================================================

  async createCategory(
    merchantId: string,
    dto: CreateMenuCategoryDto,
    actor: Actor,
  ): Promise<MenuCategoryView> {
    await this.assertCategoryNameFree(merchantId, dto.name);

    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.menuCategory.create({
        data: {
          merchantId,
          name: dto.name,
          nameEn: dto.nameEn || null,
          sortOrder: dto.sortOrder ?? 0,
          isActive: dto.isActive ?? true,
        },
        select: categorySelect,
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_category.create',
          targetType: 'MenuCategory',
          targetId: row.id,
          after: { merchantId, name: row.name, sortOrder: row.sortOrder },
          ip: actor.ip ?? null,
        },
        tx,
      );

      return row;
    });

    return { ...created, items: [] };
  }

  async updateCategory(
    merchantId: string,
    categoryId: string,
    dto: UpdateMenuCategoryDto,
    actor: Actor,
  ): Promise<MenuCategoryView> {
    const current = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, merchantId },
      select: categorySelect,
    });
    if (!current) throw new MenuCategoryNotFoundError(categoryId);

    if (dto.name !== undefined && dto.name !== current.name) {
      await this.assertCategoryNameFree(merchantId, dto.name);
    }

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name;
    // `''` clears the English name; `undefined` leaves it alone.
    if (dto.nameEn !== undefined) patch.nameEn = dto.nameEn || null;
    if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) patch.isActive = dto.isActive;

    const diff = diffFields(current as unknown as Record<string, unknown>, patch);
    if (diff.changedKeys.length === 0) return { ...current, items: [] };

    await this.prisma.$transaction(async (tx) => {
      await tx.menuCategory.update({ where: { id: categoryId }, data: patch });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_category.update',
          targetType: 'MenuCategory',
          targetId: categoryId,
          before: diff.before,
          after: diff.after,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.categoryWithItems(merchantId, categoryId);
  }

  /**
   * Delete an empty category.
   *
   * `MenuCategory.items` is `ON DELETE SET NULL`, so the database would happily
   * accept this and quietly scatter the dishes into "uncategorised". Refusing
   * with a count makes the operator decide where they go, which is the only
   * moment the information still exists.
   */
  async deleteCategory(merchantId: string, categoryId: string, actor: Actor): Promise<void> {
    const category = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, merchantId },
      select: { id: true, name: true, sortOrder: true },
    });
    if (!category) throw new MenuCategoryNotFoundError(categoryId);

    const itemCount = await this.prisma.menuItem.count({ where: { categoryId } });
    if (itemCount > 0) throw new MenuCategoryInUseError(categoryId, itemCount);

    await this.prisma.$transaction(async (tx) => {
      await tx.menuCategory.delete({ where: { id: categoryId } });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_category.delete',
          targetType: 'MenuCategory',
          targetId: categoryId,
          before: { name: category.name, sortOrder: category.sortOrder },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
  }

  // ==========================================================================
  //  Items
  // ==========================================================================

  async createItem(
    merchantId: string,
    dto: CreateMenuItemDto,
    actor: Actor,
  ): Promise<MenuItemView> {
    if (dto.categoryId) await this.assertCategoryBelongsTo(merchantId, dto.categoryId);

    const serviceDate = await this.serviceDateFor(merchantId);

    const row = await this.prisma.$transaction(async (tx) => {
      const item = await tx.menuItem.create({
        data: {
          merchantId,
          categoryId: dto.categoryId ?? null,
          name: dto.name,
          nameEn: dto.nameEn || null,
          description: dto.description || null,
          imageKey: dto.imageKey || null,
          imageBlurhash: dto.imageBlurhash || null,
          priceMinor: dto.priceMinor,
          currency: dto.currency ?? 'HKD',
          isMainItem: dto.isMainItem ?? false,
          availability: dto.availability ?? MenuItemAvailability.AVAILABLE,
          dailyQuota: normaliseQuota(dto.dailyQuota),
          prepTimeMinutes: dto.prepTimeMinutes ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: menuItemSelectFor(serviceDate),
      });

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_item.create',
          targetType: 'MenuItem',
          targetId: item.id,
          after: {
            merchantId,
            name: item.name,
            priceMinor: item.priceMinor,
            isMainItem: item.isMainItem,
            dailyQuota: item.dailyQuota,
          },
          ip: actor.ip ?? null,
        },
        tx,
      );

      return item;
    });

    return toMenuItemView(row);
  }

  async updateItem(
    merchantId: string,
    itemId: string,
    dto: UpdateMenuItemDto,
    actor: Actor,
  ): Promise<MenuItemView> {
    const serviceDate = await this.serviceDateFor(merchantId);

    const current = await this.prisma.menuItem.findFirst({
      where: { id: itemId, merchantId },
      select: {
        id: true,
        categoryId: true,
        name: true,
        nameEn: true,
        description: true,
        imageKey: true,
        imageBlurhash: true,
        priceMinor: true,
        currency: true,
        isMainItem: true,
        availability: true,
        dailyQuota: true,
        prepTimeMinutes: true,
        sortOrder: true,
      },
    });
    if (!current) throw new MenuItemNotFoundError(itemId);

    if (dto.categoryId) await this.assertCategoryBelongsTo(merchantId, dto.categoryId);

    const patch = buildItemPatch(dto);
    const diff = diffFields(current as unknown as Record<string, unknown>, patch);
    if (diff.changedKeys.length === 0) {
      return this.itemView(merchantId, itemId, serviceDate);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.menuItem.update({ where: { id: itemId }, data: patch });

      // Push a changed cap into the live stock rows. Without this the merchant
      // edits the number, the row keeps the old one, and the menu silently
      // ignores them for the rest of the day. `>= today` leaves history alone.
      if (diff.changedKeys.includes('dailyQuota')) {
        await tx.menuItemDailyStock.updateMany({
          where: { menuItemId: itemId, serviceDate: { gte: serviceDate } },
          data: { quota: (patch.dailyQuota as number | null) ?? 0 },
        });
      }

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_item.update',
          targetType: 'MenuItem',
          targetId: itemId,
          before: diff.before,
          after: diff.after,
          ip: actor.ip ?? null,
        },
        tx,
      );
    });

    return this.itemView(merchantId, itemId, serviceDate);
  }

  /** The one-tap sold-out / available switch on the kitchen screen. */
  async setAvailability(
    merchantId: string,
    itemId: string,
    availability: MenuItemAvailability,
    actor: Actor,
  ): Promise<MenuItemView> {
    return this.updateItem(merchantId, itemId, { availability }, actor);
  }

  /**
   * Remove a dish.
   *
   * Safe even when it appears on past orders: `order_items` keeps its own
   * `nameSnapshot` / `unitPriceMinor` / `isMainItem`, and the FK is
   * `ON DELETE SET NULL`, so a receipt never changes because a menu did. The
   * stock rows cascade away with the item.
   */
  async deleteItem(merchantId: string, itemId: string, actor: Actor): Promise<void> {
    const item = await this.prisma.menuItem.findFirst({
      where: { id: itemId, merchantId },
      select: { id: true, name: true, priceMinor: true, isMainItem: true },
    });
    if (!item) throw new MenuItemNotFoundError(itemId);

    await this.prisma.$transaction(async (tx) => {
      await tx.menuItem.delete({ where: { id: itemId } });
      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_item.delete',
          targetType: 'MenuItem',
          targetId: itemId,
          before: { name: item.name, priceMinor: item.priceMinor, isMainItem: item.isMainItem },
          ip: actor.ip ?? null,
        },
        tx,
      );
    });
  }

  /**
   * Reorder dishes in one shot.
   *
   * Written as a single `UPDATE ... FROM (VALUES ...)` rather than N statements:
   * a partial save would leave two dishes claiming the same `sortOrder`, and
   * nothing in the schema would flag it. Every id is checked against the
   * merchant first, so the `affected` count is a real invariant and not a guess.
   */
  async reorderItems(
    merchantId: string,
    entries: readonly ReorderEntryDto[],
    actor: Actor,
  ): Promise<{ updated: number }> {
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) {
      throw new MenuItemNotFoundError(ids.find((id, index) => ids.indexOf(id) !== index) ?? '');
    }

    const owned = await this.prisma.menuItem.findMany({
      where: { id: { in: ids }, merchantId },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      const ownedIds = new Set(owned.map((row) => row.id));
      throw new MenuItemNotFoundError(ids.find((id) => !ownedIds.has(id)) ?? '');
    }

    const values = Prisma.join(
      entries.map((entry) => Prisma.sql`(${entry.id}::uuid, ${entry.sortOrder}::int)`),
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const affected = await tx.$executeRaw`
        UPDATE menu_items AS mi
           SET "sortOrder" = v.ord,
               "updatedAt" = now()
          FROM (VALUES ${values}) AS v(id, ord)
         WHERE mi.id = v.id
           AND mi."merchantId" = ${merchantId}::uuid
      `;

      await this.audit.record(
        {
          actorId: actor.userId,
          actorRole: actor.role,
          action: 'menu_item.reorder',
          targetType: 'Merchant',
          targetId: merchantId,
          after: { entries },
          ip: actor.ip ?? null,
        },
        tx,
      );

      return affected;
    });

    return { updated };
  }

  // ==========================================================================
  //  Internals
  // ==========================================================================

  /** The merchant's current service day, in the merchant's own timezone. */
  private async serviceDateFor(merchantId: string): Promise<Date> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { timezone: true, status: true },
    });
    if (!merchant) throw new MerchantNotEditableError('UNKNOWN', '找不到此商戶');
    return serviceDateIn(merchant.timezone, new Date());
  }

  private async assertCategoryNameFree(merchantId: string, name: string): Promise<void> {
    const clash = await this.prisma.menuCategory.findFirst({
      where: { merchantId, name },
      select: { id: true },
    });
    if (clash) throw new DuplicateCategoryNameError(name);
  }

  private async assertCategoryBelongsTo(merchantId: string, categoryId: string): Promise<void> {
    const category = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, merchantId },
      select: { id: true },
    });
    if (!category) throw new MenuCategoryMismatchError(categoryId);
  }

  private async categoryWithItems(
    merchantId: string,
    categoryId: string,
  ): Promise<MenuCategoryView> {
    const serviceDate = await this.serviceDateFor(merchantId);
    const category = await this.prisma.menuCategory.findFirstOrThrow({
      where: { id: categoryId, merchantId },
      select: {
        ...categorySelect,
        items: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: menuItemSelectFor(serviceDate),
        },
      },
    });

    return {
      id: category.id,
      name: category.name,
      nameEn: category.nameEn,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      items: category.items.map(toMenuItemView),
    };
  }

  private async itemView(
    merchantId: string,
    itemId: string,
    serviceDate: Date,
  ): Promise<MenuItemView> {
    const row = await this.prisma.menuItem.findFirst({
      where: { id: itemId, merchantId },
      select: menuItemSelectFor(serviceDate),
    });
    if (!row) throw new MenuItemNotFoundError(itemId);
    return toMenuItemView(row);
  }
}

/**
 * `0` and `null` both mean "no cap" in this system. Normalising on write means
 * `remainingToday` and the reservation SQL never have to consider two encodings
 * of the same idea.
 */
function normaliseQuota(value: number | null | undefined): number | null {
  if (value === undefined || value === null || value === 0) return null;
  return value;
}

/**
 * Translate a partial DTO into a Prisma update patch.
 *
 * Only keys actually present in the DTO appear, so an untouched field is never
 * written. `''` clears an optional text column to `NULL` rather than storing an
 * empty string — an empty string would render as a blank line on the menu
 * instead of falling back to the Chinese name.
 */
function buildItemPatch(dto: UpdateMenuItemDto): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (dto.categoryId !== undefined) patch.categoryId = dto.categoryId;
  if (dto.name !== undefined) patch.name = dto.name;
  if (dto.nameEn !== undefined) patch.nameEn = dto.nameEn || null;
  if (dto.description !== undefined) patch.description = dto.description || null;
  if (dto.imageKey !== undefined) patch.imageKey = dto.imageKey || null;
  if (dto.imageBlurhash !== undefined) patch.imageBlurhash = dto.imageBlurhash || null;
  if (dto.priceMinor !== undefined) patch.priceMinor = dto.priceMinor;
  if (dto.isMainItem !== undefined) patch.isMainItem = dto.isMainItem;
  if (dto.availability !== undefined) patch.availability = dto.availability;
  if (dto.dailyQuota !== undefined) patch.dailyQuota = normaliseQuota(dto.dailyQuota);
  if (dto.prepTimeMinutes !== undefined) patch.prepTimeMinutes = dto.prepTimeMinutes ?? null;
  if (dto.sortOrder !== undefined) patch.sortOrder = dto.sortOrder;

  return patch;
}

/** `YYYY-MM-DD` for a UTC-midnight `@db.Date` value. */
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
