import { GeoPoint } from '../shared/index';
import { DispatchContext, DeliveryVehicle, VEHICLE_SPEED_KMH } from './dispatch.types';
import { NoRiderAvailableError } from './dispatch.errors';

/** A rider who could in principle take the job, before ranking. */
export interface DispatchCandidate {
  readonly riderId: string;
  readonly location: GeoPoint;
  readonly vehicle: DeliveryVehicle;
  readonly activeTaskCount: number;
  readonly maxConcurrentTasks: number;
  /** Rolling acceptance rate in [0, 1]. */
  readonly acceptanceRate: number;
  readonly onlineSince: Date;
}

/**
 * Relative importance of each ranking dimension. Weights are normalised on use,
 * so `{ distance: 55, load: 25 }` behaves the same as `{ distance: 0.55, load: 0.25 }`.
 */
export interface DispatchScoringWeights {
  readonly distance: number;
  readonly load: number;
  readonly idle: number;
  readonly reliability: number;
}

/** Tuned for dense urban Hong Kong: short trips, tight radius, low tolerance for load. */
export const DEFAULT_DISPATCH_WEIGHTS: DispatchScoringWeights = Object.freeze({
  distance: 0.55,
  load: 0.25,
  idle: 0.1,
  reliability: 0.1,
});

export interface DispatchScoringOptions {
  /** Candidates farther than this are dropped before scoring. Default 3 km. */
  readonly maxRadiusKm?: number;
  /** Idle time at which "how long have you been waiting" saturates. Default 20 min. */
  readonly idleCapMinutes?: number;
  /** Time to park, collect the bag, and leave. Default 3 min. */
  readonly handoverBufferMinutes?: number;
  /** ETA penalty per task already in the rider's bag. Default 4 min. */
  readonly loadPenaltyMinutes?: number;
}

export interface ScoredCandidate {
  readonly riderId: string;
  /** 0 = worst, 1 = best. Higher wins. */
  readonly score: number;
  readonly distanceKm: number;
  readonly etaMinutes: number;
  readonly breakdown: {
    readonly distance: number;
    readonly load: number;
    readonly idle: number;
    readonly reliability: number;
  };
}

interface ResolvedOptions extends Required<DispatchScoringOptions> {}

const DEFAULT_OPTIONS: ResolvedOptions = {
  maxRadiusKm: 3,
  idleCapMinutes: 20,
  handoverBufferMinutes: 3,
  loadPenaltyMinutes: 4,
};

/**
 * Distance/load/idle scoring for rider assignment.
 *
 * Pure and synchronous — it takes candidates and returns a ranking. It performs
 * no I/O, so the whole algorithm is unit-testable without Redis, and the
 * weighting can be tuned per city without touching transport code.
 *
 * Phase 2 wires this behind `IDispatchService`; phase 3 can swap in an ML ranker
 * by replacing this class alone.
 */
export class DispatchScoringEngine {
  private readonly weights: DispatchScoringWeights;
  private readonly options: ResolvedOptions;

  constructor(
    weights: Partial<DispatchScoringWeights> = DEFAULT_DISPATCH_WEIGHTS,
    options: DispatchScoringOptions = {},
  ) {
    this.weights = { ...DEFAULT_DISPATCH_WEIGHTS, ...weights };
    this.options = { ...DEFAULT_OPTIONS, ...options };
    if (this.weights.distance + this.weights.load + this.weights.idle + this.weights.reliability <= 0) {
      throw new RangeError('Dispatch scoring weights must sum to a positive number');
    }
  }

  /**
   * Radius beyond which candidates are discarded. Exposed so the caller can
   * size its geo query with the same number the ranker will enforce.
   */
  get maxRadiusKm(): number {
    return this.options.maxRadiusKm;
  }

  /**
   * Rank every eligible candidate, best first.
   * Deterministic: ties break on ETA, then on `riderId`, so two identical
   * dispatches always pick the same rider.
   */
  rank(
    origin: GeoPoint,
    candidates: readonly DispatchCandidate[],
    context: Pick<DispatchContext, 'now'>,
  ): ScoredCandidate[] {
    const eligible = candidates.filter((candidate) => this.isEligible(origin, candidate));
    const scored = eligible.map((candidate) => this.score(origin, candidate, context.now));

    return scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.etaMinutes !== b.etaMinutes) return a.etaMinutes - b.etaMinutes;
      return a.riderId < b.riderId ? -1 : a.riderId > b.riderId ? 1 : 0;
    });
  }

  /** Best candidate, or `NoRiderAvailableError` when the pool is empty. */
  select(
    orderId: string,
    origin: GeoPoint,
    candidates: readonly DispatchCandidate[],
    context: Pick<DispatchContext, 'now'>,
  ): ScoredCandidate {
    const ranked = this.rank(origin, candidates, context);
    const best = ranked[0];
    if (!best) {
      throw new NoRiderAvailableError(orderId, {
        candidatesConsidered: candidates.length,
        radiusKm: this.options.maxRadiusKm,
      });
    }
    return best;
  }

  /** Travel + handover + in-bag penalty. */
  estimateEtaMinutes(distanceKm: number, candidate: DispatchCandidate): number {
    const speed = VEHICLE_SPEED_KMH[candidate.vehicle];
    const travel = (distanceKm / speed) * 60;
    return (
      travel +
      this.options.handoverBufferMinutes +
      candidate.activeTaskCount * this.options.loadPenaltyMinutes
    );
  }

  private isEligible(origin: GeoPoint, candidate: DispatchCandidate): boolean {
    if (candidate.activeTaskCount >= candidate.maxConcurrentTasks) return false;
    if (candidate.maxConcurrentTasks <= 0) return false;
    return origin.distanceKmTo(candidate.location) <= this.options.maxRadiusKm;
  }

  private score(origin: GeoPoint, candidate: DispatchCandidate, now: Date): ScoredCandidate {
    const distanceKm = origin.distanceKmTo(candidate.location);
    const etaMinutes = this.estimateEtaMinutes(distanceKm, candidate);

    // Each dimension is normalised to 0..1 where 1 is most desirable.
    const distanceScore = clamp01(1 - distanceKm / this.options.maxRadiusKm);
    const loadScore = clamp01(1 - candidate.activeTaskCount / candidate.maxConcurrentTasks);
    const idleMinutes = Math.max(0, (now.getTime() - candidate.onlineSince.getTime()) / 60_000);
    const idleScore = clamp01(idleMinutes / this.options.idleCapMinutes);
    const reliabilityScore = clamp01(candidate.acceptanceRate);

    const weightTotal =
      this.weights.distance + this.weights.load + this.weights.idle + this.weights.reliability;

    const score =
      (this.weights.distance * distanceScore +
        this.weights.load * loadScore +
        this.weights.idle * idleScore +
        this.weights.reliability * reliabilityScore) /
      weightTotal;

    return {
      riderId: candidate.riderId,
      score: Math.round(score * 1e6) / 1e6,
      distanceKm: Math.round(distanceKm * 1000) / 1000,
      etaMinutes: Math.round(etaMinutes * 10) / 10,
      breakdown: {
        distance: round6(distanceScore),
        load: round6(loadScore),
        idle: round6(idleScore),
        reliability: round6(reliabilityScore),
      },
    };
  }
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
