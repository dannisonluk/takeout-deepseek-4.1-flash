import { Inject, Logger, Module } from '@nestjs/common';
import {
  FulfilmentMode,
  IDispatchService,
  IdGenerator,
  SelfPickupDispatchService,
} from '@takeout/domain';
import { DISPATCH_SERVICE, ID_GENERATOR } from '../../common/tokens';

/**
 * Picks a strategy per request once more than one mode exists.
 *
 * Today there is a single candidate and it is effectively a pass-through; the
 * shape is what matters, because phase 2 adds a second entry without changing
 * a single call site in the order module.
 */
export class DispatchServiceRouter {
  private readonly logger = new Logger(DispatchServiceRouter.name);

  constructor(@Inject(DISPATCH_SERVICE) private readonly strategies: IDispatchService) {}

  select(mode: FulfilmentMode): IDispatchService {
    if (this.strategies.mode === mode) return this.strategies;
    throw new Error(`No dispatch strategy registered for ${mode}`);
  }
}

/**
 * Fulfilment strategy selection.
 *
 * Phase 1 binds `IDispatchService` to `SelfPickupDispatchService`.
 *
 * Enabling fleet delivery in phase 2 is this factory returning
 * `new FleetDispatchService({...})` instead — the order module, the state
 * machine and the outbox schema are untouched, because they only ever talk to
 * the interface.
 */
@Module({
  providers: [
    {
      provide: DISPATCH_SERVICE,
      useFactory: (idGenerator: IdGenerator): IDispatchService =>
        new SelfPickupDispatchService(idGenerator),
      inject: [ID_GENERATOR],
    },
    DispatchServiceRouter,
  ],
  exports: [DISPATCH_SERVICE, DispatchServiceRouter],
})
export class DispatchModule {}
