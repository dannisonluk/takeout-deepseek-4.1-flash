import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { CommonModule } from './common/common.module';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { AppConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { AuditModule } from './infrastructure/audit/audit.service';
import { OutboxModule } from './infrastructure/outbox/outbox.module';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { MediaModule } from './modules/media/media.module';
import { MerchantsModule } from './modules/merchants/merchants.module';
import { OrderingModule } from './modules/ordering/ordering.module';
import { PaymentModule } from './modules/payment/payment.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RefundModule } from './modules/refund/refund.module';
import { ReservationModule } from './modules/reservation/reservation.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { WaitlistModule } from './modules/waitlist/waitlist.module';
import { DiningModule } from './modules/dining/dining.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    // Infrastructure — global modules first so feature modules can inject them.
    AppConfigModule,
    PrismaModule,
    RedisModule,
    StorageModule,
    OutboxModule,
    AuditModule,
    CommonModule,
    MetricsModule,

    // Domain services + bounded contexts.
    AuthModule,
    PricingModule,
    DispatchModule,
    MerchantsModule,
    OrderingModule,
    PaymentModule,
    MediaModule,
    RealtimeModule,
    ReviewsModule,
    ReservationModule,
    RefundModule,
    WaitlistModule,
    DiningModule,

    // Admin portal last: it imports OrderingModule, PricingModule and
    // MerchantsModule, so registering it after them keeps the dependency
    // direction readable at a glance.
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    // Registered as APP_* providers so integration tests that build a partial
    // module graph still get the same error mapping and validation.
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        // Reject unknown properties instead of silently dropping them — a typo
        // in a client payload should be a 400, not a silent default.
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
  ],
})
export class AppModule {}
