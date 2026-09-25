import { Module } from '@nestjs/common';
import { DINING_REPOSITORY } from '../../common/tokens';
import { OrderingModule } from '../ordering/ordering.module';
import { DiningQueryService } from './application/dining-query.service';
import { ManageTablesUseCase } from './application/manage-tables.use-case';
import { OpenCloseSessionUseCase } from './application/open-close-session.use-case';
import { ScanAndOrderUseCase } from './application/scan-and-order.use-case';
import { PrismaDiningRepository } from './infrastructure/prisma-dining.repository';
import { CustomerDiningController } from './interface/customer-dining.controller';
import { MerchantDiningController } from './interface/merchant-dining.controller';

/**
 * 店內點餐 bounded context — the floor plan, the sittings, and scan-to-order.
 *
 * `DINING_REPOSITORY` binds the port to the Prisma adapter, exactly as the
 * order, reservation, refund and waitlist ports do — swapping to an in-memory
 * fake in a test module is a one-line change here and nothing in the
 * application layer moves.
 *
 * `DINING_STATE_MACHINE` is NOT declared here: it comes from the global
 * `CommonModule`, so the moves the board offers and the ones the write path
 * authorises are computed by the same singleton.
 *
 * ## The one real dependency edge: `OrderingModule`
 *
 * This module imports `OrderingModule` because scan-to-order goes through
 * `PlaceOrderUseCase` — deliberately, and that is the whole design. An in-store
 * order is an ordinary order: same pricing engine, same kitchen board, same
 * lifecycle, same payout ledger. The alternative — a second order-creation path
 * living in this module — would have to re-implement every one of those, and the
 * first one to drift would be the money.
 *
 * The dependency points dining -> ordering and never the other way, so there is
 * no cycle. `OrderingModule` gains nothing from the dining context; it does not
 * know a `diningSessionId` is anything but an optional column.
 *
 * Notably this module does NOT import `MerchantsModule` despite reading the
 * merchant's timezone and hours: those are plain columns on `merchant`, and the
 * reads go through Prisma directly exactly as `WaitlistQueryService` does. Only
 * the projects that need a merchant's *projection* — analytics, the owner view —
 * pay for that module.
 */
@Module({
  imports: [OrderingModule],
  controllers: [CustomerDiningController, MerchantDiningController],
  providers: [
    { provide: DINING_REPOSITORY, useClass: PrismaDiningRepository },
    ManageTablesUseCase,
    OpenCloseSessionUseCase,
    ScanAndOrderUseCase,
    DiningQueryService,
  ],
  exports: [
    DINING_REPOSITORY,
    ManageTablesUseCase,
    OpenCloseSessionUseCase,
    ScanAndOrderUseCase,
    DiningQueryService,
  ],
})
export class DiningModule {}
