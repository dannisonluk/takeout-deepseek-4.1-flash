import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Observability.
 *
 * `@Global()` because any module that wants to count something it did should
 * not have to add an import just to do it — and a counter nobody increments
 * because wiring it up was inconvenient is worse than no counter at all.
 *
 * The service is exported, the controller is not: `/metrics` is served from
 * exactly one place, and no other module should be able to register a second
 * scrape endpoint by accident.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
