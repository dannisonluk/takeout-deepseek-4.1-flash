import { GeoPoint } from '../shared/index';
import { DeliveryVehicle, FulfilmentMode } from '../dispatch/dispatch.types';

/**
 * Phase 2 — Fleet Management ports.
 *
 * These are *interfaces only*. They live in the domain because the dispatch
 * engine depends on the abstraction, not on Redis or PostGIS. The
 * infrastructure layer supplies the concrete adapters (`RedisDriverLocationRepository`,
 * `PrismaDriverRegistry`) when fleet delivery is switched on.
 */

export enum DriverStatus {
  OFFLINE = 'OFFLINE',
  /** Online and has capacity. */
  ONLINE_IDLE = 'ONLINE_IDLE',
  /** Online but at max concurrent tasks. */
  ON_DELIVERY = 'ON_DELIVERY',
  /** Blocked by operations — failed verification, incident, unpaid deposit. */
  SUSPENDED = 'SUSPENDED',
}

export enum IdentityVerificationStatus {
  UNVERIFIED = 'UNVERIFIED',
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export interface DriverProfile {
  readonly riderId: string;
  readonly displayName: string;
  readonly phone: string;
  readonly vehicle: DeliveryVehicle;
  readonly status: DriverStatus;
  readonly verification: IdentityVerificationStatus;
  /** How many orders this rider may carry at once. */
  readonly maxConcurrentTasks: number;
  /** Rolling acceptance rate in [0, 1]. */
  readonly acceptanceRate: number;
  /** Merchants this rider is allowed to serve; `null` means all. */
  readonly allowedMerchantIds: readonly string[] | null;
  readonly onlineSince: Date | null;
}

export interface DriverLocationSnapshot {
  readonly riderId: string;
  readonly location: GeoPoint;
  readonly recordedAt: Date;
  readonly headingDegrees?: number;
  readonly speedKmh?: number;
  readonly accuracyMeters?: number;
}

export enum DeliveryTaskStatus {
  OFFERED = 'OFFERED',
  ASSIGNED = 'ASSIGNED',
  PICKED_UP = 'PICKED_UP',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}

export interface DeliveryTaskSnapshot {
  readonly taskId: string;
  readonly orderId: string;
  readonly merchantId: string;
  readonly riderId: string | null;
  readonly mode: FulfilmentMode;
  readonly status: DeliveryTaskStatus;
  readonly assignedAt: Date | null;
  readonly etaMinutes: number;
}

/** Rider roster and availability. Backed by Postgres. */
export interface IDriverRegistry {
  findById(riderId: string): Promise<DriverProfile | null>;
  /** Riders currently eligible to serve this merchant. */
  findEligible(merchantId: string): Promise<readonly DriverProfile[]>;
  setStatus(riderId: string, status: DriverStatus): Promise<void>;
  markOnline(riderId: string, at: Date): Promise<void>;
}

/**
 * Live rider positions. Backed by Redis (GEOADD / GEOSEARCH), with a capped
 * per-rider trail stream for the tracking view.
 */
export interface IDriverLocationRepository {
  upsert(snapshot: DriverLocationSnapshot): Promise<void>;
  /** `GEOSEARCH FROMMEMBER <member> BYRADIUS <km> km ASC COUNT <limit>` */
  findWithinRadius(
    center: GeoPoint,
    radiusKm: number,
    limit?: number,
  ): Promise<readonly DriverLocationSnapshot[]>;
  getTrail(riderId: string, since: Date): Promise<readonly DriverLocationSnapshot[]>;
  remove(riderId: string): Promise<void>;
}

export interface IDriverAssignmentRepository {
  create(task: DeliveryTaskSnapshot): Promise<void>;
  findById(taskId: string): Promise<DeliveryTaskSnapshot | null>;
  countActiveByRider(riderId: string): Promise<number>;
  updateStatus(taskId: string, status: DeliveryTaskStatus): Promise<void>;
  reassign(taskId: string, riderId: string | null): Promise<void>;
}

/**
 * Push channel for job assignment (FCM / APNs).
 *
 * Auto-assignment only. A future "offer -> accept/decline" flow adds
 * `offerJob` / `respondToOffer` here without touching the dispatcher.
 */
export interface IRiderNotificationPort {
  notifyAssignment(riderId: string, task: DeliveryTaskSnapshot): Promise<void>;
  notifyCancellation(riderId: string, taskId: string, reason: string): Promise<void>;
}

/**
 * Phase 2 — Geo & Real-time Tracking.
 *
 * A single place the WebSocket gateway asks "who should receive this rider's
 * position". Keeps the socket layer ignorant of Redis Streams.
 */
export interface ITrackingBroadcaster {
  publishRiderPosition(snapshot: DriverLocationSnapshot): Promise<void>;
  subscribeOrderTracking(
    orderId: string,
    handler: (snapshot: DriverLocationSnapshot) => void,
  ): Promise<() => Promise<void>>;
}
