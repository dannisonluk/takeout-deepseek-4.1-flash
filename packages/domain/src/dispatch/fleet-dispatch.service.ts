import { IdGenerator } from '../shared/index';
import {
  DispatchAssignment,
  DispatchContext,
  DispatchRequest,
  FulfilmentMode,
  IDispatchService,
} from './dispatch.types';
import {
  DispatchCandidate,
  DispatchScoringEngine,
} from './dispatch-scoring-engine';
import { UnsupportedFulfilmentModeError } from './dispatch.errors';
import {
  DeliveryTaskSnapshot,
  DeliveryTaskStatus,
  DriverStatus,
  IDriverAssignmentRepository,
  IDriverLocationRepository,
  IDriverRegistry,
  IdentityVerificationStatus,
  IRiderNotificationPort,
} from '../fleet/ports';

export interface FleetDispatchDependencies {
  readonly registry: IDriverRegistry;
  readonly locations: IDriverLocationRepository;
  readonly assignments: IDriverAssignmentRepository;
  readonly notifications: IRiderNotificationPort;
  readonly idGenerator: IdGenerator;
}

/**
 * Phase 2 reference implementation of `IDispatchService` for the platform fleet.
 *
 * Flow: eligible roster -> live positions (Redis geo) -> scoring -> assign ->
 * persist task -> flip rider status -> push notification.
 *
 * Every collaborator is a port, so this class is unit-testable with in-memory
 * fakes and no Redis or Postgres running.
 */
export class FleetDispatchService implements IDispatchService {
  readonly mode = FulfilmentMode.PLATFORM_FLEET;

  private readonly scoring: DispatchScoringEngine;

  constructor(
    private readonly deps: FleetDispatchDependencies,
    scoring: DispatchScoringEngine = new DispatchScoringEngine(),
  ) {
    this.scoring = scoring;
  }

  /** Fleet delivery requires a destination — self-pickup orders never reach here. */
  supports(request: DispatchRequest): boolean {
    return request.dropoffLocation !== undefined;
  }

  async dispatch(request: DispatchRequest, context: DispatchContext): Promise<DispatchAssignment> {
    const dropoff = request.dropoffLocation;
    if (!dropoff) {
      throw new UnsupportedFulfilmentModeError(this.mode, request.orderId);
    }

    const candidates = await this.collectCandidates(request, context);

    const best = this.scoring.select(request.orderId, request.merchantLocation, candidates, {
      now: context.now,
    });

    const task: DeliveryTaskSnapshot = Object.freeze({
      taskId: this.deps.idGenerator.next(),
      orderId: request.orderId,
      merchantId: request.merchantId,
      riderId: best.riderId,
      mode: this.mode,
      status: DeliveryTaskStatus.ASSIGNED,
      assignedAt: context.now,
      etaMinutes: best.etaMinutes,
    });

    await this.deps.assignments.create(task);
    await this.deps.registry.setStatus(best.riderId, DriverStatus.ON_DELIVERY);
    await this.deps.notifications.notifyAssignment(best.riderId, task);

    return Object.freeze({
      taskId: task.taskId,
      orderId: request.orderId,
      mode: this.mode,
      riderId: best.riderId,
      etaMinutes: best.etaMinutes,
      assignedAt: context.now,
      estimatedDistanceKm: best.distanceKm,
    });
  }

  async cancel(taskId: string, reason: string): Promise<void> {
    const task = await this.deps.assignments.findById(taskId);
    if (!task || task.status === DeliveryTaskStatus.CANCELLED) return;

    await this.deps.assignments.updateStatus(taskId, DeliveryTaskStatus.CANCELLED);
    if (!task.riderId) return;

    await this.deps.registry.setStatus(task.riderId, DriverStatus.ONLINE_IDLE);
    await this.deps.notifications.notifyCancellation(task.riderId, taskId, reason);
  }

  /**
   * Join the eligible roster against live positions.
   *
   * The roster is the authoritative source of capacity and verification; Redis
   * only tells us where people are. A rider who is online but has no recent
   * ping is simply not a candidate.
   */
  private async collectCandidates(
    request: DispatchRequest,
    context: DispatchContext,
  ): Promise<DispatchCandidate[]> {
    const [roster, nearby] = await Promise.all([
      this.deps.registry.findEligible(request.merchantId),
      this.deps.locations.findWithinRadius(
        request.merchantLocation,
        context.maxRadiusKm ?? this.scoring.maxRadiusKm,
      ),
    ]);

    const locationByRider = new Map(nearby.map((snapshot) => [snapshot.riderId, snapshot]));

    const eligible = roster.filter(
      (profile) =>
        profile.status === DriverStatus.ONLINE_IDLE &&
        profile.verification === IdentityVerificationStatus.VERIFIED &&
        (profile.allowedMerchantIds === null ||
          profile.allowedMerchantIds.includes(request.merchantId)),
    );

    const candidates = await Promise.all(
      eligible.map(async (profile): Promise<DispatchCandidate | null> => {
        const position = locationByRider.get(profile.riderId);
        if (!position) return null;

        const activeTaskCount = await this.deps.assignments.countActiveByRider(profile.riderId);

        return {
          riderId: profile.riderId,
          location: position.location,
          vehicle: profile.vehicle,
          activeTaskCount,
          maxConcurrentTasks: profile.maxConcurrentTasks,
          acceptanceRate: profile.acceptanceRate,
          onlineSince: profile.onlineSince ?? position.recordedAt,
        };
      }),
    );

    return candidates.filter((candidate): candidate is DispatchCandidate => candidate !== null);
  }
}
