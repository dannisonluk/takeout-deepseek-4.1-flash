import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { WaitlistActor } from '@takeout/domain';
import { toActor } from '../../../common/auth/actor';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { SweepQueueUseCase } from '../application/sweep-queue.use-case';
import { TransitionQueueUseCase } from '../application/transition-queue.use-case';
import { WaitlistQueryService } from '../application/waitlist-query.service';
import { WaitlistSettingsService } from '../application/waitlist-settings.service';
import {
  MerchantQueueQueryDto,
  SweepQueueDto,
  TransitionQueueEntryDto,
  UpdateWaitlistSettingsDto,
} from './dto/waitlist.dto';
import {
  MerchantQueueView,
  QueueSweepResultView,
  QueueTransitionResultView,
  WaitlistSettingsView,
} from './waitlist.views';

/**
 * 現場候位 — the host board.
 *
 * UI EMPHASIS: this is the one screen in the product designed for a **tablet on
 * a counter in a dark, loud shop**. Three consequences run through the API
 * rather than being left to the client:
 *
 *   - The whole day comes back in ONE request. A board that has to fetch
 *     "active" and "today's log" separately is a board that shows a ticket in
 *     neither list for the half-second between the two responses, and a host
 *     tapping it in that window is the failure mode.
 *   - Every row carries `allowedNextTransitions`, computed by the same state
 *     machine the write path uses. On a tablet a refused tap looks like a dead
 *     button, so the buttons offered must be exactly the moves the server
 *     accepts.
 *   - `nextTicketNo` and the day's counts come back with the list, so the
 *     screen has everything it needs to render without a second round-trip.
 *
 * `MerchantScopeGuard` at class level proves the caller staffs `:merchantId`;
 * single-row routes re-check the row's merchant, because the guard protects the
 * path, not the row.
 */
@Controller('merchant')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantWaitlistController {
  constructor(
    private readonly query: WaitlistQueryService,
    private readonly transitions: TransitionQueueUseCase,
    private readonly settings: WaitlistSettingsService,
    private readonly sweep: SweepQueueUseCase,
  ) {}

  /** The live board plus today's log, plus the settings context. */
  @Get(':merchantId/queue')
  async board(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query() query: MerchantQueueQueryDto,
  ): Promise<MerchantQueueView> {
    const view = await this.query.board({
      merchantId,
      ...(query.date !== undefined ? { date: query.date } : {}),
    });
    if (!view) throw new NotFoundException('Merchant not found');
    return view;
  }

  /** The queue settings screen. */
  @Get(':merchantId/queue/settings')
  async getSettings(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
  ): Promise<WaitlistSettingsView> {
    const view = await this.settings.read(merchantId);
    if (!view) throw new NotFoundException('Merchant not found');
    return view;
  }

  /** Enable the queue, change the party-size range, retune the estimate. */
  @Patch(':merchantId/queue/settings')
  async updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: UpdateWaitlistSettingsDto,
    @Req() request: Request,
  ): Promise<WaitlistSettingsView> {
    return this.settings.update(merchantId, dto, toActor(user, request));
  }

  /**
   * Call, seat, or mark a guest a no-show.
   *
   * One endpoint for every move rather than a route per verb: the legal moves
   * depend on the current status, and three routes would each have to
   * re-implement the same state-machine check. Which moves are legal is
   * answered by `allowedNextTransitions` on every board row.
   */
  @Post(':merchantId/queue/:entryId/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Body() dto: TransitionQueueEntryDto,
    @Req() request: Request,
  ): Promise<QueueTransitionResultView> {
    const board = await this.query.board({ merchantId });
    if (!board) throw new NotFoundException('Merchant not found');

    const actor = toActor(user, request);
    const settings = await this.settings.read(merchantId);

    return this.transitions.execute({
      entryId,
      to: dto.to,
      actor: WaitlistActor.MERCHANT,
      actorId: actor.userId,
      callTimeoutMinutes: settings?.policy.callTimeoutMinutes ?? 10,
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    });
  }

  /**
   * Mark every overdue called ticket a no-show.
   *
   * Exposed as a merchant route as well as the scheduled job so a host can
   * clear the board at closing time without waiting for the next sweep tick.
   * `dryRun` reports what would happen, which is what the board's "clear
   * overdue" button shows in its confirmation.
   */
  @Post(':merchantId/queue/sweep')
  @HttpCode(HttpStatus.OK)
  async sweepOverdue(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: SweepQueueDto,
  ): Promise<QueueSweepResultView> {
    return this.sweep.execute({
      merchantId,
      ...(dto.dryRun !== undefined ? { dryRun: dto.dryRun } : {}),
    });
  }
}
