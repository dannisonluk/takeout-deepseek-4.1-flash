import { DomainError } from '@takeout/domain';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the exception filter. */

export class ReviewNotFoundError extends DomainError {
  constructor(reviewId: string) {
    super('REVIEW_NOT_FOUND', 'Review not found', { reviewId });
  }
}

export class OrderNotReviewableError extends DomainError {
  constructor(orderId: string, status: string, reason: string) {
    super('ORDER_NOT_REVIEWABLE', reason, { orderId, status });
  }
}

/**
 * One review per order.
 *
 * The DB has a unique index on `reviews.orderId`, so this is belt and braces —
 * but it converts a raw `P2002` from Prisma into a 409 with a code the client
 * can branch on, which is the difference between "you already rated this" and
 * "something went wrong".
 */
export class ReviewAlreadyExistsError extends DomainError {
  constructor(orderId: string) {
    super('REVIEW_ALREADY_EXISTS', 'This order has already been rated', { orderId });
  }
}

export class ReviewNotOwnedError extends DomainError {
  constructor(reviewId: string) {
    super('REVIEW_NOT_OWNED', 'This review belongs to another customer', { reviewId });
  }
}

export class ReviewReplyNotAllowedError extends DomainError {
  constructor(reviewId: string, reason: string) {
    super('REVIEW_REPLY_NOT_ALLOWED', reason, { reviewId });
  }
}
