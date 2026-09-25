import { ValidationError } from '../shared/domain-error';
import { roundHalfAwayFromZero } from '../shared/money';

/** Inclusive bounds of a rating. Also enforced by a CHECK constraint in the DB. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

/**
 * The fixed vocabulary a customer can tag a review with.
 *
 * Fixed rather than free text because the only thing a tag is good for is
 * aggregation — "how many reviews mention 份量" — and free-text tags cannot be
 * aggregated without a language model in the reporting path.
 */
export const REVIEW_TAGS = [
  'TASTE',
  'PORTION',
  'SPEED',
  'PACKAGING',
  'VALUE',
  'SERVICE',
] as const;

export type ReviewTag = (typeof REVIEW_TAGS)[number];

export const REVIEW_TAG_LABEL_ZH_HK: Readonly<Record<ReviewTag, string>> = {
  TASTE: '味道',
  PORTION: '份量',
  SPEED: '出餐速度',
  PACKAGING: '包裝',
  VALUE: '性價比',
  SERVICE: '服務',
};

/** How a rating reads to a human. Drives the colour of the badge in the UI. */
export type RatingBand = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

export function isValidRating(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= RATING_MIN && (value as number) <= RATING_MAX;
}

export function assertValidRating(value: unknown): asserts value is number {
  if (!isValidRating(value)) {
    throw new ValidationError(
      `Rating must be an integer between ${RATING_MIN} and ${RATING_MAX}, received ${String(value)}`,
      { value },
    );
  }
}

export function isReviewTag(value: unknown): value is ReviewTag {
  return typeof value === 'string' && (REVIEW_TAGS as readonly string[]).includes(value);
}

/**
 * 4–5 positive, 3 neutral, 1–2 negative.
 *
 * A single function rather than a ternary repeated in three clients: the
 * merchant portal, the customer page and the admin moderation queue must not be
 * able to disagree about whether a 3 is good.
 */
export function ratingBand(rating: number): RatingBand {
  assertValidRating(rating);
  if (rating >= 4) return 'POSITIVE';
  if (rating === 3) return 'NEUTRAL';
  return 'NEGATIVE';
}

export interface RatingSummary {
  /** Mean rating, rounded to two decimals. `null` when there are no reviews. */
  readonly average: number | null;
  readonly count: number;
  /** How many reviews gave each score. Index 0 is a rating of 1. */
  readonly distribution: readonly number[];
  readonly positiveShareBps: number;
}

/**
 * Summarise a set of ratings.
 *
 * The distribution is the part that matters commercially and is the part a bare
 * average destroys: a 4.0 from all fours and a 4.0 from alternating fives and
 * threes are the same number and completely different businesses.
 *
 * Empty input is not an error — a merchant with no reviews is normal — but it
 * returns `average: null` rather than `0`, so a caller cannot accidentally
 * render "0.0 ★" for a new shop. `0` is the worst possible score, not the
 * absence of one.
 */
export function summariseRatings(ratings: readonly number[]): RatingSummary {
  const distribution = new Array<number>(RATING_MAX - RATING_MIN + 1).fill(0);
  let total = 0;

  for (const rating of ratings) {
    assertValidRating(rating);
    const bucket = rating - RATING_MIN;
    // `?? 0` because `noUncheckedIndexedAccess` is on and the array is built
    // dynamically — the read is provably in range, but the compiler cannot see it.
    distribution[bucket] = (distribution[bucket] ?? 0) + 1;
    total += rating;
  }

  const count = ratings.length;
  if (count === 0) {
    return { average: null, count: 0, distribution, positiveShareBps: 0 };
  }

  const positive =
    (distribution[RATING_MAX - RATING_MIN] ?? 0) + (distribution[RATING_MAX - RATING_MIN - 1] ?? 0);
  return {
    // Two decimals, matching `Merchant.ratingAvg Decimal(3,2)` — the column and
    // this function must agree or the cached value and the live one differ.
    average: roundHalfAwayFromZero((total / count) * 100) / 100,
    count,
    distribution,
    positiveShareBps: roundHalfAwayFromZero((positive / count) * 10_000),
  };
}
