import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { OrderActor, OrderStatus } from '@takeout/domain';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ConcurrentOrderModificationError } from '../domain/ordering.errors';
import { TransitionOrderUseCase } from './transition-order.use-case';

/** What one pass did. Surfaced in the log line and in the admin dashboard. */
export interface OrderSweepReport {
  readonly expiredUnpaid: number;
  readonly expiredUnaccepted: number;
  readonly expiredUncollected: number;
  /** Raced by another writer (or another instance) — not an error. */
  readonly skipped: number;
  /** Stale `menu_item_daily_stock` rows deleted. Normally 0 — see `pruneQuotaRows`. */
  readonly prunedQuotaRows: number;
}

const EMPTY_REPORT: OrderSweepReport = {
  expiredUnpaid: 0,
  expiredUnaccepted: 0,
  expiredUncollected: 0,
  skipped: 0,
  prunedQuotaRows: 0,
};

/**
 * The timeout sweeper — the thing that makes `acceptDeadlineAt` and
 * `paymentTimeoutMinutes` mean something.
 *
 * Without it, an order that nobody pays for, or that a merchant never accepts,
 * sits in its current status forever. The state machine already knew how to
 * expire it (`PENDING_PAYMENT -> EXPIRED`, `PAID -> EXPIRED`,
 * `READY_FOR_PICKUP -> EXPIRED`), and the columns were already being written —
 * there was simply nothing driving it. That is why the schema carries the
 * comment `Expiry sweeper: "unaccepted orders past their deadline"` on
 * `@@index([status, acceptDeadlineAt])`: the index was built for this loop.
 *
 * Three passes, each with a different clock:
 *
 *  1. `PENDING_PAYMENT` older than `ordering.paymentTimeoutMinutes`
 *     -> `EXPIRED`. Releases the soft-held daily quota.
 *  2. `PAID` past `acceptDeadlineAt` -> `EXPIRED`. Refunds and releases quota.
 *  3. `READY_FOR_PICKUP` past `readyAt + merchant.pickupWindowMinutes`
 *     -> `EXPIRED`. The customer did not collect; the merchant *is* still paid
 *     (the food was cooked), so this pass deliberately does NOT release quota.
 *
 * Three properties that matter:
 *
 *  - **Every expiry goes through `TransitionOrderUseCase`**, never a bare
 *    `UPDATE`. That is the only way the declared side effects — quota release,
 *    refund, payout ledger, outbox event — actually happen. A sweeper that
 *    wrote the status itself would silently skip all of them.
 *  - **No locks are held across the transition.** Candidates are selected with
 *    a plain read, then each is transitioned in its own transaction. The
 *    transition's optimistic `UPDATE ... WHERE status = expected` is what makes
 *    a race safe: the loser gets `ConcurrentOrderModificationError`, which this
 *    loop treats as "someone else got there first", not as a failure. Holding
 *    `FOR UPDATE` across the inner transaction would deadlock against it.
 *  - **A failure on one order must not stop the pass.** Each candidate is
 *    isolated; a bad row cannot starve the rest of the queue.
 */
@Injectable()
export class OrderTimeoutSweeperService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OrderTimeoutSweeperService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Throttles the quota prune — it is a table-wide DELETE, not a cheap read. */
  private lastPrunedAt: number | null = null;

  /** Bound the work per pass so a backlog cannot hold a transaction open for minutes. */
  private static readonly BATCH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly transitionOrder: TransitionOrderUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // Never in tests: the suite drives `sweep()` directly so it can assert on
    // the result, and a background loop would race the fixtures. `backgroundJobs`
    // lets the e2e run do the same without pretending to be `NODE_ENV=test`.
    if (this.config.nodeEnv === 'test' || !this.config.ordering.backgroundJobs) return;
    // A short first delay keeps boot fast while still self-healing quickly.
    this.scheduleNext(5_000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** One pass over all three timeouts. Safe to call concurrently — the second caller no-ops. */
  async sweep(): Promise<OrderSweepReport> {
    if (this.running) return EMPTY_REPORT;
    this.running = true;

    try {
      const expiredUnpaid = await this.expireUnpaid();
      const expiredUnaccepted = await this.expireUnaccepted();
      const expiredUncollected = await this.expireUncollected();

      const prunedQuotaRows = await this.pruneQuotaRows();

      const report: OrderSweepReport = {
        expiredUnpaid: expiredUnpaid.expired,
        expiredUnaccepted: expiredUnaccepted.expired,
        expiredUncollected: expiredUncollected.expired,
        skipped: expiredUnpaid.skipped + expiredUnaccepted.skipped + expiredUncollected.skipped,
        prunedQuotaRows,
      };

      const total = report.expiredUnpaid + report.expiredUnaccepted + report.expiredUncollected;
      if (total > 0 || report.skipped > 0 || prunedQuotaRows > 0) {
        this.logger.log(
          `sweep: ${report.expiredUnpaid} unpaid, ${report.expiredUnaccepted} unaccepted, ` +
            `${report.expiredUncollected} uncollected, ${report.skipped} skipped, ` +
            `${prunedQuotaRows} stale quota rows pruned`,
        );
      }
      return report;
    } catch (error) {
      // A failing pass is not fatal — the next one retries. Log it loudly
      // enough to be noticed but do not let it kill the loop.
      this.logger.error(`sweep pass failed: ${(error as Error).message}`);
      return EMPTY_REPORT;
    } finally {
      this.running = false;
      this.scheduleNext(this.intervalMs());
    }
  }

  // ---- passes ---------------------------------------------------------------

  /** `PENDING_PAYMENT` older than the payment timeout. */
  private async expireUnpaid(): Promise<{ expired: number; skipped: number }> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM orders
       WHERE status::text = 'PENDING_PAYMENT'
         AND "createdAt" < now() - (${this.config.ordering.paymentTimeoutMinutes} * interval '1 minute')
       ORDER BY "createdAt" ASC
       LIMIT ${OrderTimeoutSweeperService.BATCH}
    `;

    return this.expireAll(rows, OrderStatus.EXPIRED, 'payment window elapsed');
  }

  /** `PAID` but the merchant never accepted before `acceptDeadlineAt`. */
  private async expireUnaccepted(): Promise<{ expired: number; skipped: number }> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM orders
       WHERE status::text = 'PAID'
         AND "acceptDeadlineAt" IS NOT NULL
         AND "acceptDeadlineAt" < now()
       ORDER BY "acceptDeadlineAt" ASC
       LIMIT ${OrderTimeoutSweeperService.BATCH}
    `;

    return this.expireAll(rows, OrderStatus.EXPIRED, 'merchant accept deadline elapsed');
  }

  /**
   * `READY_FOR_PICKUP` and the customer never came.
   *
   * The window is per-merchant (`merchants.pickupWindowMinutes`), falling back
   * to the config default when the column is somehow absent — a merchant with a
   * 15-minute window must not be held to the platform's 60.
   */
  private async expireUncollected(): Promise<{ expired: number; skipped: number }> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT o.id
        FROM orders o
        JOIN merchants m ON m.id = o."merchantId"
       WHERE o.status::text = 'READY_FOR_PICKUP'
         AND o."readyAt" IS NOT NULL
         AND o."readyAt"
             + (COALESCE(m."pickupWindowMinutes", ${this.config.ordering.pickupWindowMinutes})
                * interval '1 minute') < now()
       ORDER BY o."readyAt" ASC
       LIMIT ${OrderTimeoutSweeperService.BATCH}
    `;

    return this.expireAll(rows, OrderStatus.EXPIRED, 'pickup window elapsed (no-show)');
  }

  /**
   * Transition every candidate as `SYSTEM`.
   *
   * `reason` is stored on the status event and in the outbox payload, so the
   * customer timeline and the admin console can both say *why* an order expired
   * rather than showing a bare status change.
   */
  private async expireAll(
    rows: readonly { id: string }[],
    to: OrderStatus,
    reason: string,
  ): Promise<{ expired: number; skipped: number }> {
    let expired = 0;
    let skipped = 0;

    for (const row of rows) {
      try {
        await this.transitionOrder.execute({
          orderId: row.id,
          to,
          actor: OrderActor.SYSTEM,
          reason,
        });
        expired += 1;
      } catch (error) {
        if (error instanceof ConcurrentOrderModificationError) {
          // Another writer (or another API instance's sweeper) moved it first.
          skipped += 1;
          continue;
        }
        // An order in an unexpected state, a guard refusal, a transient DB
        // error — log and move on. One bad row must not starve the batch.
        skipped += 1;
        this.logger.warn(`sweep: order ${row.id} -> ${to} failed: ${(error as Error).message}`);
      }
    }

    return { expired, skipped };
  }

  // ---- retention ------------------------------------------------------------

  /**
   * Delete `menu_item_daily_stock` rows that nothing can read any more.
   *
   * The table gains one row per item per service day and has no natural end: a
   * merchant with 50 dishes adds 50 rows a day, forever, to a table every order
   * reads on its way in. Rows past the retention window are dead weight —
   * availability is only ever computed for the *current* service day, and the
   * payout and reconciliation views read `orders`, not this table.
   *
   * Gated to run at most hourly. The sweep interval is 30 s and this is a
   * table-wide `DELETE`, so running it on every pass would be pure waste.
   */
  private async pruneQuotaRows(): Promise<number> {
    const now = Date.now();
    if (this.lastPrunedAt !== null && now - this.lastPrunedAt < 3_600_000) return 0;

    const deleted = await this.prisma.$executeRaw`
      DELETE FROM menu_item_daily_stock
       WHERE "serviceDate"
             < CURRENT_DATE - (${this.config.ordering.quotaRetentionDays} * interval '1 day')
    `;
    this.lastPrunedAt = now;
    return deleted;
  }

  // ---- scheduling -----------------------------------------------------------

  private intervalMs(): number {
    return this.config.ordering.sweepIntervalMs;
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sweep(), delayMs);
    // Do not hold the event loop open — the API must be able to exit cleanly.
    this.timer.unref?.();
  }
}
