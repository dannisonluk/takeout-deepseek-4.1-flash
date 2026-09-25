import { GeoPoint } from '../shared/index';

/**
 * How an order reaches the customer.
 *
 * Phase 1 ships `SELF_PICKUP` only, but the order pipeline already talks to an
 * `IDispatchService`, so enabling fleet delivery is a wiring change — not a
 * rewrite of the order module.
 */
export enum FulfilmentMode {
  SELF_PICKUP = 'SELF_PICKUP',
  PLATFORM_FLEET = 'PLATFORM_FLEET',
  MERCHANT_FLEET = 'MERCHANT_FLEET',
}

export enum DeliveryVehicle {
  MOTORCYCLE = 'MOTORCYCLE',
  BICYCLE = 'BICYCLE',
  ON_FOOT = 'ON_FOOT',
}

/** Typical door-to-door speed in km/h, used for ETA estimation. */
export const VEHICLE_SPEED_KMH: Readonly<Record<DeliveryVehicle, number>> = {
  [DeliveryVehicle.MOTORCYCLE]: 25,
  [DeliveryVehicle.BICYCLE]: 12,
  [DeliveryVehicle.ON_FOOT]: 4.5,
};

export type DispatchPriority = 'NORMAL' | 'EXPRESS';

export interface DispatchRequest {
  readonly orderId: string;
  readonly merchantId: string;
  readonly merchantLocation: GeoPoint;
  /** Absent for self-pickup. */
  readonly dropoffLocation?: GeoPoint;
  /** When the food is expected to leave the counter. */
  readonly readyAt: Date;
  readonly estimatedPrepMinutes: number;
  readonly itemCount: number;
  readonly priority: DispatchPriority;
}

export interface DispatchContext {
  readonly now: Date;
  /** Correlation id for tracing one dispatch attempt. */
  readonly requestId: string;
  /** Hard ceiling on travel distance; candidates beyond it are ineligible. */
  readonly maxRadiusKm?: number;
}

export interface DispatchAssignment {
  readonly taskId: string;
  readonly orderId: string;
  readonly mode: FulfilmentMode;
  /** Absent for self-pickup. */
  readonly riderId?: string;
  readonly etaMinutes: number;
  readonly assignedAt: Date;
  readonly estimatedDistanceKm?: number;
}

/**
 * Port implemented by every fulfilment strategy.
 *
 * Phase 2 replaces `SelfPickupDispatchService` with a fleet-backed
 * implementation of this same interface; nothing upstream changes.
 */
export interface IDispatchService {
  readonly mode: FulfilmentMode;
  /** Cheap pre-check so a router can pick a strategy without side effects. */
  supports(request: DispatchRequest): boolean;
  dispatch(request: DispatchRequest, context: DispatchContext): Promise<DispatchAssignment>;
  /** Best-effort release. Must not throw when the task is already gone. */
  cancel(taskId: string, reason: string): Promise<void>;
}
