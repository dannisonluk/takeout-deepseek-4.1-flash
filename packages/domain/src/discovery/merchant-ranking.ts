/**
 * Merchant ranking — a pure scoring policy.
 *
 * Discovery used to sort by true distance and nothing else, which is the right
 * answer to "what is closest" and the wrong answer to "what should I order".
 * A merchant 400 m away with a 45-minute prep time and no reviews loses to one
 * 900 m away that is rated 4.7 and turns orders around in 10 minutes.
 *
 * Pure and dependency-free, like `PricingEngine` and `OrderStateMachine`: the
 * caller supplies the numbers, the policy decides the order, and every rule is
 * testable in microseconds without a database.
 *
 * **Lower score wins.** All three terms are "cost-like" (a bigger number is
 * worse), which makes the weighted sum meaningful without any sign juggling.
 *
 * **Engines are immutable and built per preset**, deliberately. The obvious
 * alternative — one shared instance with a `usePreset()` mutator, mirroring
 * `PricingEngine.usePolicy()` — is wrong here: the preset is a *per-request*
 * query parameter, so mutating a shared engine would let two concurrent
 * requests change each other's ordering. `PricingEngine` gets away with
 * mutation because its policy is global configuration that changes rarely.
 */

export interface RankingWeights {
  /** Cost of being far away. */
  readonly distance: number;
  /** Cost of being poorly rated. */
  readonly rating: number;
  /** Cost of a long wait. */
  readonly prepTime: number;
}

export interface RankingPolicy {
  readonly weights: RankingWeights;
  /** Distance that scores a full 1.0. Beyond this the term saturates. */
  readonly referenceDistanceKm: number;
  /** Prep time that scores a full 1.0. */
  readonly referencePrepMinutes: number;
  /** Rating assumed for a merchant with no reviews yet. */
  readonly neutralRating: number;
  /**
   * How many reviews it takes before a merchant's own average outweighs the
   * neutral prior. See `shrinkRating`.
   */
  readonly priorReviewCount: number;
  /** Rating scale top. 5 for a five-star scale. */
  readonly maxRating: number;
}

export interface RankingCandidate {
  readonly id: string;
  /** `null` when no origin was supplied — the distance term is then skipped. */
  readonly distanceKm: number | null;
  readonly ratingAvg: number | null;
  readonly ratingCount: number;
  readonly prepTimeMinutes: number;
}

export interface RankedCandidate extends RankingCandidate {
  /** Lower is better. Only comparable between candidates scored by the same policy. */
  readonly score: number;
}

export const DEFAULT_RANKING_POLICY: RankingPolicy = {
  weights: { distance: 1, rating: 0, prepTime: 0 },
  referenceDistanceKm: 3,
  referencePrepMinutes: 30,
  neutralRating: 3.5,
  priorReviewCount: 20,
  maxRating: 5,
};

/**
 * Named presets, so the API can expose a `sort` param without inventing weights
 * and so the meaning of a preset is reviewable in one place.
 */
export const RANKING_PRESETS = {
  /** What discovery did before: pure distance. The default, and the safe one. */
  NEAREST: DEFAULT_RANKING_POLICY,
  /** Willing to walk further for a better kitchen. */
  RATING: {
    ...DEFAULT_RANKING_POLICY,
    weights: { distance: 0.2, rating: 1, prepTime: 0 },
  },
  /** Hungry now. */
  FASTEST: {
    ...DEFAULT_RANKING_POLICY,
    weights: { distance: 0.3, rating: 0, prepTime: 1 },
  },
  /** A little of everything, distance still dominant. */
  BALANCED: {
    ...DEFAULT_RANKING_POLICY,
    weights: { distance: 0.5, rating: 0.3, prepTime: 0.2 },
  },
} as const satisfies Readonly<Record<string, RankingPolicy>>;

export type RankingPresetName = keyof typeof RANKING_PRESETS;

export const RANKING_PRESET_NAMES = Object.keys(RANKING_PRESETS) as RankingPresetName[];

/** Build an engine for a preset. Cheap — presets are module-level constants. */
export function rankingEngineFor(
  preset: RankingPresetName,
  overrides: Partial<RankingPolicy> = {},
): MerchantRankingEngine {
  return new MerchantRankingEngine({ ...RANKING_PRESETS[preset], ...overrides });
}

export class MerchantRankingEngine {
  private readonly policy: RankingPolicy;

  constructor(policy: Partial<RankingPolicy> = {}) {
    this.policy = {
      ...DEFAULT_RANKING_POLICY,
      ...policy,
      weights: { ...DEFAULT_RANKING_POLICY.weights, ...(policy.weights ?? {}) },
    };
  }

  /** Read-only view — used by the API to explain what a preset actually means. */
  get currentPolicy(): RankingPolicy {
    return this.policy;
  }

  /** Lower is better. Ties are broken by the caller, not here. */
  score(candidate: RankingCandidate): number {
    const { weights, referenceDistanceKm, referencePrepMinutes, maxRating } = this.policy;

    // A missing distance is not "very far" — it means no origin was supplied,
    // in which case the term must not silently penalise everyone equally and
    // swamp the two that do have data. Skipping it is the only honest reading.
    const distanceTerm =
      candidate.distanceKm === null ? 0 : clamp01(candidate.distanceKm / referenceDistanceKm);

    const ratingTerm = 1 - clamp01(this.shrinkRating(candidate) / maxRating);
    const prepTerm = clamp01(candidate.prepTimeMinutes / referencePrepMinutes);

    return (
      weights.distance * distanceTerm + weights.rating * ratingTerm + weights.prepTime * prepTerm
    );
  }

  /**
   * Bayesian shrinkage toward the neutral prior.
   *
   * A raw average is a trap: one 5-star review would outrank five hundred
   * 4.8-star reviews, and a brand-new merchant with no reviews at all would
   * either be invisible or — worse — treated as perfect. Pulling toward the
   * prior by `priorReviewCount` means a merchant has to earn their average
   * before it carries weight, and no-review merchants sit at neutral rather
   * than at an extreme.
   */
  shrinkRating(candidate: RankingCandidate): number {
    const { neutralRating, priorReviewCount, maxRating } = this.policy;
    const reviews = Math.max(0, candidate.ratingCount);
    if (reviews === 0) return neutralRating;

    const average = clamp(candidate.ratingAvg ?? neutralRating, 0, maxRating);
    return (average * reviews + neutralRating * priorReviewCount) / (reviews + priorReviewCount);
  }

  /**
   * Score and sort, best first.
   *
   * The `id` tie-break is not cosmetic: without a total order, two merchants
   * with the same score can swap places between calls, and a paged request can
   * then show one twice and the other never.
   */
  rank(candidates: readonly RankingCandidate[]): RankedCandidate[] {
    return candidates
      .map((candidate) => ({ ...candidate, score: this.score(candidate) }))
      .sort((a, b) => (a.score !== b.score ? a.score - b.score : a.id.localeCompare(b.id)));
  }
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
