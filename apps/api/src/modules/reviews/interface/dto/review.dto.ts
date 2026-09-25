import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RATING_MAX, RATING_MIN, REVIEW_TAGS, ReviewTag } from '@takeout/domain';

export class CreateReviewDto {
  @IsInt()
  @Min(RATING_MIN)
  @Max(RATING_MAX)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  /**
   * Tags are validated against the domain's vocabulary, not a copy of it — the
   * literal list in a `@IsIn` would be a second source of truth that drifts the
   * first time someone adds a tag.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(REVIEW_TAGS.length)
  @IsIn(REVIEW_TAGS as unknown as string[], { each: true })
  tags?: ReviewTag[];
}

/** An edit. Every field is optional; omitted fields keep their value. */
export class UpdateReviewDto {
  @IsOptional()
  @IsInt()
  @Min(RATING_MIN)
  @Max(RATING_MAX)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(REVIEW_TAGS.length)
  @IsIn(REVIEW_TAGS as unknown as string[], { each: true })
  tags?: ReviewTag[];
}

export class MerchantReplyDto {
  @IsString()
  @MaxLength(600)
  reply!: string;
}

/**
 * Moderation.
 *
 * The reason is required rather than optional: a hidden review that says
 * nothing about why is indistinguishable from a bug, and it is the merchant who
 * has to be told.
 */
export class HideReviewDto {
  @IsString()
  @MaxLength(300)
  reason!: string;
}

export class ListReviewsQueryDto {
  /**
   * Query strings arrive as strings — the global `ValidationPipe` runs with
   * `enableImplicitConversion: false`, so an `@IsInt()` here would reject every
   * request. Parsed by `parseLimit` in the controller instead, which also clamps
   * it: an unbounded `?limit=100000` is a denial-of-service with extra steps.
   */
  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  /** `ALL` is admin-only; the public and merchant lists are always visible-only. */
  @IsOptional()
  @IsIn(['VISIBLE', 'HIDDEN', 'ALL'])
  visibility?: 'VISIBLE' | 'HIDDEN' | 'ALL';
}

export const REVIEW_PAGE_MAX = 50;
export const REVIEW_PAGE_DEFAULT = 20;

/** Clamp `?limit=` into a sane page size. Never throws — a bad value defaults. */
export function parseLimit(raw: string | undefined, fallback = REVIEW_PAGE_DEFAULT): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, REVIEW_PAGE_MAX);
}
