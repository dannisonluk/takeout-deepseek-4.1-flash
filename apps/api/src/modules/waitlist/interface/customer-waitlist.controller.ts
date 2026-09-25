import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { WAITLIST_REASON, WaitlistActor, WaitlistStatus } from '@takeout/domain';
import { TakeNumberUseCase } from '../application/take-number.use-case';
import { TransitionQueueUseCase } from '../application/transition-queue.use-case';
import { WaitlistQueryService } from '../application/waitlist-query.service';
import { TakeNumberDto } from './dto/waitlist.dto';
import {
  CustomerQueueEntryPointView,
  CustomerQueueTicketView,
  TakeNumberResultView,
} from './waitlist.views';

/**
 * 現場候位 — the guest's side.
 *
 * The take-a-number page is opened by somebody standing in a doorway on a
 * phone, usually not signed in. Every route here is therefore public, and that
 * is the design rather than an oversight:
 *
 *   - Requiring a login before a guest can pull a queue number would lose most
 *     of the queue at the first tap, and the shop would never know which
 *     customers it turned away.
 *   - Identity is the **phone number**, which is what the take-a-number form
 *     collects anyway — it is the one handle the guest still has an hour later,
 *     and it is exactly what the host would use to ring them.
 *   - A ticket id alone is NOT enough to read a ticket: every read is keyed on
 *     `(entryId, phone)`. A guessed id reveals nothing, which matters because a
 *     ticket carries a name and a party size.
 *
 * There is deliberately no `MerchantScopeGuard` here: that guard proves the
 * caller *staffs* a merchant, and a walk-in guest staffs nothing.
 */
@Controller()
export class CustomerWaitlistController {
  constructor(
    private readonly query: WaitlistQueryService,
    private readonly takeNumber: TakeNumberUseCase,
    private readonly transitions: TransitionQueueUseCase,
  ) {}

  /** The take-a-number page state. `phone` recovers the guest's own ticket. */
  @Get('merchants/:merchantId/queue')
  async entryPoint(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query('phone') phone?: string,
  ): Promise<CustomerQueueEntryPointView> {
    const view = await this.query.entryPoint({
      merchantId,
      ...(phone ? { myPhone: phone } : {}),
    });
    if (!view) throw new NotFoundException('Merchant not found');
    return view;
  }

  /**
   * Take a number.
   *
   * 201 rather than 200: a ticket was created. The body carries the number and
   * the estimate, which is the entire confirmation the guest needs — no
   * follow-up request required to render the page.
   */
  @Post('merchants/:merchantId/queue')
  @HttpCode(HttpStatus.CREATED)
  async join(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: TakeNumberDto,
  ): Promise<TakeNumberResultView> {
    return this.takeNumber.execute({
      merchantId,
      partySize: dto.partySize,
      guestName: dto.guestName,
      contactPhone: dto.contactPhone,
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    });
  }

  /**
   * The guest's own ticket, polled while they wait.
   *
   * `phone` is required, not optional — it is the ownership check. A 404 for a
   * wrong phone rather than a 403, so a guessed id does not confirm that a
   * ticket exists.
   */
  @Get('queue/tickets/:entryId')
  async myTicket(
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Query('phone') phone: string,
  ): Promise<CustomerQueueTicketView> {
    const ticket = await this.query.myTicket({ entryId, phone });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /**
   * Leave the queue.
   *
   * The guest may do this themselves **only while still waiting** — the state
   * machine enforces the same rule, and `statusReason` records that the guest
   * walked away rather than that the shop closed the queue. Once called, the
   * shop is holding a table and the exit is a no-show, which only the host can
   * declare.
   */
  @Post('queue/tickets/:entryId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Query('phone') phone: string,
  ): Promise<{ entryId: string; ticketNo: string; status: WaitlistStatus; message: string }> {
    const ticket = await this.query.myTicket({ entryId, phone });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const result = await this.transitions.execute({
      entryId,
      to: WaitlistStatus.CANCELLED,
      actor: WaitlistActor.CUSTOMER,
      reason: WAITLIST_REASON.GUEST_CANCELLED,
    });

    return {
      entryId: result.entryId,
      ticketNo: result.ticketNo,
      status: result.toStatus,
      message: `已為你取消號碼 ${result.ticketNo}。`,
    };
  }
}
