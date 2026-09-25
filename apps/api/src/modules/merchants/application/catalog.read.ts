import { MenuItemAvailability } from '@prisma/client';
import { MenuItemView } from '../interface/merchant.views';

/**
 * Shared read shape for menu items.
 *
 * Used by both public discovery and the owner's menu editor so the two can never
 * disagree about what `remainingToday` means. The write model lives in
 * `PrismaOrderRepository`; these are purpose-built read models, which is the
 * CQRS split the ordering module already follows.
 */
export function menuItemSelectFor(serviceDate: Date) {
  return {
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
    dailyStocks: {
      where: { serviceDate },
      select: { quota: true, sold: true, held: true },
    },
  } as const;
}

export interface MenuItemRow {
  readonly id: string;
  readonly categoryId: string | null;
  readonly name: string;
  readonly nameEn: string | null;
  readonly description: string | null;
  readonly imageKey: string | null;
  readonly imageBlurhash: string | null;
  readonly priceMinor: number;
  readonly currency: string;
  readonly isMainItem: boolean;
  readonly availability: MenuItemAvailability;
  readonly dailyQuota: number | null;
  readonly prepTimeMinutes: number | null;
  readonly sortOrder: number;
  readonly dailyStocks: readonly { quota: number; sold: number; held: number }[];
}

/**
 * `quota - sold - held` for the service day in question.
 *
 * `quota === 0` means unlimited (the same convention the quota-reservation SQL
 * uses), and `null` is what the client renders as "不限量". A merchant with no
 * stock row yet has not sold anything today, so the item's own `dailyQuota`
 * stands in for the row's `quota`.
 */
export function remainingToday(row: MenuItemRow): number | null {
  const stock = row.dailyStocks[0];
  const quota = stock?.quota ?? row.dailyQuota ?? 0;
  if (quota === 0) return null;
  return Math.max(0, quota - (stock?.sold ?? 0) - (stock?.held ?? 0));
}

export function toMenuItemView(row: MenuItemRow): MenuItemView {
  return {
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    nameEn: row.nameEn,
    description: row.description,
    imageKey: row.imageKey,
    imageBlurhash: row.imageBlurhash,
    priceMinor: row.priceMinor,
    currency: row.currency,
    isMainItem: row.isMainItem,
    availability: row.availability,
    dailyQuota: row.dailyQuota,
    remainingToday: remainingToday(row),
    prepTimeMinutes: row.prepTimeMinutes,
    sortOrder: row.sortOrder,
  };
}

export const merchantSummarySelect = {
  id: true,
  slug: true,
  name: true,
  nameEn: true,
  description: true,
  status: true,
  district: true,
  region: true,
  addressLine1: true,
  latitude: true,
  longitude: true,
  logoKey: true,
  coverImageKey: true,
  prepTimeMinutes: true,
  pickupWindowMinutes: true,
  acceptsOrders: true,
  ratingAvg: true,
  ratingCount: true,
} as const;

export interface MerchantSummaryRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly nameEn: string | null;
  readonly description: string | null;
  readonly status: string;
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
  readonly ratingAvg: unknown;
  readonly ratingCount: number;
}

/** Prisma `Decimal` for `ratingAvg` arrives as a string or number — normalise. */
export function ratingToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}
