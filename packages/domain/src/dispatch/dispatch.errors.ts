import { DomainError } from '../shared/index';
import { FulfilmentMode } from './dispatch.types';

export class NoRiderAvailableError extends DomainError {
  constructor(
    readonly orderId: string,
    readonly context: { candidatesConsidered: number; radiusKm: number },
  ) {
    super('NO_RIDER_AVAILABLE', 'No eligible rider could be assigned to this order', {
      orderId,
      ...context,
    });
  }
}

export class UnsupportedFulfilmentModeError extends DomainError {
  constructor(readonly mode: FulfilmentMode, readonly orderId: string) {
    super(
      'UNSUPPORTED_FULFILMENT_MODE',
      `Fulfilment mode ${mode} is not enabled for this order`,
      { mode, orderId },
    );
  }
}

export class NotImplementedFulfilmentError extends DomainError {
  constructor(readonly mode: FulfilmentMode) {
    super(
      'FULFILMENT_MODE_NOT_IMPLEMENTED',
      `${mode} is reserved for phase 2 and has no implementation yet`,
      { mode },
    );
  }
}
