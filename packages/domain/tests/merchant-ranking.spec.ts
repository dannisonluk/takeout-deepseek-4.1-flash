import { describe, expect, it } from 'vitest';
import {
  MerchantRankingEngine,
  RANKING_PRESET_NAMES,
  RANKING_PRESETS,
  rankingEngineFor,
  type RankingCandidate,
} from '../src/index';

/** A merchant that is close, well rated and quick — the one you would pick. */
const good: RankingCandidate = {
  id: 'good',
  distanceKm: 0.4,
  ratingAvg: 4.8,
  ratingCount: 400,
  prepTimeMinutes: 10,
};

/** Far, mediocre, slow — the one you would not. */
const bad: RankingCandidate = {
  id: 'bad',
  distanceKm: 2.8,
  ratingAvg: 3.0,
  ratingCount: 60,
  prepTimeMinutes: 28,
};

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe('MerchantRankingEngine — weights', () => {
  it('NEAREST (the default) orders by distance and ignores everything else', () => {
    const engine = new MerchantRankingEngine();
    const near = { ...bad, id: 'near', distanceKm: 0.1 };
    const far = { ...good, id: 'far', distanceKm: 2.9 };

    expect(ids(engine.rank([far, near]))).toEqual(['near', 'far']);
  });

  it('RATING lets a better kitchen beat a closer one', () => {
    const engine = rankingEngineFor('RATING');
    expect(ids(engine.rank([bad, good]))).toEqual(['good', 'bad']);
  });

  it('FASTEST lets a quicker kitchen beat a closer one', () => {
    const engine = rankingEngineFor('FASTEST');

    const quickFar = { ...good, id: 'quickFar', distanceKm: 2.5, prepTimeMinutes: 5 };
    const slowNear = { ...good, id: 'slowNear', distanceKm: 0.2, prepTimeMinutes: 45 };

    expect(ids(engine.rank([slowNear, quickFar]))).toEqual(['quickFar', 'slowNear']);
  });

  it('BALANCED trades distance against quality without either dominating', () => {
    const engine = rankingEngineFor('BALANCED');
    const policy = engine.currentPolicy;

    expect(policy.weights.distance).toBeGreaterThan(policy.weights.rating);
    expect(policy.weights.distance).toBeGreaterThan(policy.weights.prepTime);
    expect(policy.weights.rating).toBeGreaterThan(0);
    expect(policy.weights.prepTime).toBeGreaterThan(0);
  });

  it('exposes every preset name, so the API can validate against one list', () => {
    expect(RANKING_PRESET_NAMES.sort()).toEqual(
      ['BALANCED', 'FASTEST', 'NEAREST', 'RATING'].sort(),
    );
    expect(RANKING_PRESET_NAMES).toContain('NEAREST');
  });

  it('keeps presets immutable, because two requests can rank at the same time', () => {
    // A shared mutable engine would let one request's `sort=RATING` reorder
    // another request's results. Building per preset removes the shared state
    // entirely — this asserts nobody reintroduces it by mutating a preset.
    const before = JSON.stringify(RANKING_PRESETS.RATING);
    rankingEngineFor('RATING');
    expect(JSON.stringify(RANKING_PRESETS.RATING)).toBe(before);
  });
});

describe('MerchantRankingEngine — rating shrinkage', () => {
  const engine = new MerchantRankingEngine({ weights: { distance: 0, rating: 1, prepTime: 0 } });

  it('does not let one five-star review outrank a long four-point-eight record', () => {
    const lucky = { ...good, id: 'lucky', ratingAvg: 5, ratingCount: 1 };
    const proven = { ...good, id: 'proven', ratingAvg: 4.8, ratingCount: 500 };

    expect(ids(engine.rank([lucky, proven]))).toEqual(['proven', 'lucky']);
  });

  it('treats a merchant with no reviews as neutral, not as perfect or terrible', () => {
    const noReviews = { ...good, id: 'new', ratingAvg: null, ratingCount: 0 };
    // Neutral rating of 3.5 on a 5-point scale -> 1 - 0.7 = 0.3
    expect(engine.score(noReviews)).toBeCloseTo(0.3, 5);
  });

  it('still lets a genuinely excellent merchant beat a neutral one', () => {
    const noReviews = { ...good, id: 'new', ratingAvg: null, ratingCount: 0 };
    const excellent = { ...good, id: 'excellent', ratingAvg: 4.9, ratingCount: 300 };

    expect(ids(engine.rank([noReviews, excellent]))).toEqual(['excellent', 'new']);
  });
});

describe('MerchantRankingEngine — edge cases', () => {
  it('skips the distance term when no origin was supplied', () => {
    // Otherwise every candidate would get the same distance term and it would
    // dilute the weights that DO have data to work with.
    const engine = rankingEngineFor('BALANCED');

    const a = { ...good, id: 'a', distanceKm: null, prepTimeMinutes: 5 };
    const b = { ...good, id: 'b', distanceKm: null, prepTimeMinutes: 40 };

    expect(ids(engine.rank([b, a]))).toEqual(['a', 'b']);
  });

  it('saturates a distance beyond the reference instead of running away', () => {
    const engine = new MerchantRankingEngine({ referenceDistanceKm: 3 });
    expect(engine.score({ ...good, distanceKm: 3 })).toBeCloseTo(1, 5);
    expect(engine.score({ ...good, distanceKm: 300 })).toBeCloseTo(1, 5);
  });

  it('breaks ties by id so paging cannot show one merchant twice', () => {
    const engine = new MerchantRankingEngine();
    const twinA = { ...good, id: 'aaa' };
    const twinB = { ...good, id: 'bbb' };

    expect(ids(engine.rank([twinB, twinA]))).toEqual(['aaa', 'bbb']);
    // And the order is stable when the input order flips.
    expect(ids(engine.rank([twinA, twinB]))).toEqual(['aaa', 'bbb']);
  });

  it('survives a missing rating average without producing NaN', () => {
    const engine = new MerchantRankingEngine();
    expect(Number.isFinite(engine.score({ ...good, ratingAvg: null, ratingCount: 12 }))).toBe(true);
  });

  it('never returns a negative or unbounded score', () => {
    const engine = rankingEngineFor('BALANCED');

    for (const candidate of [
      good,
      bad,
      { ...good, distanceKm: -5, ratingAvg: 99, prepTimeMinutes: -10 },
    ]) {
      const score = engine.score(candidate);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(2);
    }
  });
});
