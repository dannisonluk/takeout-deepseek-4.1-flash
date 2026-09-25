import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';

/**
 * Prisma client wired into the Nest lifecycle.
 *
 * Exposes `runInTransaction` so use cases never call `$transaction` directly —
 * the transactional boundary stays visible in the application layer and every
 * repository method takes an explicit `Prisma.TransactionClient`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      datasources: { db: { url: config.database.url } },
      log:
        config.nodeEnv === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [{ emit: 'stdout', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Prisma health check failed', error as Error);
      return false;
    }
  }

  /**
   * Run `work` inside a single transaction. All writes for one use case go
   * through here so the outbox row and the state change commit together.
   */
  runInTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10_000,
      maxWait: 5_000,
    });
  }
}
