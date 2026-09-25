import { Module } from '@nestjs/common';
import { WAITLIST_REPOSITORY } from '../../common/tokens';
import { SweepQueueUseCase } from './application/sweep-queue.use-case';
import { TakeNumberUseCase } from './application/take-number.use-case';
import { TransitionQueueUseCase } from './application/transition-queue.use-case';
import { WaitlistQueryService } from './application/waitlist-query.service';
import { WaitlistSettingsService } from './application/waitlist-settings.service';
import { PrismaWaitlistRepository } from './infrastructure/prisma-waitlist.repository';
import { CustomerWaitlistController } from './interface/customer-waitlist.controller';
import { MerchantWaitlistController } from './interface/merchant-waitlist.controller';

/**
 * 現場候位 bounded context — the walk-in queue.
 *
 * `WAITLIST_REPOSITORY` binds the port to the Prisma adapter, exactly as
 * `ORDER_REPOSITORY` and `RESERVATION_REPOSITORY` do — swapping to an in-memory
 * fake in a test module is a one-line change here and nothing in the
 * application layer moves.
 *
 * `WAITLIST_STATE_MACHINE` is NOT declared here: it comes from the global
 * `CommonModule`, so the moves the host board offers and the ones the write
 * path authorises are computed by the same singleton.
 *
 * No `imports` — the module needs only Prisma, the outbox, the audit log and
 * the config, all of which are `@Global()`. An empty `imports` array would be
 * noise; leaving it off is the honest statement that there is no dependency to
 * declare. In particular this module does NOT import `ReservationModule`: a
 * queue ticket holds no table, so there is no seat release to coordinate, and
 * the absence of that edge is the clearest statement of the design.
 */
@Module({
  controllers: [CustomerWaitlistController, MerchantWaitlistController],
  providers: [
    { provide: WAITLIST_REPOSITORY, useClass: PrismaWaitlistRepository },
    TakeNumberUseCase,
    TransitionQueueUseCase,
    SweepQueueUseCase,
    WaitlistQueryService,
    WaitlistSettingsService,
  ],
  exports: [
    WAITLIST_REPOSITORY,
    TakeNumberUseCase,
    TransitionQueueUseCase,
    SweepQueueUseCase,
    WaitlistQueryService,
    WaitlistSettingsService,
  ],
})
export class WaitlistModule {}
