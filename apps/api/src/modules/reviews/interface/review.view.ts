import { OrderStatus } from '@takeout/domain';

/** A review as a public page shows it — no customer identity beyond a handle. */
export interface PublicReviewView {
  readonly id: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly tags: readonly string[];
  /** Display name only. Never the phone number or the user id. */
  readonly authorName: string;
  readonly createdAt: string;
  readonly merchantReply: string | null;
  readonly merchantRepliedAt: string | null;
}

/** A review as its author sees it — includes the order it belongs to. */
export interface CustomerReviewView extends PublicReviewView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly merchantId: string;
  readonly merchantName: string;
  /** Whether the review can still be edited or withdrawn. */
  readonly editable: boolean;
}

/** A review as the merchant sees it — includes moderation state. */
export interface MerchantReviewView extends PublicReviewView {
  readonly orderId: string;
  readonly orderNo: string;
  readonly hiddenAt: string | null;
  readonly hiddenReason: string | null;
}

/** A review as an operator sees it — includes the author's identity. */
export interface AdminReviewView extends MerchantReviewView {
  readonly merchantId: string;
  readonly merchantName: string;
  readonly customerId: string;
  readonly hiddenById: string | null;
  readonly updatedAt: string;
}

export interface ReviewSummaryView {
  /** `null` when the merchant has no visible reviews — never 0. */
  readonly average: number | null;
  readonly count: number;
  /** Index 0 is a rating of 1. */
  readonly distribution: readonly number[];
  /** Share of 4- and 5-star reviews, in basis points. */
  readonly positiveShareBps: number;
}

export interface ReviewPageView<T> {
  readonly data: readonly T[];
  readonly summary: ReviewSummaryView;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** What a customer is allowed to do to a given order, feedback-wise. */
export interface ReviewEligibilityView {
  readonly orderId: string;
  readonly orderStatus: OrderStatus;
  readonly canReview: boolean;
  /** Why not, when `canReview` is false. Empty string when it is true. */
  readonly reason: string;
  /** Present when a review already exists — the UI should offer "edit". */
  readonly existingReviewId: string | null;
  /** Last day a review may be written, as an ISO date. */
  readonly reviewDeadline: string | null;
}
