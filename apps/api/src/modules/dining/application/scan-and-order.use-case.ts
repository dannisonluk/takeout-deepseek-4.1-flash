import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DiningSessionClosedError,
  FulfilmentMode,
  IdGenerator,
  PaymentMode,
} from '@takeout/domain';
import { DINING_REPOSITORY, ID_GENERATOR } from '../../../common/tokens';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  PlaceOrderResult,
  PlaceOrderUseCase,
} from '../../ordering/application/place-order.use-case';
import { DiningRepositoryPort } from '../domain/dining.repository.port';
import {
  DiningSessionNotFoundError,
  DiningTableInactiveError,
  DiningTableNotFoundError,
} from '../domain/dining.errors';
import { DiningOrderItemDto } from '../interface/dto/dining.dto';
import { DiningSessionTabView } from '../interface/dining.views';
import { DiningQueryService } from './dining-query.service';
import { guestDisplayName } from './dining-guest';

export interface ScanAndOrderCommand {
  /** The one-time sitting token from `POST /dine/table/:qrToken/session`. */
  readonly guestToken: string;
  readonly items: readonly DiningOrderItemDto[];
  readonly customerNote?: string;
  readonly contactPhone?: string;
  readonly idempotencyKey?: string;
}

/** What the guest's phone gets back after a round is sent. */
export interface ScanAndOrderResultView {
  readonly order: PlaceOrderResult;
  /**
   * The whole tab so far, not just the round just placed.
   *
   * A dine-in guest orders three or four times across a sitting; making them
   * fetch the tab after every round is a second request on the flakiest device
   * in the building (a phone on in-store Wi-Fi), and the total is what they
   * actually want to see.
   */
  readonly tab: DiningSessionTabView;
  readonly message: string;
}

/**
 * 店內點餐 — scan and order.
 *
 * Two design decisions worth stating.
 *
 * **1. This is not a new ordering path.** It resolves a token to a sitting, and
 * then calls `PlaceOrderUseCase` — the same use case the customer app's checkout
 * calls. Everything that already works keeps working unchanged: the pricing
 * engine charges per main item, the kitchen board sees the order because it is
 * an ordinary `Order` row, and the timeout sweeper, refund flow, payout ledger
 * and state machine all apply. The ONLY thing this adds is `diningSessionId`.
 * That is why there is no `DINING_*` order status: a second lifecycle would
 * have to re-implement all of the above, and half of it would be subtly wrong.
 *
 * **2. The guest identity is provisioned, not demanded.** `orders.customerId`
 * is a NOT NULL foreign key to `users`, so a dine-in round needs SOME row to
 * belong to. Rather than force a login (which the shop explicitly did not want
 * — "入座時 assign 一次性 QR code"), the first round at a sitting provisions one
 * lightweight `CUSTOMER` row: no phone, no email, no refresh token, never
 * loggable-into. It exists to satisfy the ledger and the audit trail, and it is
 * attached to the sitting so a second round reuses it rather than making a
 * second guest.
 */
@Injectable()
export class ScanAndOrderUseCase {
  private readonly logger = new Logger(ScanAndOrderUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(DINING_REPOSITORY) private readonly dining: DiningRepositoryPort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly placeOrder: PlaceOrderUseCase,
    private readonly query: DiningQueryService,
  ) {}

  async execute(command: ScanAndOrderCommand): Promise<ScanAndOrderResultView> {
    const scanned = await this.dining.findByGuestToken(command.guestToken);
    if (!scanned) throw new DiningTableNotFoundError(command.guestToken);
    if (!scanned.table.isActive) throw new DiningTableInactiveError(scanned.table.code);

    const session = scanned.openSession;
    // A closed or abandoned sitting has no open sitting left, so there is no tab
    // to add to. Reported as CLOSED rather than "not found" because the guest's
    // page has a specific thing to say here ("this table has been settled"),
    // and a missing-session message would send them hunting for a QR code that
    // is in fact still on the table.
    if (!session) throw new DiningSessionClosedError('CLOSED');
    if (session.status !== 'OPEN') throw new DiningSessionClosedError(session.status);

    const customerId = await this.resolveGuestCustomer(session.id, scanned.table.code);

    const result = await this.placeOrder.execute({
      customerId,
      merchantId: scanned.merchant.id,
      items: command.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
      })),
      // Dine-in: the guest is not collecting anything, and the money is settled
      // the way this shop settles a table — at the end, on the whole bill.
      //
      // `PAY_AT_STORE` is the right mode, and not merely the closest one: it
      // suppresses the payment-processing fee, which is correct here because no
      // PSP touches this round. Charging the merchant 3.4% + HK$2.35 for a
      // payment taken at the table would be the platform taking a cut of money
      // it never handled. The override is recorded in `pricingSnapshot`, so the
      // payout difference is provable later.
      fulfilmentMode: FulfilmentMode.SELF_PICKUP,
      paymentMode: PaymentMode.PAY_AT_STORE,
      diningSessionId: session.id,
      ...(command.customerNote !== undefined ? { customerNote: command.customerNote } : {}),
      ...(command.contactPhone !== undefined ? { contactPhone: command.contactPhone } : {}),
      ...(command.idempotencyKey !== undefined ? { idempotencyKey: command.idempotencyKey } : {}),
    });

    this.logger.log(
      `Table ${scanned.table.code}: order ${result.order.orderNo} added to sitting ${session.id}`,
    );

    const tab = await this.query.tabByGuestToken(command.guestToken);
    if (!tab) throw new DiningSessionNotFoundError(session.id);

    return {
      order: result,
      tab,
      message: `已收到第 ${tab.lines.length} 輪點餐，合共 HK$${(tab.totalMinor / 100).toFixed(2)}。`,
    };
  }

  /**
   * The customer row this sitting's orders belong to.
   *
   * Reuses the sitting's existing guest when there is one, so a table that
   * orders four times has one guest and one bill. Otherwise creates one and
   * attaches it — `attachGuestCustomer` is a conditional UPDATE
   * (`WHERE guestCustomerId IS NULL`), so two rounds racing on a fresh sitting
   * cannot both attach a different guest; the loser reads back the winner's.
   *
   * No phone and no email, which is what keeps this row un-loggable-into: the
   * only credentials this system issues are OTPs to a phone or an email, and
   * this row has neither.
   */
  private async resolveGuestCustomer(sessionId: string, tableCode: string): Promise<string> {
    const existing = await this.dining.findGuestCustomer(sessionId);
    if (existing) return existing;

    const created = await this.prisma.user.create({
      data: {
        displayName: guestDisplayName(tableCode),
        role: 'CUSTOMER',
        locale: 'zh-HK',
        // Explicitly inert: nothing about this row is meant to be authenticated.
        isActive: false,
      },
      select: { id: true },
    });

    await this.dining.attachGuestCustomer(sessionId, created.id);

    // Read back rather than trusting `created.id`: if another round won the
    // race, the sitting now points at THEIR guest and this round must join it,
    // or the table would have two bills.
    return (await this.dining.findGuestCustomer(sessionId)) ?? created.id;
  }
}
