import { IdGenerator } from '../shared/index';
import {
  DispatchAssignment,
  DispatchContext,
  DispatchRequest,
  FulfilmentMode,
  IDispatchService,
} from './dispatch.types';

/**
 * Phase 1 strategy: there is no rider.
 *
 * The "assignment" is just a counter ticket, and the ETA the customer sees is
 * the merchant's own prep estimate. Everything upstream — order module, event
 * outbox, WebSocket fan-out — is identical to the fleet path, which is what
 * makes the phase-2 swap a wiring change.
 */
export class SelfPickupDispatchService implements IDispatchService {
  readonly mode = FulfilmentMode.SELF_PICKUP;

  constructor(private readonly idGenerator: IdGenerator) {}

  supports(_request: DispatchRequest): boolean {
    return true;
  }

  async dispatch(request: DispatchRequest, context: DispatchContext): Promise<DispatchAssignment> {
    return Object.freeze({
      taskId: this.idGenerator.next(),
      orderId: request.orderId,
      mode: this.mode,
      etaMinutes: request.estimatedPrepMinutes,
      assignedAt: context.now,
    });
  }

  /** Nothing to release — kept so callers can stay strategy-agnostic. */
  async cancel(_taskId: string, _reason: string): Promise<void> {
    return;
  }
}
