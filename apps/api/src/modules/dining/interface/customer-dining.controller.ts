import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { DINING_GUEST_ACTOR } from '../application/dining-guest';
import { DiningQueryService } from '../application/dining-query.service';
import { OpenCloseSessionUseCase } from '../application/open-close-session.use-case';
import { ScanAndOrderResultView, ScanAndOrderUseCase } from '../application/scan-and-order.use-case';
import { OpenDiningSessionDto, ScanAndOrderDto } from './dto/dining.dto';
import {
  DiningSessionTabView,
  OpenSessionResultView,
  ScannedTableView,
} from './dining.views';

/**
 * 店內點餐 — the guest's side.
 *
 * UI EMPHASIS: **this is the mobile-first half of the feature.** A guest holds a
 * phone in one hand, standing in a shop, and the entire flow is:
 *
 *   scan the table code → start a sitting → get a one-time token → order →
 *   see the running total.
 *
 * Three consequences are pushed into the API rather than left to the client:
 *
 *   - **The scan resolves everything in one call.** `GET /dine/:qrToken` returns
 *     the shop, the table, the sitting and the tab-so-far in ONE response, so
 *     the page renders without a second round-trip. On a phone that is the
 *     difference between a menu and a spinner.
 *   - **No login, ever.** The guest is identified by the **one-time sitting
 *     token** minted when a sitting opens, not by an account. This is the
 *     decision the shop's owner made: "入座時 assign 一次性 QR code". The static
 *     table code only opens a sitting; ordering authority is the per-sitting
 *     token, so a photographed table code cannot order onto somebody's bill.
 *   - **Order responses carry the whole tab.** A guest who ordered three times
 *     sees the total after each round without polling.
 *
 * ## Two token types, and why
 *
 * | Token | Where it comes from | What it may do |
 * |---|---|---|
 * | `:qrToken` (static) | the label stuck to the table | resolve the table, OPEN a sitting |
 * | `:guestToken` (one-time) | returned by opening a sitting | read the tab, SEND rounds |
 *
 * Splitting them is what lets a shop print its labels once and still have
 * per-sitting authority.
 */
@Controller('dine')
export class CustomerDiningController {
  constructor(
    private readonly query: DiningQueryService,
    private readonly sessions: OpenCloseSessionUseCase,
    private readonly order: ScanAndOrderUseCase,
  ) {}

  /**
   * Resolve a scanned TABLE code.
   *
   * The single call the scan page makes, before any sitting exists. 404 for an
   * unknown or rotated token — a code that was reprinted must read as "this code
   * no longer works".
   */
  @Get('table/:qrToken')
  async scanned(@Param('qrToken') qrToken: string): Promise<ScannedTableView> {
    const view = await this.query.scanned(qrToken);
    if (!view) throw new NotFoundException('QR code not found');
    return view;
  }

  /**
   * Start a sitting (or join the one already open) and receive the one-time
   * token.
   *
   * Idempotent: scanning twice, or two guests at one table scanning, must not
   * produce two bills. The use case locks the table row and returns the already
   * open sitting — with that sitting's own token, so the second guest shares the
   * first one's bill.
   */
  @Post('table/:qrToken/session')
  @HttpCode(HttpStatus.CREATED)
  async openSession(
    @Param('qrToken') qrToken: string,
    @Body() dto: OpenDiningSessionDto,
  ): Promise<OpenSessionResultView> {
    return this.sessions.open({
      qrToken,
      ...(dto.partySize !== undefined ? { partySize: dto.partySize } : {}),
      actor: DINING_GUEST_ACTOR,
    });
  }

  /**
   * The running tab, keyed on the one-time token.
   *
   * This is what the phone polls while the guest waits — hence keyed on the
   * guest token, not the table code, and hence returning the whole tab rather
   * than a round.
   */
  @Get('s/:guestToken/tab')
  async tab(@Param('guestToken') guestToken: string): Promise<DiningSessionTabView> {
    const tab = await this.query.tabByGuestToken(guestToken);
    if (!tab) throw new NotFoundException('No open session for this token');
    return tab;
  }

  /**
   * Send a round.
   *
   * The order is created by `PlaceOrderUseCase` — the same one the checkout uses
   * — so pricing, the kitchen board and the lifecycle are all the ones that
   * already work. All this route contributes is `diningSessionId` and the guest
   * identity the sitting carries.
   */
  @Post('s/:guestToken/orders')
  @HttpCode(HttpStatus.CREATED)
  async sendRound(
    @Param('guestToken') guestToken: string,
    @Body() dto: ScanAndOrderDto,
  ): Promise<ScanAndOrderResultView> {
    return this.order.execute({
      guestToken,
      items: dto.items,
      ...(dto.customerNote !== undefined ? { customerNote: dto.customerNote } : {}),
      ...(dto.contactPhone !== undefined ? { contactPhone: dto.contactPhone } : {}),
      ...(dto.idempotencyKey !== undefined ? { idempotencyKey: dto.idempotencyKey } : {}),
    });
  }
}
