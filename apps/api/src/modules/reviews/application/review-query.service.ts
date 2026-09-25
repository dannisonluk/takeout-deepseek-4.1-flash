import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RATING_MIN, summariseRatings } from '@takeout/domain';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  AdminReviewView,
  CustomerReviewView,
  MerchantReviewView,
  PublicReviewView,
  ReviewPageView,
  ReviewSummaryView,
} from '../interface/review.view';

export type ReviewVisibility = 'VISIBLE' | 'HIDDEN' | 'ALL';

export interface ListReviewsParams {
  readonly limit: number;
  readonly cursor?: string;
  readonly visibility?: ReviewVisibility;
  /** Admin only: narrow to one merchant. */
  readonly merchantId?: string;
}

/**
 * Read side for feedback.
 *
 * Kept apart from `ReviewService` for the same reason the ordering module splits
 * its queries out: the write service is built around invariants and transactions
 * that a list endpoint has no use for, and dragging them in would put an
 * `ORDER BY` next to the rating-recompute logic.
 *
 * Every public projection goes through `anonymiseName`, and the summary is
 * computed from a `groupBy` rather than by loading the page — a summary that
 * only covered the first page would report "5.0 from 20 reviews" for a merchant
 * with 400.
 */
@Injectable()
export class ReviewQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async summaryForMerchant(merchantId: string): Promise<ReviewSummaryView> {
    const groups = await this.prisma.review.groupBy({
      by: ['rating'],
      where: { merchantId, hiddenAt: null },
      _count: { _all: true },
    });

    // Expand the distribution back into individual ratings so the arithmetic
    // lives in exactly one place (`summariseRatings`) and the number shown on a
    // review page cannot disagree with the number the ranking engine uses.
    const ratings: number[] = [];
    for (const group of groups) {
      for (let i = 0; i < group._count._all; i += 1) ratings.push(group.rating);
    }
    return summariseRatings(ratings);
  }

  /** The public merchant page: visible reviews only. */
  async listForMerchant(
    merchantId: string,
    params: ListReviewsParams,
  ): Promise<ReviewPageView<PublicReviewView>> {
    const rows = await this.prisma.review.findMany({
      where: {
        merchantId,
        hiddenAt: null,
        ...cursorFilter(params.cursor),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit + 1,
      select: publicSelect,
    });

    const summary = await this.summaryForMerchant(merchantId);
    return paginate(rows, params.limit, summary, toPublicView);
  }

  /**
   * The merchant's own list.
   *
   * Includes hidden reviews when asked for, because the merchant has to be told
   * that a review was removed and why — a review that silently vanishes reads as
   * a bug, and the merchant would keep asking support about it.
   */
  async listForMerchantOwner(
    merchantId: string,
    params: ListReviewsParams,
  ): Promise<ReviewPageView<MerchantReviewView>> {
    const rows = await this.prisma.review.findMany({
      where: {
        merchantId,
        ...hiddenFilter(params.visibility ?? 'VISIBLE'),
        ...cursorFilter(params.cursor),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit + 1,
      select: { ...publicSelect, order: { select: { orderNo: true } } },
    });

    const summary = await this.summaryForMerchant(merchantId);
    return paginate(rows, params.limit, summary, toMerchantView);
  }

  /** A customer's own reviews. Hidden ones are shown too — they wrote them. */
  async listForCustomer(
    customerId: string,
    params: ListReviewsParams,
  ): Promise<ReviewPageView<CustomerReviewView>> {
    const rows = await this.prisma.review.findMany({
      where: { customerId, ...cursorFilter(params.cursor) },
      orderBy: { createdAt: 'desc' },
      take: params.limit + 1,
      select: {
        ...publicSelect,
        merchantId: true,
        hiddenAt: true,
        order: { select: { id: true, orderNo: true } },
      },
    });

    const visible = rows.filter((row) => row.hiddenAt === null).map((row) => row.rating);
    return paginate(rows, params.limit, summariseRatings(visible), toCustomerView);
  }

  /** The moderation queue. Identity included — an operator needs it. */
  async listForAdmin(params: ListReviewsParams): Promise<ReviewPageView<AdminReviewView>> {
    // Two clauses, not one. The page is filtered by the cursor; the summary must
    // not be, or scrolling past page one would shrink the headline figure.
    const scope: Prisma.ReviewWhereInput = {
      ...(params.merchantId ? { merchantId: params.merchantId } : {}),
      ...hiddenFilter(params.visibility ?? 'ALL'),
    };

    const rows = await this.prisma.review.findMany({
      where: { ...scope, ...cursorFilter(params.cursor) },
      orderBy: { createdAt: 'desc' },
      take: params.limit + 1,
      select: {
        ...publicSelect,
        customerId: true,
        hiddenById: true,
        updatedAt: true,
        order: { select: { orderNo: true } },
      },
    });

    const groups = await this.prisma.review.groupBy({
      by: ['rating'],
      where: { ...scope, hiddenAt: null },
      _count: { _all: true },
    });
    const ratings: number[] = [];
    for (const group of groups) {
      for (let i = 0; i < group._count._all; i += 1) ratings.push(group.rating);
    }

    return paginate(rows, params.limit, summariseRatings(ratings), toAdminView);
  }

  async findForAdmin(reviewId: string): Promise<AdminReviewView | null> {
    const row = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: {
        ...publicSelect,
        customerId: true,
        hiddenById: true,
        updatedAt: true,
        order: { select: { orderNo: true } },
      },
    });
    return row ? toAdminView(row) : null;
  }
}

// ---- shared projections -----------------------------------------------------

const publicSelect = {
  id: true,
  orderId: true,
  merchantId: true,
  rating: true,
  comment: true,
  tags: true,
  merchantReply: true,
  merchantRepliedAt: true,
  hiddenAt: true,
  hiddenReason: true,
  createdAt: true,
  customer: { select: { displayName: true } },
  merchant: { select: { name: true } },
} as const satisfies Prisma.ReviewSelect;

interface Row {
  id: string;
  orderId: string;
  merchantId: string;
  rating: number;
  comment: string | null;
  tags: string[];
  merchantReply: string | null;
  merchantRepliedAt: Date | null;
  hiddenAt: Date | null;
  hiddenReason: string | null;
  createdAt: Date;
  customer: { displayName: string };
  merchant: { name: string };
}

function cursorFilter(cursor?: string): { createdAt?: { lt: Date } } {
  return cursor ? { createdAt: { lt: new Date(cursor) } } : {};
}

function hiddenFilter(visibility: ReviewVisibility): Prisma.ReviewWhereInput {
  if (visibility === 'VISIBLE') return { hiddenAt: null };
  if (visibility === 'HIDDEN') return { hiddenAt: { not: null } };
  return {};
}

/**
 * Trim the over-fetched row and build the page envelope.
 *
 * The `+1` fetch is what makes `hasMore` honest without a second `COUNT(*)`:
 * if the extra row came back, there is another page, and it is dropped here.
 */
function paginate<R, V>(
  rows: readonly R[],
  limit: number,
  summary: ReviewSummaryView,
  map: (row: R) => V,
): ReviewPageView<V> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1) as { createdAt?: Date } | undefined;
  return {
    data: page.map(map),
    summary,
    nextCursor: hasMore && last?.createdAt ? last.createdAt.toISOString() : null,
    hasMore,
  };
}

function anonymiseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed || '顧客';
  return `${trimmed[0]}${'＊'.repeat(Math.min(trimmed.length - 1, 3))}`;
}

function toPublicView(row: Row): PublicReviewView {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    tags: row.tags,
    authorName: anonymiseName(row.customer.displayName),
    createdAt: row.createdAt.toISOString(),
    merchantReply: row.merchantReply,
    merchantRepliedAt: row.merchantRepliedAt?.toISOString() ?? null,
  };
}

function toMerchantView(row: Row & { order: { orderNo: string } }): MerchantReviewView {
  return {
    ...toPublicView(row),
    orderId: row.orderId,
    orderNo: row.order.orderNo,
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    hiddenReason: row.hiddenReason ?? null,
  };
}

function toCustomerView(
  row: Row & { order: { id: string; orderNo: string } },
): CustomerReviewView {
  return {
    ...toPublicView(row),
    orderId: row.order.id,
    orderNo: row.order.orderNo,
    merchantId: row.merchantId,
    merchantName: row.merchant.name,
    editable: row.hiddenAt === null,
  };
}

function toAdminView(
  row: Row & {
    customerId: string;
    hiddenById: string | null;
    updatedAt: Date;
    order: { orderNo: string };
  },
): AdminReviewView {
  return {
    ...toMerchantView(row),
    merchantId: row.merchantId,
    merchantName: row.merchant.name,
    customerId: row.customerId,
    hiddenById: row.hiddenById ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Re-exported so the controller can validate a rating without importing the domain. */
export { RATING_MIN };
