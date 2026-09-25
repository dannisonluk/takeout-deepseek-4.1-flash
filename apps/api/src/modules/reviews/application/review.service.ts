import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertValidRating,
  isValidRating,
  OrderStatus,
  RATING_MAX,
  RATING_MIN,
  summariseRatings,
} from '@takeout/domain';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  OrderNotReviewableError,
  ReviewAlreadyExistsError,
  ReviewNotFoundError,
  ReviewNotOwnedError,
  ReviewReplyNotAllowedError,
} from '../domain/review.errors';
import {
  AdminReviewView,
  CustomerReviewView,
  MerchantReviewView,
  ReviewEligibilityView,
} from '../interface/review.view';
import { CreateReviewDto, UpdateReviewDto } from '../interface/dto/review.dto';

/**
 * The write path for customer feedback.
 *
 * Three rules carry the whole design:
 *
 *  1. **Only a collected order can be rated.** `COMPLETED` and nothing else. A
 *     rating on an order that was cancelled, refunded or never collected is not
 *     feedback about a meal, and letting one through would let a competitor
 *     with an account drag a merchant down without buying anything.
 *  2. **One review per order.** Enforced by a unique index, surfaced as a 409.
 *  3. **`Merchant.ratingAvg` / `ratingCount` are recomputed, never incremented.**
 *     An `increment` drifts the moment a review is hidden, unhidden or deleted —
 *     and the value feeds discovery ranking, so a drift is a wrong sort order,
 *     not a cosmetic lag. Recomputing from the source table inside the same
 *     transaction costs one aggregate over a handful of rows and cannot drift.
 *
 * Reviews are soft-deleted on moderation (`hiddenAt`) but hard-deleted when the
 * author withdraws one. Those are different acts: moderation is a decision that
 * must stay auditable, withdrawal is the author taking their words back.
 */
@Injectable()
export class ReviewService {
  private readonly logger = new Logger(ReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Can this customer rate this order, and if not, why not?
   *
   * Exposed as its own endpoint rather than left to the client to infer from
   * the order status, because the rules live here — status, ownership and the
   * time window — and a client that re-implements them will get one of them
   * wrong. The response carries the reason so the UI can say something better
   * than a disabled button.
   */
  async eligibility(customerId: string, orderId: string): Promise<ReviewEligibilityView | null> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId },
      select: {
        id: true,
        status: true,
        completedAt: true,
        review: { select: { id: true } },
      },
    });
    if (!order) return null;

    const status = order.status as unknown as OrderStatus;
    const deadline = order.completedAt ? this.deadlineFor(order.completedAt) : null;
    const existingReviewId = order.review?.id ?? null;

    let canReview = false;
    let reason = '';

    if (status !== OrderStatus.COMPLETED) {
      reason = '只有已完成的訂單可以評價。';
    } else if (existingReviewId) {
      reason = '這張訂單已經評價過了，你可以修改或撤回。';
    } else if (!order.completedAt) {
      // Should be impossible — COMPLETED always stamps `completedAt`. Treated as
      // "not reviewable" rather than "no deadline", so a data gap cannot open an
      // unbounded review window.
      reason = '訂單資料不完整，暫時無法評價。';
    } else if (deadline && deadline.getTime() < Date.now()) {
      reason = `評價期限為取餐後 ${this.config.reviews.windowDays} 天，已逾期。`;
    } else {
      canReview = true;
    }

    return {
      orderId: order.id,
      orderStatus: status,
      canReview,
      reason,
      existingReviewId,
      reviewDeadline: deadline?.toISOString() ?? null,
    };
  }

  async create(customerId: string, orderId: string, dto: CreateReviewDto): Promise<CustomerReviewView> {
    assertValidRating(dto.rating);

    const eligibility = await this.eligibility(customerId, orderId);
    if (!eligibility) throw new OrderNotReviewableError(orderId, 'UNKNOWN', 'Order not found');
    if (eligibility.existingReviewId) throw new ReviewAlreadyExistsError(orderId);
    if (!eligibility.canReview) {
      throw new OrderNotReviewableError(orderId, eligibility.orderStatus, eligibility.reason);
    }

    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, merchantId: true },
    });

    const reviewId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.review.create({
        data: {
          orderId: order.id,
          merchantId: order.merchantId,
          customerId,
          rating: dto.rating,
          comment: normaliseComment(dto.comment, this.config.reviews.maxCommentLength),
          tags: [...new Set(dto.tags ?? [])],
        },
        select: { id: true },
      });
      await this.recomputeMerchantRating(tx, order.merchantId);
      return created.id;
    });

    this.logger.log(`review ${reviewId} created for order ${orderId} (${dto.rating}★)`);
    return (await this.findForCustomer(customerId, reviewId))!;
  }

  /**
   * Edit a review.
   *
   * Not gated by the review window, deliberately. The window exists to stop
   * *new* feedback arriving about a meal nobody remembers; correcting a typo or
   * softening a rating after the merchant made it right is the author's business
   * at any time.
   */
  async update(
    customerId: string,
    reviewId: string,
    dto: UpdateReviewDto,
  ): Promise<CustomerReviewView> {
    const existing = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, customerId: true, merchantId: true, rating: true, hiddenAt: true },
    });
    if (!existing) throw new ReviewNotFoundError(reviewId);
    if (existing.customerId !== customerId) throw new ReviewNotOwnedError(reviewId);

    if (dto.rating !== undefined) assertValidRating(dto.rating);

    // A hidden review is under moderation. Letting the author edit it while it
    // is hidden would let them change the words an operator already judged.
    if (existing.hiddenAt) {
      throw new ReviewReplyNotAllowedError(reviewId, '這則評價正在審核中，暫時無法修改。');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.review.update({
        where: { id: reviewId },
        data: {
          ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
          ...(dto.comment !== undefined
            ? { comment: normaliseComment(dto.comment, this.config.reviews.maxCommentLength) }
            : {}),
          ...(dto.tags !== undefined ? { tags: [...new Set(dto.tags)] } : {}),
        },
      });
      // Only the rating feeds the average, but recomputing unconditionally is
      // cheaper than deciding whether it changed.
      if (dto.rating !== undefined && dto.rating !== existing.rating) {
        await this.recomputeMerchantRating(tx, existing.merchantId);
      }
    });

    return (await this.findForCustomer(customerId, reviewId))!;
  }

  /**
   * Withdraw a review.
   *
   * A hard delete, and the merchant's rating is recomputed — otherwise a
   * withdrawn one-star review would keep dragging the average down forever with
   * nothing left in the table to explain why.
   */
  async withdraw(customerId: string, reviewId: string): Promise<void> {
    const existing = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, customerId: true, merchantId: true, hiddenAt: true },
    });
    if (!existing) throw new ReviewNotFoundError(reviewId);
    if (existing.customerId !== customerId) throw new ReviewNotOwnedError(reviewId);
    if (existing.hiddenAt) {
      throw new ReviewReplyNotAllowedError(reviewId, '這則評價正在審核中，暫時無法撤回。');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.review.delete({ where: { id: reviewId } });
      await this.recomputeMerchantRating(tx, existing.merchantId);
    });
    this.logger.log(`review ${reviewId} withdrawn by its author`);
  }

  /**
   * The merchant's public reply.
   *
   * One reply per review, and a second call replaces it — a threaded
   * conversation between a shop and a customer is a support channel, and this
   * is not one. Hidden reviews cannot be replied to: the reply would be invisible
   * anyway, so accepting it would look like it had been published.
   */
  async reply(merchantId: string, reviewId: string, reply: string): Promise<MerchantReviewView> {
    const text = reply.trim();
    if (!text) throw new ReviewReplyNotAllowedError(reviewId, '回覆內容不可為空。');
    if (text.length > this.config.reviews.maxReplyLength) {
      throw new ReviewReplyNotAllowedError(
        reviewId,
        `回覆不可超過 ${this.config.reviews.maxReplyLength} 字。`,
      );
    }

    const existing = await this.prisma.review.findFirst({
      where: { id: reviewId, merchantId },
      select: { id: true, hiddenAt: true },
    });
    if (!existing) throw new ReviewNotFoundError(reviewId);
    if (existing.hiddenAt) {
      throw new ReviewReplyNotAllowedError(reviewId, '這則評價已被隱藏，無法回覆。');
    }

    await this.prisma.review.update({
      where: { id: reviewId },
      data: { merchantReply: text, merchantRepliedAt: new Date() },
    });

    return (await this.findForMerchant(merchantId, reviewId))!;
  }

  /** Hide a review. The row stays so the decision is auditable. */
  async hide(adminId: string, reviewId: string, reason: string): Promise<AdminReviewView> {
    const existing = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, merchantId: true, hiddenAt: true },
    });
    if (!existing) throw new ReviewNotFoundError(reviewId);

    if (!existing.hiddenAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.review.update({
          where: { id: reviewId },
          data: { hiddenAt: new Date(), hiddenById: adminId, hiddenReason: reason.trim() },
        });
        // A hidden review must stop counting towards the rating — otherwise
        // "hide" would only hide it from the page while it kept dragging the
        // average, which is the opposite of what an operator asked for.
        await this.recomputeMerchantRating(tx, existing.merchantId);
      });
    }

    return (await this.findForAdmin(reviewId))!;
  }

  /** Reverse a hide. */
  async unhide(reviewId: string): Promise<AdminReviewView> {
    const existing = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: { id: true, merchantId: true, hiddenAt: true },
    });
    if (!existing) throw new ReviewNotFoundError(reviewId);

    if (existing.hiddenAt) {
      await this.prisma.$transaction(async (tx) => {
        await tx.review.update({
          where: { id: reviewId },
          data: { hiddenAt: null, hiddenById: null, hiddenReason: null },
        });
        await this.recomputeMerchantRating(tx, existing.merchantId);
      });
    }

    return (await this.findForAdmin(reviewId))!;
  }

  /**
   * Refresh `Merchant.ratingAvg` / `ratingCount` from the review table.
   *
   * Runs inside the caller's transaction so the cached rating and the review it
   * came from commit together. Hidden reviews are excluded — that is what makes
   * moderation effective rather than cosmetic.
   *
   * `AVG` over zero rows yields `NULL` and `COUNT` yields `0`, so the single
   * statement already expresses "no visible reviews left" without a second
   * branch that could be forgotten.
   */
  private async recomputeMerchantRating(
    tx: Prisma.TransactionClient,
    merchantId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE merchants m
         SET "ratingAvg"   = sub.avg,
             "ratingCount" = sub.cnt,
             "updatedAt"   = now()
        FROM (
          SELECT ROUND(AVG(rating)::numeric, 2) AS avg, COUNT(*)::int AS cnt
            FROM reviews
           WHERE "merchantId" = ${merchantId}::uuid
             AND "hiddenAt" IS NULL
        ) sub
       WHERE m.id = ${merchantId}::uuid
    `;
  }

  private deadlineFor(completedAt: Date): Date {
    return new Date(completedAt.getTime() + this.config.reviews.windowDays * 86_400_000);
  }

  private async findForCustomer(
    customerId: string,
    reviewId: string,
  ): Promise<CustomerReviewView | null> {
    const row = await this.prisma.review.findFirst({
      where: { id: reviewId, customerId },
      select: { ...reviewSelect, order: { select: { id: true, orderNo: true } } },
    });
    if (!row) return null;
    return {
      ...toPublicView(row),
      orderId: row.order.id,
      orderNo: row.order.orderNo,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      // Withdrawal and editing are always allowed while the review exists and is
      // not under moderation — see `update`.
      editable: row.hiddenAt === null,
    };
  }

  private async findForMerchant(
    merchantId: string,
    reviewId: string,
  ): Promise<MerchantReviewView | null> {
    const row = await this.prisma.review.findFirst({
      where: { id: reviewId, merchantId },
      select: { ...reviewSelect, order: { select: { orderNo: true } } },
    });
    if (!row) return null;
    return {
      ...toPublicView(row),
      orderId: row.orderId,
      orderNo: row.order.orderNo,
      hiddenAt: row.hiddenAt?.toISOString() ?? null,
      hiddenReason: row.hiddenReason ?? null,
    };
  }

  private async findForAdmin(reviewId: string): Promise<AdminReviewView | null> {
    const row = await this.prisma.review.findUnique({
      where: { id: reviewId },
      select: {
        ...reviewSelect,
        customerId: true,
        hiddenById: true,
        updatedAt: true,
        order: { select: { orderNo: true } },
      },
    });
    if (!row) return null;
    return {
      ...toPublicView(row),
      orderId: row.orderId,
      orderNo: row.order.orderNo,
      merchantId: row.merchantId,
      merchantName: row.merchant.name,
      customerId: row.customerId,
      hiddenAt: row.hiddenAt?.toISOString() ?? null,
      hiddenReason: row.hiddenReason ?? null,
      hiddenById: row.hiddenById ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Shared projection.
 *
 * `customer.displayName` only — never the phone number, the email or the user
 * id. A public review page that leaks a reviewer's identity is a privacy
 * incident, and the way to prevent it is to never select the fields.
 */
const reviewSelect = {
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

interface ReviewRow {
  id: string;
  rating: number;
  comment: string | null;
  tags: string[];
  merchantReply: string | null;
  merchantRepliedAt: Date | null;
  createdAt: Date;
  customer: { displayName: string };
}

function toPublicView(row: ReviewRow) {
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

/**
 * Reduce a display name to something that identifies a person to the merchant
 * without publishing their full name on the open web.
 *
 * HK names are usually short, so the rule is deliberately gentle: keep the first
 * character, mask the rest. "陳大文" becomes "陳＊＊". A one-character name is
 * kept as-is because masking it entirely would leave nothing.
 */
function anonymiseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed || '顧客';
  return `${trimmed[0]}${'＊'.repeat(Math.min(trimmed.length - 1, 3))}`;
}

function normaliseComment(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Exported for the query service so both read and write agree on the bounds. */
export const RATING_BOUNDS = { min: RATING_MIN, max: RATING_MAX } as const;

/** Re-exported so callers do not have to reach into the domain package. */
export { isValidRating, summariseRatings };
