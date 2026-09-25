import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { OrderActor, OrderStatus } from '@takeout/domain';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RefundService } from './refund.service';

export interface RefundSweepReport {
  readonly considered: number;
  readonly refunded: number;
  /** Provider said FAILED — an operator has to pick it up. */
  readonly failed: number;
  /** Recorded but not settled, because `PAYMENT_LIVE_MODE=false`. */
  readonly deferred: number;
}

const EMPTY: RefundSweepReport = { considered: 0, refunded: 0, failed: 0, deferred: 0 };

interface CandidateRow {
  id: string;
  status: string;
  refundDueMinor: number | null;
}

/**
 * Discharges the `ISSUE_REFUND` side effect the order state machine declares.
 *
 * `OrderStateMachine` has always listed `ISSUE_REFUND` on `-> REJECTED`,
 * `-> CANCELLED` and `PAID -> EXPIRED`. Until this service existed nothing
 * implemented it: `TransitionOrderUseCase` handled `RELEASE_DAILY_QUOTA` and
 * `RECORD_PAYOUT_LEDGER` and quietly ignored the rest, so a merchant rejecting
 * a paid order left the customer's money captured with nothing to release it.
 * That is the failure mode the domain layer's own comment warns about — a
 * declared side effect with no implementation is a silent data gap, not a
 * compile error.
 *
 * Why a reconciliation loop rather than an inline call in the transition:
 *
 *  - The refund belongs to the **payment** context, and `OrderingModule` cannot
 *    depend on it without closing a cycle (`PaymentModule` already imports
 *    `OrderingModule`).
 *  - A PSP outage must not block a status transition. The order reaches its
 *    final status immediately; the money follows within one sweep interval.
 *  - A loop is self-healing: a refund that failed at 03:00 is retried at 03:01
 *    without anyone replaying an event.
 *
 * **Which closings refund, and how much.** The amount is not decided here — the
 * transition already asked `CancellationPolicyEngine` and stored the answer as
 * `orders.refundDueMinor`. What this loop adds is the *execution*:
 *
 *  - `REJECTED` and `CANCELLED` — the merchant's fault, so the policy returns
 *    100% and the full capture goes back.
 *  - `EXPIRED` after `READY_FOR_PICKUP` — a **no-show**. The food was cooked and
 *    the merchant is still paid; the policy returns 0 and the order is not a
 *    candidate at all.
 *  - `ACCEPTED -> CANCELLED` past the grace window — the policy returns 0 for
 *    the same reason: the merchant had already committed.
 *
 * Candidates already carrying a `PENDING` or `SUCCEEDED` refund are skipped, so
 * the loop cannot double-refund — including refunds an admin issued by hand.
 * Three consecutive `FAILED` attempts park the order for a human instead of
 * retrying a permanently broken provider reference forever.
 */
@Injectable()
export class OrderRefundReactorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OrderRefundReactorService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  private static readonly BATCH = 25;
  /** Stop retrying after this many provider failures — it needs a human. */
  private static readonly MAX_FAILED_ATTEMPTS = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.nodeEnv === 'test' || !this.config.ordering.backgroundJobs) return;
    // Offset from the order sweeper's 5 s start so the two do not wake together.
    this.scheduleNext(8_000);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async sweep(): Promise<RefundSweepReport> {
    if (this.running) return EMPTY;
    this.running = true;

    try {
      const candidates = await this.findCandidates();
      if (candidates.length === 0) return EMPTY;

      let refunded = 0;
      let failed = 0;
      let deferred = 0;

      for (const candidate of candidates) {
        try {
          const attempt = await this.refunds.issue({
            orderId: candidate.id,
            // `null` means "the policy never ran", in which case `issue` refunds
            // everything still refundable. An explicit `0` was filtered out by
            // the candidate query.
            amountMinor: candidate.refundDueMinor ?? undefined,
            reason: `order ${candidate.status.toLowerCase()} — automatic refund`,
            // `null` on purpose: no human asked for this one.
            requestedBy: null,
            actor: OrderActor.SYSTEM,
          });

          if (attempt.kind !== 'ISSUED') continue;
          if (attempt.providerStatus === 'SUCCEEDED') refunded += 1;
          else if (attempt.providerStatus === 'FAILED') failed += 1;
          else deferred += 1;
        } catch (error) {
          // One bad order must not starve the batch.
          failed += 1;
          this.logger.warn(`refund for order ${candidate.id} threw: ${(error as Error).message}`);
        }
      }

      const report: RefundSweepReport = {
        considered: candidates.length,
        refunded,
        failed,
        deferred,
      };
      this.logger.log(
        `refund sweep: ${report.considered} considered, ${report.refunded} settled, ` +
          `${report.failed} failed, ${report.deferred} awaiting manual settlement`,
      );
      return report;
    } catch (error) {
      this.logger.error(`refund sweep pass failed: ${(error as Error).message}`);
      return EMPTY;
    } finally {
      this.running = false;
      this.scheduleNext(this.config.ordering.sweepIntervalMs);
    }
  }

  /**
   * Closed orders that hold captured money and have no live refund.
   *
   * **How much to refund is not decided here.** `TransitionOrderUseCase` already
   * asked `CancellationPolicyEngine` and stamped the answer on the order as
   * `refundDueMinor`; this loop only carries it out. That split is what keeps a
   * retuned refund percentage from being applied to an order that closed under
   * the old one — the number was frozen with the status, in the same `UPDATE`.
   *
   * The `WHERE` clause therefore reads:
   *
   *  - an explicit decision of `> 0` — refund that amount;
   *  - no decision at all (`NULL`, i.e. a row predating the column) — fall back
   *    to the old `readyAt` heuristic, so a legacy no-show is still not refunded;
   *  - an explicit `0` — the policy decided the customer gets nothing. Skipped.
   */
  private async findCandidates(): Promise<CandidateRow[]> {
    return this.prisma.$queryRaw<CandidateRow[]>`
      SELECT o.id, o.status::text AS status, o."refundDueMinor"
        FROM orders o
       WHERE o.status::text IN ('REJECTED', 'CANCELLED', 'EXPIRED')
         AND (
               o."refundDueMinor" > 0
               OR (
                 o."refundDueMinor" IS NULL
                 AND NOT (o.status::text = 'EXPIRED' AND o."readyAt" IS NOT NULL)
               )
             )
         AND EXISTS (
               SELECT 1
                 FROM payments p
                WHERE p."orderId" = o.id
                  AND p.status::text IN ('CAPTURED', 'PARTIALLY_REFUNDED')
                  AND p."providerRef" IS NOT NULL
             )
         AND NOT EXISTS (
               SELECT 1
                 FROM payments p
                 JOIN refunds r ON r."paymentId" = p.id
                WHERE p."orderId" = o.id
                  AND r.status::text IN ('PENDING', 'SUCCEEDED')
             )
         AND (
               SELECT count(*)
                 FROM payments p
                 JOIN refunds r ON r."paymentId" = p.id
                WHERE p."orderId" = o.id
                  AND r.status::text = 'FAILED'
             ) < ${OrderRefundReactorService.MAX_FAILED_ATTEMPTS}
       ORDER BY o."createdAt" ASC
       LIMIT ${OrderRefundReactorService.BATCH}
    `;
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sweep(), delayMs);
    this.timer.unref?.();
  }
}

/** Re-exported so callers do not have to reach into the domain package for the status list. */
export const REFUNDABLE_CLOSING_STATUSES = [
  OrderStatus.REJECTED,
  OrderStatus.CANCELLED,
] as const;
