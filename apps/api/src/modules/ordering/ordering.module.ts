import { Module } from '@nestjs/common';
import { ORDER_REPOSITORY } from '../../common/tokens';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PricingModule } from '../pricing/pricing.module';
import { OrderQueryService } from './application/order-query.service';
import { OrderTimeoutSweeperService } from './application/order-timeout-sweeper.service';
import { PlaceOrderUseCase } from './application/place-order.use-case';
import { TransitionOrderUseCase } from './application/transition-order.use-case';
import { PrismaOrderRepository } from './infrastructure/prisma-order.repository';
import { CustomerOrderController } from './interface/customer-order.controller';
import { MerchantOrderController } from './interface/merchant-order.controller';

/**
 * Ordering bounded context.
 *
 * `ORDER_REPOSITORY` binds the port to the Prisma adapter. Swapping to another
 * store — or an in-memory fake in a test module — is a one-line change here and
 * nothing else in the application layer moves.
 */
@Module({
  imports: [PricingModule, DispatchModule],
  controllers: [CustomerOrderController, MerchantOrderController],
  providers: [
    { provide: ORDER_REPOSITORY, useClass: PrismaOrderRepository },
    PlaceOrderUseCase,
    TransitionOrderUseCase,
    OrderQueryService,
    OrderTimeoutSweeperService,
  ],
  // The sweeper is exported so the admin console can run a pass on demand —
  // "why is this order still sitting there" should be answerable without
  // waiting up to a sweep interval.
  //
  // `PlaceOrderUseCase` is exported for the dining context's scan-to-order
  // flow: an in-store round must go through THIS ordering path, not a second
  // one, or the pricing and the kitchen board would have two definitions.
  exports: [
    ORDER_REPOSITORY,
    PlaceOrderUseCase,
    OrderQueryService,
    TransitionOrderUseCase,
    OrderTimeoutSweeperService,
  ],
})
export class OrderingModule {}
