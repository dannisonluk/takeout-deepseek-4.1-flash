import { Module } from '@nestjs/common';
import { MerchantsModule } from '../merchants/merchants.module';
import { OrderingModule } from '../ordering/ordering.module';
import { PaymentModule } from '../payment/payment.module';
import { PricingModule } from '../pricing/pricing.module';
import { AdminConfigService } from './application/admin-config.service';
import { AdminDashboardService } from './application/admin-dashboard.service';
import { AdminFinanceService } from './application/admin-finance.service';
import { AdminMerchantsService } from './application/admin-merchants.service';
import { AdminOpsService } from './application/admin-ops.service';
import { AdminOrdersService } from './application/admin-orders.service';
import { AdminUsersService } from './application/admin-users.service';
import { AdminConfigController } from './interface/admin-config.controller';
import { AdminFinanceController } from './interface/admin-finance.controller';
import { AdminMerchantsController } from './interface/admin-merchants.controller';
import { AdminOrdersController } from './interface/admin-orders.controller';
import { AdminUsersController } from './interface/admin-users.controller';
import { AdminController } from './interface/admin.controller';

/**
 * The admin portal's bounded context.
 *
 * Imports the three modules whose services it drives rather than reaching into
 * their tables directly for anything that has rules attached:
 *
 *   * `OrderingModule` supplies `TransitionOrderUseCase`, so an admin status
 *     change goes through the same state machine, outbox and audit path as every
 *     other status change. An admin-only write path would be a second
 *     implementation of the lifecycle, and the two would drift.
 *   * `PricingModule` supplies `PricingConfigService`, so a fee change reloads
 *     the live engine instead of waiting for a restart.
 *   * `MerchantsModule` is imported for its projections, which the merchant
 *     views extend.
 *   * `PaymentModule` supplies `PaymentProviderRegistry`, which the refund flow
 *     uses to send money back through the rail that actually took it.
 *     `AdminOrdersService` injects `RefundService` from the same module, so the
 *     import is required even though the refund is the only thing that needs
 *     it — a missing import is a boot failure that `nest build` cannot detect.
 *
 * `AuditService`, `PrismaService`, `RedisService` and the domain tokens are
 * global, so they are injected without an import here.
 */
@Module({
  imports: [OrderingModule, PricingModule, MerchantsModule, PaymentModule],
  controllers: [
    AdminController,
    AdminUsersController,
    AdminMerchantsController,
    AdminOrdersController,
    AdminConfigController,
    AdminFinanceController,
  ],
  providers: [
    AdminDashboardService,
    AdminUsersService,
    AdminMerchantsService,
    AdminOrdersService,
    AdminConfigService,
    AdminFinanceService,
    AdminOpsService,
  ],
})
export class AdminModule {}
