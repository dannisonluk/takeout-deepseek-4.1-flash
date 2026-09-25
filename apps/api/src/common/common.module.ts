import { Global, Module } from '@nestjs/common';
import {
  DiningSessionMachine,
  OrderStateMachine,
  RefundRequestStateMachine,
  ReservationStateMachine,
  UlidGenerator,
  WaitlistStateMachine,
} from '@takeout/domain';
import {
  DINING_STATE_MACHINE,
  ID_GENERATOR,
  ORDER_STATE_MACHINE,
  REFUND_STATE_MACHINE,
  RESERVATION_STATE_MACHINE,
  WAITLIST_STATE_MACHINE,
} from './tokens';

/**
 * Domain services that are stateless and shared by every feature module.
 *
 * Registering them once as globals keeps `OrderStateMachine` a singleton, so
 * `allowedTransitions()` computed in the merchant controller and the one used
 * inside `TransitionOrderUseCase` can never diverge. The reservation, refund,
 * waitlist and dining machines are global for exactly the same reason — an
 * `allowedNextTransitions` array in a response body and the guard that enforces
 * it must come from the same object, or a button can appear that the server
 * then refuses.
 */
@Global()
@Module({
  providers: [
    { provide: ID_GENERATOR, useClass: UlidGenerator },
    { provide: ORDER_STATE_MACHINE, useFactory: (): OrderStateMachine => new OrderStateMachine() },
    {
      provide: RESERVATION_STATE_MACHINE,
      useFactory: (): ReservationStateMachine => new ReservationStateMachine(),
    },
    {
      provide: REFUND_STATE_MACHINE,
      useFactory: (): RefundRequestStateMachine => new RefundRequestStateMachine(),
    },
    {
      provide: WAITLIST_STATE_MACHINE,
      useFactory: (): WaitlistStateMachine => new WaitlistStateMachine(),
    },
    {
      provide: DINING_STATE_MACHINE,
      useFactory: (): DiningSessionMachine => new DiningSessionMachine(),
    },
  ],
  exports: [
    ID_GENERATOR,
    ORDER_STATE_MACHINE,
    RESERVATION_STATE_MACHINE,
    REFUND_STATE_MACHINE,
    WAITLIST_STATE_MACHINE,
    DINING_STATE_MACHINE,
  ],
})
export class CommonModule {}
