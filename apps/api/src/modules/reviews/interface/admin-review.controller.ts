import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../../../common/auth/roles.guard';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ReviewQueryService } from '../application/review-query.service';
import { ReviewService } from '../application/review.service';
import { ReviewNotFoundError } from '../domain/review.errors';
import { HideReviewDto, ListReviewsQueryDto, parseLimit } from './dto/review.dto';
import { AdminReviewView, ReviewPageView } from './review.view';

/**
 * Moderation.
 *
 * **Hide, not delete.** An operator can suppress a review and reverse the
 * decision, but cannot destroy it. Deleting is what a merchant under pressure
 * would want; a reversible, recorded hide is what a marketplace can defend. The
 * author can delete their own review — that is a different act and lives on
 * `ReviewAuthorController`.
 *
 * The queue defaults to `ALL` so a hidden review is still visible to the person
 * who has to justify hiding it.
 */
@Controller('admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminReviewController {
  constructor(
    private readonly reviews: ReviewService,
    private readonly queries: ReviewQueryService,
  ) {}

  @Get()
  list(@Query() query: ListReviewsQueryDto): Promise<ReviewPageView<AdminReviewView>> {
    return this.queries.listForAdmin({
      limit: parseLimit(query.limit),
      cursor: query.cursor,
      visibility: query.visibility ?? 'ALL',
    });
  }

  @Get(':reviewId')
  async get(@Param('reviewId', new ParseUUIDPipe()) reviewId: string): Promise<AdminReviewView> {
    const view = await this.queries.findForAdmin(reviewId);
    if (!view) throw new ReviewNotFoundError(reviewId);
    return view;
  }

  @Post(':reviewId/hide')
  @HttpCode(HttpStatus.OK)
  hide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @Body() dto: HideReviewDto,
  ): Promise<AdminReviewView> {
    return this.reviews.hide(user.userId, reviewId, dto.reason);
  }

  @Post(':reviewId/unhide')
  @HttpCode(HttpStatus.OK)
  unhide(@Param('reviewId', new ParseUUIDPipe()) reviewId: string): Promise<AdminReviewView> {
    return this.reviews.unhide(reviewId);
  }
}
