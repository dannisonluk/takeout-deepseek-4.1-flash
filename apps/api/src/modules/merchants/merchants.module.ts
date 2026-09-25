import { Module } from '@nestjs/common';
import { ReservationModule } from '../reservation/reservation.module';
import { AnalyticsService } from './application/analytics.service';
import { DiscoveryService } from './application/discovery.service';
import { MenuService } from './application/menu.service';
import { MerchantClosureService } from './application/merchant-closure.service';
import { MerchantService } from './application/merchant.service';
import { PickupSlotService } from './application/pickup-slots.service';
import { DiscoveryController } from './interface/discovery.controller';
import { MenuController } from './interface/menu.controller';
import { MerchantAnalyticsController } from './interface/merchant-analytics.controller';
import { MerchantController } from './interface/merchant.controller';

/**
 * Merchant bounded context: the catalogue customers browse, the profile the
 * owner maintains, and the menu they edit.
 *
 * `AuditService` is injected without an import because `AuditModule` is
 * `@Global()`. `MerchantService` and `DiscoveryService` are exported so the
 * admin module can reuse the same projections instead of growing a second,
 * subtly different definition of what a merchant looks like.
 *
 * `ReservationModule` IS imported, and it is the one real edge in this graph:
 * a 特別休息日 has to cancel the bookings already in that day, and the cancel
 * has to go through `TransitionReservationUseCase`'s machinery — the state
 * machine, the repository port, the seat release. The alternative is a second
 * implementation of the release rule living in the merchant context, which is
 * exactly the drift the domain package exists to prevent. The dependency points
 * merchants -> reservation and never the other way, so there is no cycle.
 */
@Module({
  imports: [ReservationModule],
  controllers: [
    DiscoveryController,
    MerchantController,
    MenuController,
    MerchantAnalyticsController,
  ],
  providers: [
    DiscoveryService,
    MerchantService,
    MenuService,
    PickupSlotService,
    MerchantClosureService,
    AnalyticsService,
  ],
  exports: [
    DiscoveryService,
    MerchantService,
    MenuService,
    PickupSlotService,
    MerchantClosureService,
    AnalyticsService,
  ],
})
export class MerchantsModule {}
