import { Module } from '@nestjs/common';
import { REFUND_REPOSITORY } from '../../common/tokens';
import { FileRefundRequestUseCase } from './application/file-refund-request.use-case';
import { RefundQueryService } from './application/refund-query.service';
import { TransitionRefundRequestUseCase } from './application/transition-refund-request.use-case';
import { PrismaRefundRepository } from './infrastructure/prisma-refund.repository';
import { AdminRefundController } from './interface/admin-refund.controller';
import { CustomerRefundController } from './interface/customer-refund.controller';
import { MerchantRefundController } from './interface/merchant-refund.controller';

/**
 * 退款申請工單 bounded context.
 *
 * `REFUND_REPOSITORY` binds the port to the Prisma adapter, exactly as
 * `ORDER_REPOSITORY` and `RESERVATION_REPOSITORY` do — and the adapter is the
 * enforcement point for the one rule that defines this feature: it has no
 * access to `payments`, `payouts` or any provider. There is no money-path
 * dependency in this module, and there must never be one.
 *
 * `REFUND_STATE_MACHINE` is NOT declared here: it comes from the global
 * `CommonModule`, so the moves the queue offers and the ones the write path
 * authorises are computed by the same singleton.
 *
 * No `imports` — the module needs only Prisma, the outbox and the config, all
 * of which are `@Global()`. `MerchantScopeGuard` and `RolesGuard` are applied in
 * the controllers rather than imported as providers.
 */
@Module({
  controllers: [CustomerRefundController, MerchantRefundController, AdminRefundController],
  providers: [
    { provide: REFUND_REPOSITORY, useClass: PrismaRefundRepository },
    FileRefundRequestUseCase,
    TransitionRefundRequestUseCase,
    RefundQueryService,
  ],
  exports: [REFUND_REPOSITORY, RefundQueryService, TransitionRefundRequestUseCase],
})
export class RefundModule {}
