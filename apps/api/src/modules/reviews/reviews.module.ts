import { Module } from '@nestjs/common';
import { ReviewQueryService } from './application/review-query.service';
import { ReviewService } from './application/review.service';
import { AdminReviewController } from './interface/admin-review.controller';
import {
  CustomerReviewController,
  MerchantReviewController,
  MyReviewsController,
  PublicReviewController,
  ReviewAuthorController,
} from './interface/review.controller';

/**
 * Feedback bounded context.
 *
 * Two services rather than one: `ReviewService` owns the invariants (who may
 * rate what, and when) and the rating recompute, while `ReviewQueryService`
 * owns the four different projections of the same rows — public, author,
 * merchant, operator. Merging them would put an `ORDER BY` next to the
 * transaction that maintains `Merchant.ratingAvg`.
 *
 * `AdminReviewController` lives here rather than in `AdminModule` so that the
 * moderation rules and the review they moderate cannot drift apart. It is
 * guarded by `RolesGuard` exactly as the rest of the admin surface is.
 */
@Module({
  controllers: [
    CustomerReviewController,
    MyReviewsController,
    ReviewAuthorController,
    PublicReviewController,
    MerchantReviewController,
    AdminReviewController,
  ],
  providers: [ReviewService, ReviewQueryService],
  exports: [ReviewService, ReviewQueryService],
})
export class ReviewsModule {}
