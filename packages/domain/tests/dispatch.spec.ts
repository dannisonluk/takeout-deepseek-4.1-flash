import { describe, expect, it } from 'vitest';
import {
  DeliveryTaskStatus,
  DeliveryVehicle,
  DispatchCandidate,
  DispatchScoringEngine,
  DriverStatus,
  FleetDispatchService,
  FulfilmentMode,
  GeoPoint,
  IDriverAssignmentRepository,
  IDriverLocationRepository,
  IDriverRegistry,
  IdentityVerificationStatus,
  IRiderNotificationPort,
  NoRiderAvailableError,
  SelfPickupDispatchService,
  SequentialIdGenerator,
  UnsupportedFulfilmentModeError,
  DriverProfile,
  DeliveryTaskSnapshot,
  DriverLocationSnapshot,
  DispatchRequest,
} from '../src/index';

const CENTRAL = GeoPoint.of(22.2819, 114.1582);
const TST = GeoPoint.of(22.2976, 114.1722);
const NOW = new Date('2026-09-24T10:00:00.000Z');

const rider = (overrides: Partial<DispatchCandidate> & { riderId: string }): DispatchCandidate => ({
  location: CENTRAL,
  vehicle: DeliveryVehicle.MOTORCYCLE,
  activeTaskCount: 0,
  maxConcurrentTasks: 3,
  acceptanceRate: 0.9,
  onlineSince: new Date(NOW.getTime() - 10 * 60_000),
  ...overrides,
});

describe('SelfPickupDispatchService', () => {
  it('assigns a ticket with no rider and the merchant prep ETA', async () => {
    const service = new SelfPickupDispatchService(new SequentialIdGenerator());
    const request: DispatchRequest = {
      orderId: 'ord_1',
      merchantId: 'mer_1',
      merchantLocation: CENTRAL,
      readyAt: new Date(NOW.getTime() + 15 * 60_000),
      estimatedPrepMinutes: 15,
      itemCount: 2,
      priority: 'NORMAL',
    };

    const assignment = await service.dispatch(request, { now: NOW, requestId: 'req_1' });

    expect(assignment.mode).toBe(FulfilmentMode.SELF_PICKUP);
    expect(assignment.riderId).toBeUndefined();
    expect(assignment.etaMinutes).toBe(15);
    expect(assignment.orderId).toBe('ord_1');
  });

  it('supports every order — self-pickup is the fallback strategy', async () => {
    const service = new SelfPickupDispatchService(new SequentialIdGenerator());
    expect(service.supports({} as DispatchRequest)).toBe(true);
    // Cancelling an unassigned task must not throw.
    await expect(service.cancel('task_1', 'noop')).resolves.toBeUndefined();
  });
});

describe('DispatchScoringEngine', () => {
  const engine = new DispatchScoringEngine();

  it('prefers the nearest rider when everything else is equal', () => {
    const near = rider({ riderId: 'r_near', location: GeoPoint.of(22.283, 114.159) });
    const far = rider({ riderId: 'r_far', location: GeoPoint.of(22.295, 114.168) }); // ~1.8 km

    const ranked = engine.rank(CENTRAL, [far, near], { now: NOW });
    expect(ranked.map((r) => r.riderId)).toEqual(['r_near', 'r_far']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('drops candidates outside the radius', () => {
    const inRange = rider({ riderId: 'r_in', location: TST });
    const tooFar = rider({ riderId: 'r_out', location: GeoPoint.of(22.45, 114.03) }); // ~25 km

    const ranked = engine.rank(CENTRAL, [inRange, tooFar], { now: NOW });
    expect(ranked.map((r) => r.riderId)).toEqual(['r_in']);
  });

  it('drops candidates who are at capacity', () => {
    const free = rider({ riderId: 'r_free' });
    const full = rider({ riderId: 'r_full', activeTaskCount: 3, maxConcurrentTasks: 3 });

    const ranked = engine.rank(CENTRAL, [free, full], { now: NOW });
    expect(ranked.map((r) => r.riderId)).toEqual(['r_free']);
  });

  it('trades a little distance for a much emptier rider', () => {
    const closeButBusy = rider({
      riderId: 'r_busy',
      location: GeoPoint.of(22.2825, 114.1585), // ~0.1 km
      activeTaskCount: 2,
      maxConcurrentTasks: 3,
    });
    const slightlyFurtherFree = rider({
      riderId: 'r_free',
      location: GeoPoint.of(22.286, 114.16), // ~0.5 km
      activeTaskCount: 0,
      maxConcurrentTasks: 3,
    });

    const ranked = engine.rank(CENTRAL, [closeButBusy, slightlyFurtherFree], { now: NOW });
    expect(ranked[0]!.riderId).toBe('r_free');
  });

  it('breaks ties deterministically on riderId', () => {
    const a = rider({ riderId: 'aaa' });
    const b = rider({ riderId: 'bbb' });

    expect(engine.rank(CENTRAL, [b, a], { now: NOW }).map((r) => r.riderId)).toEqual(['aaa', 'bbb']);
    // Same input, reversed order -> same output. No random picker.
    expect(engine.rank(CENTRAL, [a, b], { now: NOW }).map((r) => r.riderId)).toEqual(['aaa', 'bbb']);
  });

  it('estimates ETA from vehicle speed plus a handover buffer', () => {
    const bike = rider({ riderId: 'r_bike', vehicle: DeliveryVehicle.BICYCLE, location: TST });
    const moto = rider({ riderId: 'r_moto', vehicle: DeliveryVehicle.MOTORCYCLE, location: TST });

    const distanceKm = CENTRAL.distanceKmTo(TST);
    const bikeEta = engine.estimateEtaMinutes(distanceKm, bike);
    const motoEta = engine.estimateEtaMinutes(distanceKm, moto);

    expect(motoEta).toBeLessThan(bikeEta);
    // travel time at the vehicle's speed, plus the 3 min handover buffer.
    expect(motoEta).toBeCloseTo((distanceKm / 25) * 60 + 3, 5);
    expect(bikeEta).toBeCloseTo((distanceKm / 12) * 60 + 3, 5);
  });

  it('adds a per-bag penalty so a loaded rider is not double-booked eagerly', () => {
    const idle = rider({ riderId: 'r_idle', location: TST });
    const loaded = rider({ riderId: 'r_loaded', location: TST, activeTaskCount: 2 });

    const distanceKm = CENTRAL.distanceKmTo(TST);
    expect(engine.estimateEtaMinutes(distanceKm, loaded)).toBeGreaterThan(
      engine.estimateEtaMinutes(distanceKm, idle),
    );
  });

  it('rewards idle time so waiting riders are not starved', () => {
    const justOnline = rider({
      riderId: 'r_new',
      location: TST,
      onlineSince: new Date(NOW.getTime() - 30_000),
    });
    const waiting = rider({
      riderId: 'r_waiting',
      location: TST,
      onlineSince: new Date(NOW.getTime() - 15 * 60_000),
    });

    const ranked = engine.rank(CENTRAL, [justOnline, waiting], { now: NOW });
    expect(ranked[0]!.riderId).toBe('r_waiting');
  });

  it('raises rather than returning undefined when nobody is available', () => {
    expect(() => engine.select('ord_1', CENTRAL, [], { now: NOW })).toThrow(NoRiderAvailableError);
  });

  it('exposes the radius it enforces', () => {
    expect(engine.maxRadiusKm).toBe(3);
    expect(new DispatchScoringEngine({}, { maxRadiusKm: 5 }).maxRadiusKm).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* In-memory fakes — no Redis, no Postgres.                            */
/* ------------------------------------------------------------------ */

const verifiedRider = (overrides: Partial<DriverProfile> & { riderId: string }): DriverProfile => ({
  displayName: '陳師傅',
  phone: '+85290000000',
  vehicle: DeliveryVehicle.MOTORCYCLE,
  status: DriverStatus.ONLINE_IDLE,
  verification: IdentityVerificationStatus.VERIFIED,
  maxConcurrentTasks: 3,
  acceptanceRate: 0.9,
  allowedMerchantIds: null,
  onlineSince: new Date(NOW.getTime() - 5 * 60_000),
  ...overrides,
});

class FakeRegistry implements IDriverRegistry {
  constructor(private readonly profiles: DriverProfile[]) {}
  readonly statusWrites: Array<{ riderId: string; status: DriverStatus }> = [];

  async findById(riderId: string) {
    return this.profiles.find((p) => p.riderId === riderId) ?? null;
  }
  async findEligible() {
    return this.profiles;
  }
  async setStatus(riderId: string, status: DriverStatus) {
    this.statusWrites.push({ riderId, status });
  }
  async markOnline() {}
}

class FakeLocations implements IDriverLocationRepository {
  constructor(private readonly snapshots: DriverLocationSnapshot[]) {}
  async upsert() {}
  async findWithinRadius(center: GeoPoint, radiusKm: number) {
    return this.snapshots.filter((s) => center.distanceKmTo(s.location) <= radiusKm);
  }
  async getTrail() {
    return [];
  }
  async remove() {}
}

class FakeAssignments implements IDriverAssignmentRepository {
  readonly created: DeliveryTaskSnapshot[] = [];
  private readonly statuses = new Map<string, DeliveryTaskStatus>();
  private readonly active = new Map<string, number>();

  async create(task: DeliveryTaskSnapshot) {
    // The real service hands out frozen snapshots; store a mutable projection.
    this.created.push({ ...task });
    this.statuses.set(task.taskId, task.status);
    if (task.riderId) {
      this.active.set(task.riderId, (this.active.get(task.riderId) ?? 0) + 1);
    }
  }
  async findById(taskId: string) {
    const task = this.created.find((t) => t.taskId === taskId);
    if (!task) return null;
    return { ...task, status: this.statuses.get(taskId) ?? task.status };
  }
  async countActiveByRider(riderId: string) {
    return this.active.get(riderId) ?? 0;
  }
  async updateStatus(taskId: string, status: DeliveryTaskStatus) {
    this.statuses.set(taskId, status);
  }
  async reassign() {}

  statusOf(taskId: string): DeliveryTaskStatus | undefined {
    return this.statuses.get(taskId);
  }
}

class FakeNotifications implements IRiderNotificationPort {
  readonly assigned: string[] = [];
  readonly cancelled: string[] = [];
  async notifyAssignment(riderId: string) {
    this.assigned.push(riderId);
  }
  async notifyCancellation(riderId: string) {
    this.cancelled.push(riderId);
  }
}

describe('FleetDispatchService (phase 2 reference implementation)', () => {
  const buildRequest = (overrides: Partial<DispatchRequest> = {}): DispatchRequest => ({
    orderId: 'ord_1',
    merchantId: 'mer_1',
    merchantLocation: CENTRAL,
    dropoffLocation: GeoPoint.of(22.29, 114.16),
    readyAt: new Date(NOW.getTime() + 10 * 60_000),
    estimatedPrepMinutes: 10,
    itemCount: 2,
    priority: 'NORMAL',
    ...overrides,
  });

  const build = (profiles: DriverProfile[], snapshots: DriverLocationSnapshot[]) => {
    const registry = new FakeRegistry(profiles);
    const assignments = new FakeAssignments();
    const notifications = new FakeNotifications();
    const service = new FleetDispatchService({
      registry,
      locations: new FakeLocations(snapshots),
      assignments,
      notifications,
      idGenerator: new SequentialIdGenerator(),
    });
    return { service, registry, assignments, notifications };
  };

  it('only claims orders that have a destination', () => {
    const { service } = build([], []);
    expect(service.supports(buildRequest())).toBe(true);
    expect(service.supports(buildRequest({ dropoffLocation: undefined }))).toBe(false);
  });

  it('assigns the best rider and records the task', async () => {
    const { service, registry, assignments, notifications } = build(
      [
        verifiedRider({ riderId: 'r_near' }),
        verifiedRider({ riderId: 'r_far' }),
      ],
      [
        { riderId: 'r_near', location: GeoPoint.of(22.282, 114.159), recordedAt: NOW },
        { riderId: 'r_far', location: GeoPoint.of(22.31, 114.185), recordedAt: NOW },
      ],
    );

    const assignment = await service.dispatch(buildRequest(), { now: NOW, requestId: 'req_1' });

    expect(assignment.mode).toBe(FulfilmentMode.PLATFORM_FLEET);
    expect(assignment.riderId).toBe('r_near');
    expect(assignment.estimatedDistanceKm).toBeLessThan(1);

    expect(assignments.created).toHaveLength(1);
    expect(assignments.created[0]!.status).toBe(DeliveryTaskStatus.ASSIGNED);
    expect(registry.statusWrites).toEqual([
      { riderId: 'r_near', status: DriverStatus.ON_DELIVERY },
    ]);
    expect(notifications.assigned).toEqual(['r_near']);
  });

  it('skips riders who are offline, unverified, or not allowed on this merchant', async () => {
    const { service } = build(
      [
        verifiedRider({ riderId: 'r_offline', status: DriverStatus.OFFLINE }),
        verifiedRider({ riderId: 'r_unverified', verification: IdentityVerificationStatus.PENDING }),
        verifiedRider({ riderId: 'r_wrong_merchant', allowedMerchantIds: ['mer_other'] }),
        verifiedRider({ riderId: 'r_ok' }),
      ],
      ['r_offline', 'r_unverified', 'r_wrong_merchant', 'r_ok'].map((riderId) => ({
        riderId,
        location: CENTRAL,
        recordedAt: NOW,
      })),
    );

    const assignment = await service.dispatch(buildRequest(), { now: NOW, requestId: 'req_2' });
    expect(assignment.riderId).toBe('r_ok');
  });

  it('skips a rider who is online but has no recent position ping', async () => {
    const { service } = build([verifiedRider({ riderId: 'r_ghost' })], []);
    await expect(
      service.dispatch(buildRequest(), { now: NOW, requestId: 'req_3' }),
    ).rejects.toThrow(NoRiderAvailableError);
  });

  it('refuses fleet dispatch for an order with no destination', async () => {
    const { service } = build([], []);
    await expect(
      service.dispatch(buildRequest({ dropoffLocation: undefined }), {
        now: NOW,
        requestId: 'req_4',
      }),
    ).rejects.toThrow(UnsupportedFulfilmentModeError);
  });

  it('frees the rider when the task is cancelled', async () => {
    const { service, registry, assignments, notifications } = build(
      [verifiedRider({ riderId: 'r_1' })],
      [{ riderId: 'r_1', location: CENTRAL, recordedAt: NOW }],
    );

    const assignment = await service.dispatch(buildRequest(), { now: NOW, requestId: 'req_5' });
    await service.cancel(assignment.taskId, '顧客取消');

    expect(registry.statusWrites.at(-1)).toEqual({
      riderId: 'r_1',
      status: DriverStatus.ONLINE_IDLE,
    });
    expect(notifications.cancelled).toEqual(['r_1']);
    expect(assignments.statusOf(assignment.taskId)).toBe(DeliveryTaskStatus.CANCELLED);
  });

  it('is idempotent when cancelling a task that is already gone', async () => {
    const { service } = build([], []);
    await expect(service.cancel('task_missing', 'noop')).resolves.toBeUndefined();
  });
});
