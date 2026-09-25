import { describe, expect, it } from 'vitest';
import {
  assertValidRating,
  isValidRating,
  isReviewTag,
  RATING_MAX,
  RATING_MIN,
  ratingBand,
  REVIEW_TAG_LABEL_ZH_HK,
  REVIEW_TAGS,
  summariseRatings,
  ValidationError,
} from '../src/index';

describe('rating vocabulary', () => {
  it('accepts exactly the five whole stars', () => {
    for (let rating = RATING_MIN; rating <= RATING_MAX; rating += 1) {
      expect(isValidRating(rating)).toBe(true);
      expect(() => assertValidRating(rating)).not.toThrow();
    }
  });

  it('refuses zero, six, fractions and non-numbers', () => {
    // Zero matters most: it is the value a missing rating collapses to in
    // JavaScript, and accepting it would drag every average down.
    for (const bad of [0, 6, -1, 4.5, '5', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidRating(bad)).toBe(false);
      expect(() => assertValidRating(bad)).toThrow(ValidationError);
    }
  });

  it('has a label for every tag, so no tag can render as its raw enum name', () => {
    for (const tag of REVIEW_TAGS) {
      expect(REVIEW_TAG_LABEL_ZH_HK[tag]).toBeTruthy();
    }
    expect(Object.keys(REVIEW_TAG_LABEL_ZH_HK)).toHaveLength(REVIEW_TAGS.length);
  });

  it('validates tags against the fixed vocabulary', () => {
    expect(isReviewTag('TASTE')).toBe(true);
    expect(isReviewTag('taste')).toBe(false);
    expect(isReviewTag('DELICIOUS')).toBe(false);
    expect(isReviewTag(7)).toBe(false);
  });
});

describe('ratingBand', () => {
  it('reads 4-5 positive, 3 neutral, 1-2 negative', () => {
    expect(ratingBand(5)).toBe('POSITIVE');
    expect(ratingBand(4)).toBe('POSITIVE');
    expect(ratingBand(3)).toBe('NEUTRAL');
    expect(ratingBand(2)).toBe('NEGATIVE');
    expect(ratingBand(1)).toBe('NEGATIVE');
  });

  it('refuses to band an out-of-range value rather than guessing', () => {
    expect(() => ratingBand(0)).toThrow(ValidationError);
    expect(() => ratingBand(6)).toThrow(ValidationError);
  });
});

describe('summariseRatings', () => {
  it('returns null average for no reviews, never 0', () => {
    // A new merchant must not render as "0.0 ★" — zero is the worst score,
    // not the absence of one.
    const summary = summariseRatings([]);
    expect(summary.average).toBeNull();
    expect(summary.count).toBe(0);
    expect(summary.positiveShareBps).toBe(0);
    expect(summary.distribution).toEqual([0, 0, 0, 0, 0]);
  });

  it('averages to two decimals, matching Merchant.ratingAvg Decimal(3,2)', () => {
    expect(summariseRatings([5, 4]).average).toBe(4.5);
    expect(summariseRatings([5, 4, 4]).average).toBe(4.33);
    expect(summariseRatings([1, 1, 1]).average).toBe(1);
  });

  it('counts the distribution from 1 star at index 0', () => {
    const summary = summariseRatings([5, 5, 3, 1]);
    expect(summary.distribution).toEqual([1, 0, 1, 0, 2]);
    expect(summary.count).toBe(4);
  });

  it('distinguishes two merchants that share an average but not a business', () => {
    // All fours and alternating fives and threes both average 4.0. The
    // distribution is the part an average destroys.
    const steady = summariseRatings([4, 4, 4, 4]);
    const volatile = summariseRatings([5, 3, 5, 3]);
    expect(steady.average).toBe(volatile.average);
    expect(steady.positiveShareBps).toBe(10_000);
    expect(volatile.positiveShareBps).toBe(5_000);
  });

  it('refuses an out-of-range value instead of quietly averaging it in', () => {
    expect(() => summariseRatings([5, 0])).toThrow(ValidationError);
    expect(() => summariseRatings([5, 4.5])).toThrow(ValidationError);
  });

  it('rounds the positive share half away from zero', () => {
    // 2 of 3 positive = 6666.67bps -> 6667.
    expect(summariseRatings([5, 5, 1]).positiveShareBps).toBe(6_667);
    expect(summariseRatings([5, 5, 5]).positiveShareBps).toBe(10_000);
  });

  it('keeps the average and the distribution consistent', () => {
    const ratings = [1, 2, 3, 4, 5, 5];
    const summary = summariseRatings(ratings);
    const weighted = summary.distribution.reduce(
      (sum, count, index) => sum + count * (index + RATING_MIN),
      0,
    );
    expect(weighted / summary.count).toBeCloseTo(summary.average as number, 2);
  });
});
