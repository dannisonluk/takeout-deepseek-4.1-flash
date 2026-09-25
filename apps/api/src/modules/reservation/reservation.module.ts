import { Module } from '@nestjs/common';
import { RESERVATION_REPOSITORY } from '../../common/tokens';
import { PlaceReservationUseCase } from './application/place-reservation.use-case';
import { ReservationQueryService } from './application/reservation-query.service';
import { TransitionReservationUseCase } from './application/transition-reservation.use-case';
import { PrismaReservationRepository } from './infrastructure/prisma-reservation.repository';
import { CustomerReservationController } from './interface/customer-reservation.controller';
import { MerchantReservationController } from './interface/merchant-reservation.controller';

/**
 * 預約訂位 bounded context.
 *
 * `RESERVATION_REPOSITORY` binds the port to the Prisma adapter, exactly as
 * `ORDER_REPOSITORY` does — swapping to another store, or to an in-memory fake
 * in a test module, is a one-line change here and nothing in the application
 * layer moves.
 *
 * `RESERVATION_STATE_MACHINE` is NOT declared here: it comes from the global
 * `CommonModule`, so the transitions the board offers and the ones the write
 * path authorises are computed by the same singleton.
 *
 * No `imports` — the module needs only Prisma, the outbox and the config, all
 * of which are `@Global()`. An empty `imports` array would be noise; leaving it
 * off is the honest statement that there is no dependency to declare.
 */
@Module({
  controllers: [CustomerReservationController, MerchantReservationController],
  providers: [
    { provide: RESERVATION_REPOSITORY, useClass: PrismaReservationRepository },
    PlaceReservationUseCase,
    TransitionReservationUseCase,
    ReservationQueryService,
  ],
  exports: [RESERVATION_REPOSITORY, ReservationQueryService, TransitionReservationUseCase],
})
export class ReservationModule {}
