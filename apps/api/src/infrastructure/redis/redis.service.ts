import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';

/** How long to stay quiet after one connection complaint, per client role. */
const ERROR_LOG_THROTTLE_MS = 30_000;

/**
 * Redis connections, split by concern.
 *
 * A subscriber connection cannot issue normal commands, so it is kept separate
 * from the command client. `geospatial` is the phase-2 rider-location client —
 * created lazily so phase 1 never opens a connection it does not need.
 *
 * Redis is treated as an OPTIONAL dependency. Every client is built with
 * `enableOfflineQueue: false`, so a command issued while the connection is down
 * **rejects immediately** instead of parking in ioredis's offline queue. That
 * distinction matters more than it looks: with the default queue enabled, a
 * command against an unreachable Redis returns a promise that never settles,
 * which silently hangs any caller that awaits it.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;
  private subscriber?: Redis;
  private geo?: Redis;
  /** Last time each role logged a connection complaint. */
  private readonly lastErrorAt = new Map<string, number>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = this.create('command', { maxRetriesPerRequest: 3 });
  }

  get subscriberClient(): Redis {
    // `maxRetriesPerRequest` MUST be null for a subscriber (ioredis refuses to
    // build a subscriber otherwise), which is exactly why the offline queue has
    // to be disabled here: null means "retry forever", so without that flag a
    // SUBSCRIBE against a dead Redis would never reject and never resolve.
    this.subscriber ??= this.create('subscriber', { maxRetriesPerRequest: null });
    return this.subscriber;
  }

  /** Phase 2 — rider positions live in a separate logical client. */
  get geoClient(): Redis {
    this.geo ??= this.create('geo', { maxRetriesPerRequest: 3 });
    return this.geo;
  }

  async isHealthy(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Synchronous connection state, from ioredis's own status field.
   *
   * For the admin dashboard, where awaiting a PING to render a status dot is
   * both slower and a worse answer — a slow PING would show "down" for a Redis
   * that is merely busy.
   */
  get isConnected(): boolean {
    return this.client.status === 'ready';
  }

  /**
   * `SET key value NX PX ttl` — returns true when this caller won the lock.
   * Used for idempotency keys and the daily-quota guard.
   *
   * Rejects when Redis is unreachable rather than hanging. That is deliberate
   * and fail-closed: a caller that asked for idempotency protection must not be
   * told it has protection it does not have.
   */
  async acquire(key: string, ttlMs: number, value = '1'): Promise<boolean> {
    const result = await this.client.set(key, value, 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * `acquire`, but it tells the caller *why* it could not take the lock.
   *
   *   `true`  — this caller won the lock
   *   `false` — somebody else holds it, so this is a genuine replay
   *   `null`  — Redis could not answer
   *
   * The distinction matters whenever the lock is an optimisation in front of a
   * durable constraint. `acquire`'s fail-closed contract is right for a lock
   * that IS the protection (the daily-quota guard); it is wrong for one that
   * merely short-circuits a race the database would refuse anyway, because
   * there `false` and `null` need opposite responses: refuse the request, or
   * let the database decide. Collapsing them makes a Redis outage into an
   * outage of the feature.
   */
  async tryAcquire(key: string, ttlMs: number, value = '1'): Promise<boolean | null> {
    try {
      return (await this.client.set(key, value, 'PX', ttlMs, 'NX')) === 'OK';
    } catch {
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.client.quit(), this.subscriber?.quit(), this.geo?.quit()]);
  }

  private create(role: string, options: RedisOptions): Redis {
    const client = new Redis(this.config.redis.url, {
      ...options,
      // See the class doc — never park commands in an offline queue.
      enableOfflineQueue: false,
      // Default backoff is `times * 50` capped at 2 s, which retries ~30x/min
      // forever against a Redis that is not coming back.
      retryStrategy: (times: number) => Math.min(times * 250, 5_000),
      // Without a listener ioredis prints "Unhandled error event" straight to
      // stderr on every reconnect attempt. Every client needs one.
    });
    client.on('error', (error: Error) => this.logConnectionError(role, error));
    return client;
  }

  /**
   * One line per role per 30 s. An unreachable Redis otherwise produces several
   * log lines per second and buries the boot output.
   */
  private logConnectionError(role: string, error: Error): void {
    const now = Date.now();
    if (now - (this.lastErrorAt.get(role) ?? 0) < ERROR_LOG_THROTTLE_MS) return;
    this.lastErrorAt.set(role, now);
    this.logger.warn(
      `Redis ${role} client unavailable (${error.message}). Retrying in the background — ` +
        `every route that does not need Redis keeps serving.`,
    );
  }
}
