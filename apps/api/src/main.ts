import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
import { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // `rawBody: true` keeps the untouched request bytes on `req.rawBody`, which
  // PSP webhook signature verification requires.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: ['log', 'warn', 'error', 'fatal'],
  });

  const config = app.get<AppConfig>(APP_CONFIG);

  // `metrics` is excluded for the same reason as `health`: a Prometheus scrape
  // target is addressed by an orchestrator, and `/v1/metrics` would make the
  // monitoring URL part of the versioned public API.
  app.setGlobalPrefix(config.apiPrefix, { exclude: ['health', 'health/ready', 'metrics'] });
  app.enableCors({ origin: config.corsOrigins, credentials: true });
  // Lets Prisma and the outbox relay close cleanly on SIGTERM.
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.log(`API listening on http://localhost:${config.port}/${config.apiPrefix}`);
  logger.log(`Pricing: HK$${(config.pricing.feePerMainItemMinor / 100).toFixed(2)} per main item`);
}

void bootstrap();
