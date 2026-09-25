import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DiningActor,
  DiningSessionMachine,
  DiningSessionStatus,
  IdGenerator,
  assertNoOpenSession,
} from '@takeout/domain';
import { Actor } from '../../../common/auth/actor';
import { serviceDateIn } from '../../../common/time/service-date';
import { DINING_REPOSITORY, DINING_STATE_MACHINE, ID_GENERATOR } from '../../../common/tokens';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { DiningRepositoryPort } from '../domain/dining.repository.port';
import {
  ConcurrentDiningModificationError,
  DiningSessionNotFoundError,
  DiningTableInactiveError,
  DiningTableNotFoundError,
} from '../domain/dining.errors';
import { CloseSessionResultView, OpenSessionResultView } from '../interface/dining.views';
import { DiningQueryService } from './dining-query.service';
import { toSessionSummary } from './dining.mapper';

/**
 * Opening and closing a sitting.
 *
 * The interesting work is on the OPEN path, and it is all about the race:
 *
 *   Two guests at the same table scan the QR within a second of each other.
 *   Both requests read "no open sitting here", both then create one, and the
 *   table now has two sittings and two bills. The fix is not a unique index —
 *   the schema has no `@@unique([tableId, status])` because a CLOSED sitting
 *   must not block the next one — so the check and the insert have to be one
 *   atomic step. `SELECT ... FOR UPDATE` on the table row serialises them, and
 *   the second request then *sees* the first one's sitting and returns it
 *   rather than creating a second.
 *
 * That second-request-sees-the-first behaviour is deliberate: a guest who scans
 * a table somebody else at their table already opened should join that sitting,
 * not be told "you already have a table".
 */
@Injectable()
export class OpenCloseSessionUseCase {
  private readonly logger = new Logger(OpenCloseSessionUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DINING_REPOSITORY) private readonly dining: DiningRepositoryPort,
    @Inject(DINING_STATE_MACHINE) private readonly machine: DiningSessionMachine,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly query: DiningQueryService,
  ) {}

  /**
   * Open a sitting at the scanned table, or return the one already open.
   *
   * Idempotent on purpose: scanning twice is the ordinary case, not an error.
   */
  async open(params: {
    qrToken: string;
    partySize?: number;
    actor: Actor;
  }): Promise<OpenSessionResultView> {
    const scanned = await this.dining.findByQrToken(params.qrToken);
    if (!scanned) throw new DiningTableNotFoundError(params.qrToken);
    if (!scanned.table.isActive) throw new DiningTableInactiveError(scanned.table.code);

    const { table, merchant } = scanned;

    const { session, created } = await this.prisma.runInTransaction(async (tx) => {
      // Lock the table row so two simultaneous scans cannot both pass the
      // "no open sitting" check below.
      await tx.$queryRaw`SELECT id FROM "dining_tables" WHERE id = ${table.id}::uuid FOR UPDATE`;

      const existing = await this.dining.findOpenSession(tx, table.id);
      // The same table, somebody else got there first: join their sitting. The
      // party size is NOT overwritten — the first scanner's number is the one
      // the kitchen already has on the ticket.
      if (existing) return { session: existing, created: false };

      const opened = await this.dining.openSession(tx, {
        merchantId: merchant.id,
        tableId: table.id,
        partySize: params.partySize ?? null,
        serviceDate: serviceDateIn(merchant.timezone, new Date()),
        // The 一次性入座碼. Minted here, never reused: the printed table code
        // opens a sitting, but only THIS token may add a round to it — so a
        // photograph of the table code from a previous visit, or from the table
        // next door, cannot order onto somebody else's bill.
        guestToken: `gs${this.idGenerator.next().toLowerCase()}`,
      });
      return { session: opened, created: true };
    });

    // Only audit an actual opening, not a join — otherwise every guest at a
    // table of six writes a row that says the table was opened six times.
    if (created) {
      await this.audit.record({
        actorId: params.actor.userId,
        actorRole: params.actor.role,
        action: 'dining.session_open',
        targetType: 'DiningSession',
        targetId: session.id,
        before: null,
        after: { tableCode: table.code, partySize: session.partySize },
        ip: params.actor.ip ?? null,
      });
      this.logger.log(`Table ${table.code} opened (session ${session.id})`);
    }

    const orders = await this.dining.listSessionOrders(session.id);
    return {
      session: toSessionSummary(session, table, orders, new Date()),
      // Returned so the page can switch from the table code to the per-sitting
      // token. When the guest JOINED an existing sitting (`created === false`)
      // the token is still this sitting's own — that is what makes two guests at
      // one table share a bill rather than each opening their own.
      guestToken: session.guestToken ?? '',
      orderingUrl: session.guestToken ? this.query.diningUrl(session.guestToken) : '',
      message: `已為你開啟 ${table.code} 的用餐時段，可以開始點餐。`,
    };
  }

  /**
   * Close a sitting.
   *
   * Two terminal states, and they mean different things to the shop's books:
   * `CLOSED` is a table that paid and left, `ABANDONED` is a table nobody came
   * back to. Both are offered rather than defaulted, because guessing would put
   * a wrong number in the day's covers.
   *
   * No money moves here. The bill is a sum of orders that were already paid;
   * closing is what turns the table around.
   */
  async close(params: {
    merchantId: string;
    sessionId: string;
    to?: DiningSessionStatus;
    actor: Actor;
  }): Promise<CloseSessionResultView> {
    const to = params.to ?? DiningSessionStatus.CLOSED;

    const closed = await this.prisma.runInTransaction(async (tx) => {
      const session = await this.dining.findSessionForUpdate(tx, params.sessionId);
      if (!session) throw new DiningSessionNotFoundError(params.sessionId);
      // Scoped by merchant: a host must not close another shop's table by
      // guessing a uuid. The guard protects the path, not the row.
      if (session.merchantId !== params.merchantId) {
        throw new DiningSessionNotFoundError(params.sessionId);
      }

      // Throws DiningSessionClosedError when it is already terminal, and
      // DiningSessionConflictError when `to` is not terminal — both domain
      // rules, both mapped by the exception filter.
      this.machine.close(
        { diningSessionId: session.id, status: session.status },
        to,
      );

      const applied = await this.dining.closeSession(
        tx,
        session.id,
        session.status,
        to,
        params.actor.userId,
      );
      if (!applied) {
        // A writer slipped past the lock. Report a conflict rather than
        // pretending the close succeeded.
        throw new ConcurrentDiningModificationError(session.id, session.status);
      }

      return { ...session, status: to, closedAt: new Date(), version: session.version + 1 };
    });

    const [table, orders, merchant] = await Promise.all([
      this.dining.findTable(params.merchantId, closed.tableId),
      this.dining.listSessionOrders(closed.id),
      this.prisma.merchant.findUnique({
        where: { id: params.merchantId },
        select: { name: true },
      }),
    ]);
    if (!table) throw new DiningSessionNotFoundError(closed.id);

    await this.audit.record({
      actorId: params.actor.userId,
      actorRole: params.actor.role,
      action: 'dining.session_close',
      targetType: 'DiningSession',
      targetId: closed.id,
      before: { status: DiningSessionStatus.OPEN },
      after: { status: to, totalMinor: orders.reduce((sum, o) => sum + o.totalMinor, 0) },
      ip: params.actor.ip ?? null,
    });

    this.logger.log(`Table ${table.code} closed as ${to}`);

    const summary = toSessionSummary(closed, table, orders, new Date());
    const tab = await this.query.tab({
      sessionId: closed.id,
      merchantId: params.merchantId,
    });
    if (!tab) throw new DiningSessionNotFoundError(closed.id);

    return {
      session: summary,
      tab,
      message:
        to === DiningSessionStatus.CLOSED
          ? `${table.code} 已結帳，感謝光臨。`
          : `${table.code} 已標記為離場。`,
    };
  }
}
