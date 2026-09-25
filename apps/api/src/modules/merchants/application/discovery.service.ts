import { Injectable } from '@nestjs/common';
import {
  GeoPoint,
  rankingEngineFor,
  type RankingCandidate,
  type RankingPresetName,
} from '@takeout/domain';
import { serviceDateIn } from '../../../common/time/service-date';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  MenuCategoryView,
  MerchantDetailView,
  MerchantSummaryView,
} from '../interface/merchant.views';
import {
  merchantSummarySelect,
  menuItemSelectFor,
  MerchantSummaryRow,
  ratingToNumber,
  toMenuItemView,
} from './catalog.read';

/** 1 degree of latitude is ~111.32 km everywhere; longitude shrinks with cos(lat). */
const KM_PER_DEGREE_LAT = 111.32;
const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 30;

export interface DiscoveryQuery {
  readonly latitude?: number;
  readonly longitude?: number;
  readonly radiusKm?: number;
  readonly q?: string;
  readonly district?: string;
  readonly acceptingOnly?: boolean;
  readonly limit: number;
  readonly cursor?: string;
  /** Ranking preset. Defaults to `NEAREST`, which is pure distance. */
  readonly sort?: RankingPresetName;
}

/**
 * Public merchant discovery.
 *
 * No PostGIS on this deployment, so the strategy is a **bounding-box prefilter
 * in SQL plus a haversine refinement in JS**. That is accurate for the merchant
 * densities this platform will see and needs no extension at all; when PostGIS
 * is present the same result could come from one `ST_DWithin`, and only this
 * method would change.
 */
@Injectable()
export class DiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DiscoveryQuery): Promise<MerchantSummaryView[]> {
    const hasOrigin = query.latitude !== undefined && query.longitude !== undefined;
    const radiusKm = Math.min(query.radiusKm ?? DEFAULT_RADIUS_KM, MAX_RADIUS_KM);
    const origin = hasOrigin ? GeoPoint.of(query.latitude!, query.longitude!) : null;

    const box = origin
      ? boundingBox(origin, radiusKm)
      : null;

    const rows = await this.prisma.merchant.findMany({
      where: {
        status: 'ACTIVE',
        ...(query.acceptingOnly ? { acceptsOrders: true } : {}),
        ...(query.district ? { district: query.district } : {}),
        // Trigram-backed: `%` on `name` uses `merchants_name_trgm_idx`.
        ...(query.q
          ? {
              OR: [
                { name: { contains: query.q, mode: 'insensitive' } },
                { nameEn: { contains: query.q, mode: 'insensitive' } },
                { description: { contains: query.q, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(box
          ? {
              latitude: { gte: box.minLat, lte: box.maxLat },
              longitude: { gte: box.minLng, lte: box.maxLng },
            }
          : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      select: merchantSummarySelect,
      // The preset decides the final order, so SQL here is only a candidate
      // filter: with an origin the bounding box already narrows the set, and we
      // take a generous slice before ranking in memory. Without an origin there
      // is nothing to rank by that SQL is not already doing, so the page comes
      // straight from the name-ordered query.
      take: origin ? query.limit * 4 : query.limit,
      orderBy: origin ? { ratingCount: 'desc' } : { name: 'asc' },
    });

    const withDistance = rows.map((row) => toSummary(row, origin));

    if (!origin) return withDistance;

    // `NEAREST` is the default and reproduces the previous distance-only
    // ordering exactly, so an existing client sees no change.
    const ranked = rankingEngineFor(query.sort ?? 'NEAREST').rank(
      withDistance.map((view) => ({
        id: view.id,
        distanceKm: view.distanceKm,
        ratingAvg: view.ratingAvg,
        ratingCount: view.ratingCount,
        prepTimeMinutes: view.prepTimeMinutes,
      })),
    );

    // Rank on the narrow shape, return the full view. The engine deliberately
    // knows nothing about the API's response type.
    const viewById = new Map(withDistance.map((view) => [view.id, view]));
    return ranked
      .slice(0, query.limit)
      .map((entry) => viewById.get(entry.id))
      .filter((view): view is MerchantSummaryView => view !== undefined);
  }

  async detail(slug: string): Promise<MerchantDetailView | null> {
    const merchant = await this.prisma.merchant.findUnique({
      where: { slug },
      select: {
        ...merchantSummarySelect,
        phone: true,
        addressLine2: true,
        timezone: true,
        acceptTimeoutMinutes: true,
        autoAcceptOrders: true,
        hours: {
          select: { dayOfWeek: true, opensAtMinute: true, closesAtMinute: true, isClosed: true },
          orderBy: { dayOfWeek: 'asc' },
        },
      },
    });

    // A non-ACTIVE merchant is invisible to customers, not merely un-orderable.
    if (!merchant || merchant.status !== 'ACTIVE') return null;

    const serviceDate = serviceDateIn(merchant.timezone, new Date());

    const categories = await this.prisma.menuCategory.findMany({
      where: { merchantId: merchant.id, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        nameEn: true,
        sortOrder: true,
        isActive: true,
        items: {
          where: { availability: { not: 'HIDDEN' } },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: menuItemSelectFor(serviceDate),
        },
      },
    });

    return {
      ...toSummary(merchant, null),
      phone: merchant.phone,
      addressLine2: merchant.addressLine2,
      timezone: merchant.timezone,
      acceptTimeoutMinutes: merchant.acceptTimeoutMinutes,
      autoAcceptOrders: merchant.autoAcceptOrders,
      hours: merchant.hours,
      categories: categories.map(
        (category): MenuCategoryView => ({
          id: category.id,
          name: category.name,
          nameEn: category.nameEn,
          sortOrder: category.sortOrder,
          isActive: category.isActive,
          items: category.items.map(toMenuItemView),
        }),
      ),
    };
  }

  /** Distinct districts that currently have at least one active merchant. */
  async districts(): Promise<{ district: string; count: number }[]> {
    const rows = await this.prisma.merchant.groupBy({
      by: ['district'],
      where: { status: 'ACTIVE', district: { not: null } },
      _count: { _all: true },
    });

    return rows
      .filter((row): row is typeof row & { district: string } => row.district !== null)
      .map((row) => ({ district: row.district, count: row._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}

function toSummary(row: MerchantSummaryRow, origin: GeoPoint | null): MerchantSummaryView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    nameEn: row.nameEn,
    description: row.description,
    status: row.status as MerchantSummaryView['status'],
    district: row.district,
    region: row.region,
    addressLine1: row.addressLine1,
    latitude: row.latitude,
    longitude: row.longitude,
    logoKey: row.logoKey,
    coverImageKey: row.coverImageKey,
    prepTimeMinutes: row.prepTimeMinutes,
    pickupWindowMinutes: row.pickupWindowMinutes,
    acceptsOrders: row.acceptsOrders,
    ratingAvg: ratingToNumber(row.ratingAvg),
    ratingCount: row.ratingCount,
    distanceKm: origin
      ? Number(origin.distanceKmTo(GeoPoint.of(row.latitude, row.longitude)).toFixed(2))
      : null,
  };
}

/**
 * Latitude/longitude bounds of a `radiusKm` disc around `origin`.
 *
 * The longitude span is divided by `cos(latitude)` because meridians converge
 * towards the poles — without that the box is far too wide in Hong Kong's
 * latitude band and the prefilter stops filtering.
 */
function boundingBox(
  origin: GeoPoint,
  radiusKm: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const latDelta = radiusKm / KM_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos((origin.latitude * Math.PI) / 180), 1e-6);
  const lngDelta = radiusKm / (KM_PER_DEGREE_LAT * cosLat);

  return {
    minLat: origin.latitude - latDelta,
    maxLat: origin.latitude + latDelta,
    minLng: origin.longitude - lngDelta,
    maxLng: origin.longitude + lngDelta,
  };
}
