import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ReviewQueryService } from '../application/review-query.service';
import { ReviewService } from '../application/review.service';
import {
  CreateReviewDto,
  ListReviewsQueryDto,
  MerchantReplyDto,
  parseLimit,
  UpdateReviewDto,
} from './dto/review.dto';
import {
  CustomerReviewView,
  MerchantReviewView,
  PublicReviewView,
  ReviewEligibilityView,
  ReviewPageView,
} from './review.view';

/** Route params carry these; the DTOs cover bodies and query strings. */
function page(params: ListReviewsQueryDto) {
  return {
    limit: parseLimit(params.limit),
    cursor: params.cursor,
    visibility: params.visibility ?? ('VISIBLE' as const),
  };
}

/**
 * Customer feedback, order-scoped.
 *
 * The review is written against the **order**, not the merchant, and the
 * `eligibility` endpoint is what the UI calls to decide whether to show the
 * prompt at all. That split keeps the rules in one place: the client asks "may
 * I?" and gets a reason, instead of re-deriving the answer from the order
 * status and getting the time window wrong.
 */
@Controller('orders/:orderId/review')
@UseGuards(JwtAuthGuard)
export class CustomerReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly queries: ReviewQueryService,
  ) {}

  /** Whether this order can be rated, and if not, why. */
  @Get('eligibility')
  async eligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
  ): Promise<ReviewEligibilityView> {
    const view = await this.reviews.eligibility(user.userId, orderId);
    if (!view) throw new NotFoundException('Order not found');
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() dto: CreateReviewDto,
  ): Promise<CustomerReviewView> {
    return this.reviews.create(user.userId, orderId, dto);
  }
}

/** A customer's own reviews, across merchants. */
@Controller('me/reviews')
@UseGuards(JwtAuthGuard)
export class MyReviewsController {
  constructor(private readonly queries: ReviewQueryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListReviewsQueryDto,
  ): Promise<ReviewPageView<CustomerReviewView>> {
    return this.queries.listForCustomer(user.userId, {
      limit: parseLimit(query.limit),
      cursor: query.cursor,
    });
  }
}

/**
 * The reviews on one review — edit and withdraw, by their author.
 *
 * Addressed by review id rather than order id because a customer editing a
 * review from their account page does not have the order to hand.
 */
@Controller('reviews')
@UseGuards(JwtAuthGuard)
export class ReviewAuthorController {
  constructor(private readonly reviews: ReviewService) {}

  @Put(':reviewId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @Body() dto: UpdateReviewDto,
  ): Promise<CustomerReviewView> {
    return this.reviews.update(user.userId, reviewId, dto);
  }

  @Delete(':reviewId')
  @HttpCode(HttpStatus.NO_CONTENT)
  withdraw(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
  ): Promise<void> {
    return this.reviews.withdraw(user.userId, reviewId);
  }
}

/** The public review page. No authentication — anyone can read a shop's reviews. */
@Controller('merchants/:merchantId/reviews')
export class PublicReviewController {
  constructor(private readonly queries: ReviewQueryService) {}

  @Get()
  list(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: ListReviewsQueryDto,
  ): Promise<ReviewPageView<PublicReviewView>> {
    return this.queries.listForMerchant(merchantId, {
      limit: parseLimit(query.limit),
      cursor: query.cursor,
    });
  }
}

/**
 * The merchant's view of their own feedback.
 *
 * `MerchantScopeGuard` reads the merchant ids off the token, so an owner cannot
 * read another shop's reviews by changing the URL — and, unlike a database
 * lookup, it cannot be fooled by a stale row.
 */
@Controller('merchant/:merchantId/reviews')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly queries: ReviewQueryService,
  ) {}

  @Get()
  list(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: ListReviewsQueryDto,
  ): Promise<ReviewPageView<MerchantReviewView>> {
    return this.queries.listForMerchantOwner(merchantId, page(query));
  }

  @Post(':reviewId/reply')
  @HttpCode(HttpStatus.OK)
  reply(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @Body() dto: MerchantReplyDto,
  ): Promise<MerchantReviewView> {
    return this.reviews.reply(merchantId, reviewId, dto.reply);
  }
}
