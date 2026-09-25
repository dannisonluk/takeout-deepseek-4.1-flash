import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/**
 * Row shape of the raw outbox read.
 *
 * Column names are camelCase because Prisma emits the model field name verbatim
 * for any field without an explicit `@map`. Hand-written SQL against this schema
 * must therefore quote multi-word identifiers: `"eventType"`, `"availableAt"`.
 */
interface OutboxRow {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: unknown;
  version: number;
  attempts: number;
}

/**
 * Outbox relay — turns committed `outbox_events` rows into Redis pub/sub
 * messages, which the WebSocket gateway fans out to rooms.
 *
 * Two properties that matter:
 *
 *  1. `FOR UPDATE SKIP LOCKED` lets several API instances run this loop
 *     concurrently without double-publishing or blocking each other.
 *  2. The publish + "mark published" happen in ONE transaction. If the process
 *     dies mid-batch, the rows stay PENDING and are retried — at-least-once
 *     delivery, which consumers handle via the event's `version`.
 *
 * When Redis is unreachable (local dev without a cache) the loop backs off
 * instead of hammering the log once per second; `outbox_events` simply
 * accumulates until a relay is available again.
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnApplicationShutdown {
  static readonly CHANNEL = 'takeout:order-events';

  private readonly logger = new Logger(OutboxRelayService.name);
  private timer?: NodeJS.Timeout;
  private draining = false;
  /** Consecutive failed passes — drives the backoff and the log throttle. */
  private failures = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.nodeEnv === 'test') return;
    this.scheduleNext(1_000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Returns the number of events published in this pass. */
  async drain(batchSize = 100): Promise<number> {
    if (this.draining) return 0;
    this.draining = true;

    try {
      const published = await this.prisma.runInTransaction(async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, "eventType", "aggregateId", payload, version, attempts
            FROM outbox_events
           WHERE status::text = 'PENDING'
             AND "availableAt" <= now()
           ORDER BY "createdAt" ASC
           LIMIT ${batchSize}
           FOR UPDATE SKIP LOCKED
        `;

        if (rows.length === 0) return 0;

        for (const row of rows) {
          const envelope = {
            eventId: row.id,
            type: row.eventType,
            aggregateId: row.aggregateId,
            version: row.version,
            payload: row.payload,
          };
          await this.redis.client.publish(OutboxRelayService.CHANNEL, JSON.stringify(envelope));
        }

        await tx.outboxEvent.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        });

        return rows.length;
      });

      this.failures = 0;
      return published;
    } catch (error) {
      this.failures += 1;
      // Log the first failure, then at most once per ~30 s so a missing Redis
      // does not drown the log during local development.
      if (this.failures === 1 || this.failures % 30 === 0) {
        this.logger.warn(
          `Outbox relay pass failed (${this.failures} consecutive): ${(error as Error).message}`,
        );
      }
      await this.recordFailure();
      return 0;
    } finally {
      this.draining = false;
      this.scheduleNext(this.nextDelayMs());
    }
  }

  /** Exponential backoff capped at 30 s, so a healthy relay returns to 1 s. */
  private nextDelayMs(): number {
    if (this.failures === 0) return 1_000;
    return Math.min(1_000 * 2 ** Math.min(this.failures, 5), 30_000);
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), delayMs);
    this.timer.unref?.();
  }

  /**
   * Bump attempt counts and back off. After 10 attempts the row is parked as
   * DEAD_LETTER so it stops starving the queue and shows up on a dashboard.
   */
  private async recordFailure(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE outbox_events
           SET attempts     = attempts + 1,
               "lastError"  = 'relay pass failed',
               "availableAt" = now() + (interval '1 second' * LEAST(power(2, attempts)::int, 300)),
               status       = CASE WHEN attempts + 1 >= 10
                                   THEN 'DEAD_LETTER'::"OutboxStatus"
                                   ELSE status END
         WHERE status::text = 'PENDING'
      `;
    } catch {
      // The relay write can fail for the same reason the publish did. Swallow
      // it — the outer loop already logged once.
    }
  }
}
