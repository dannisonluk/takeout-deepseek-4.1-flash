import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IdGenerator,
  WAITLIST_REASON,
  WaitlistActor,
  WaitlistSideEffect,
  WaitlistStateMachine,
  WaitlistStatus,
} from '@takeout/domain';
import { ID_GENERATOR, WAITLIST_REPOSITORY, WAITLIST_STATE_MACHINE } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { ConcurrentWaitlistModificationError } from '../domain/waitlist.errors';
import { WaitlistRepositoryPort } from '../domain/waitlist.repository.port';
import { QueueSweepResultView } from '../interface/waitlist.views';

/**
 * 過號 sweeper — mark called-but-never-appeared tickets as no-shows.
 *
 * WHY THIS IS A SWEEP AND NOT A TIMER
 * -----------------------------------
 * The alternative is `setTimeout` per called ticket. It does not survive a
 * restart, it multiplies with every deploy, and a ticket called at 23:58 for a
 * process killed at midnight never times out — which is exactly the ticket the
 * next morning's board shows as "being seated". A sweep that reads the rows and
 * compares `calledAt` against the policy is stateless, idempotent, and correct
 * after any number of restarts.
 *
 * It goes through `TransitionQueueUseCase`'s machinery rather than writing the
 * status directly, so:
 *
 *   1. The move is authorised by `WaitlistStateMachine` — `CALLED → NO_SHOW` is
 *      the SYSTEM actor's move, and if that ever changed, this would stop
 *      working rather than silently diverging.
 *   2. The `RECORD_NO_SHOW` side effect is discharged, which is what makes the
 *      guest's record and the notification say the same thing.
 *   3. The outbox row is written in the same transaction, so nobody is marked a
 *      no-show without the board finding out.
 *
 * It is **bounded** and **sequential**: each iteration takes a row lock, and
 * the API's pool is finite. Fanning out over a whole evening's calls would hold
 * one connection per ticket and deadlock against itself — the same reasoning
 * `MerchantClosureService.SWEEP_LIMIT` documents at length.
 */
@Injectable()
export class SweepQueueUseCase {
  private readonly logger = new Logger(SweepQueueUseCase.name);

  /**
   * How many no-shows one pass will mark.
   *
   * A cap rather than "all of them". A shop with more than this genuinely
   * forgot its board for a long stretch, and the honest answer is that the next
   * pass thirty seconds later will catch the rest — not that this request holds
   * two hundred connections.
   */
  private static readonly SWEEP_LIMIT = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WAITLIST_REPOSITORY) private readonly waitlist: WaitlistRepositoryPort,
    @Inject(WAITLIST_STATE_MACHINE) private readonly stateMachine: WaitlistStateMachine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly outbox: OutboxService,
  ) {}

  async execute(params: {
    merchantId: string;
    now?: Date;
    dryRun?: boolean;
  }): Promise<QueueSweepResultView> {
    const now = params.now ?? new Date();
    const settings = await this.waitlist.findSettings(params.merchantId, now);
    const timeoutMinutes = settings.policy.callTimeoutMinutes;

    const timedOut = await this.waitlist.findTimedOutCalls(
      params.merchantId,
      now,
      timeoutMinutes,
      SweepQueueUseCase.SWEEP_LIMIT,
    );

    if (params.dryRun) {
      return {
        merchantId: params.merchantId,
        markedNoShow: 0,
        skipped: timedOut.length,
        message: `試算：有 ${timedOut.length} 張已叫號號碼超過 ${timeoutMinutes} 分鐘未入座。`,
      };
    }

    let marked = 0;
    let skipped = 0;

    for (const entry of timedOut) {
      try {
        await this.prisma.runInTransaction(async (tx) => {
          // Re-read under the lock. The list was built outside any transaction
          // and a host may have seated the guest between then and now — the
          // whole point of re-reading is that "they appeared at the last
          // second" resolves in the guest's favour rather than marking them a
          // no-show they can then argue about.
          const current = await this.waitlist.findByIdForUpdate(tx, entry.id);
          if (!current || current.status !== WaitlistStatus.CALLED) return;

          const transition = this.stateMachine.transition(
            {
              waitlistEntryId: current.id,
              merchantId: current.merchantId,
              from: current.status,
              to: WaitlistStatus.NO_SHOW,
              actor: WaitlistActor.SYSTEM,
              reason: WAITLIST_REASON.CALL_TIMEOUT,
              now,
            },
            { callTimeoutMinutes: timeoutMinutes },
          );

          const applied = await this.waitlist.updateStatus(
            tx,
            current.id,
            transition.from,
            transition.to,
            {
              cancelledAt: transition.occurredAt,
              statusReason: WAITLIST_REASON.CALL_TIMEOUT,
            },
          );
          if (!applied) {
            throw new ConcurrentWaitlistModificationError(current.id, current.status);
          }

          const updated = await this.waitlist.findByIdForUpdate(tx, current.id);
          const finalRow = updated ?? { ...current, status: transition.to, version: current.version + 1 };

          await this.outbox.enqueue(
            tx,
            this.outbox.buildWaitlistEvent({
              idGenerator: this.idGenerator,
              entry: finalRow,
              actor: WaitlistActor.SYSTEM,
              occurredAt: transition.occurredAt,
              notifyCustomer: transition.sideEffects.includes(
                WaitlistSideEffect.NOTIFY_CUSTOMER,
              ),
              recordNoShow: transition.sideEffects.includes(WaitlistSideEffect.RECORD_NO_SHOW),
            }),
          );
        });
        marked += 1;
      } catch (error) {
        // One ticket that cannot be moved must not abandon the rest. A race
        // with a host is the expected case here, not a failure.
        if (error instanceof ConcurrentWaitlistModificationError) {
          this.logger.warn(
            `Queue sweep for ${params.merchantId}: skipped ${entry.ticketNo} (${(error as Error).message})`,
          );
          skipped += 1;
          continue;
        }
        throw error;
      }
    }

    this.logger.log(
      `Queue sweep for ${params.merchantId}: ${marked} marked no-show, ${skipped} skipped`,
    );

    return {
      merchantId: params.merchantId,
      markedNoShow: marked,
      skipped,
      message:
        marked === 0
          ? `沒有需要標記為過號的號碼。`
          : `已將 ${marked} 張超過 ${timeoutMinutes} 分鐘未入座的號碼標記為過號。`,
    };
  }
}
