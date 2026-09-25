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
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { DiningSessionStatus } from '@takeout/domain';
import { toActor } from '../../../common/auth/actor';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard, MerchantScopeGuard } from '../../../common/auth/jwt-auth.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { DiningQueryService } from '../application/dining-query.service';
import { ManageTablesUseCase } from '../application/manage-tables.use-case';
import { OpenCloseSessionUseCase } from '../application/open-close-session.use-case';
import {
  CreateDiningTableDto,
  UpdateDiningTableDto,
} from './dto/dining.dto';
import {
  CloseSessionResultView,
  DiningSessionTabView,
  DiningTableView,
  MerchantTableBoardView,
} from './dining.views';

/**
 * 店內點餐 — the merchant's floor.
 *
 * UI EMPHASIS: this is the **tablet-on-a-counter** half of the feature, and it
 * is the opposite of the guest's phone in every way that matters:
 *
 *   - It renders the WHOLE floor in one request (`GET :merchantId/dining`),
 *     because a host scanning a room needs every table's state at a glance and
 *     a per-table request would be thirty round-trips per poll.
 *   - The rows are large, few, and colour-coded by sitting age — hence
 *     `seatedMinutes` on every session summary.
 *   - Every mutating route returns the updated table or tab so the board can
 *     patch one card rather than refetching the floor.
 *
 * `MerchantScopeGuard` at class level proves the caller staffs `:merchantId`.
 * Single-table and single-session routes additionally re-check the row's
 * merchant inside the use case, because the guard protects the PATH and a
 * guessed uuid must not reach another shop's floor.
 */
@Controller('merchant')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MerchantDiningController {
  constructor(
    private readonly query: DiningQueryService,
    private readonly tables: ManageTablesUseCase,
    private readonly sessions: OpenCloseSessionUseCase,
  ) {}

  /** The whole floor plan: every table, its sitting, and running totals. */
  @Get(':merchantId/dining')
  async board(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
  ): Promise<MerchantTableBoardView> {
    const view = await this.query.board(merchantId);
    if (!view) throw new NotFoundException('Merchant not found');
    return view;
  }

  /** Add a table to the floor plan. Returns the table with its QR URL. */
  @Post(':merchantId/dining/tables')
  @HttpCode(HttpStatus.CREATED)
  async createTable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: CreateDiningTableDto,
    @Req() request: Request,
  ): Promise<DiningTableView> {
    return this.tables.create(merchantId, dto, toActor(user, request));
  }

  /**
   * Edit a table, or rotate its QR.
   *
   * `rotateQr: true` mints a fresh token — the only lever a shop has when a
   * printed code leaks. The new QR is in the response, ready to reprint.
   */
  @Patch(':merchantId/dining/tables/:tableId')
  async updateTable(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('tableId', new ParseUUIDPipe()) tableId: string,
    @Body() dto: UpdateDiningTableDto,
    @Req() request: Request,
  ): Promise<DiningTableView> {
    return this.tables.update(merchantId, tableId, dto, toActor(user, request));
  }

  /** Open a sitting from the board — the host seating a party. */
  @Post(':merchantId/dining/tables/:tableId/session')
  @HttpCode(HttpStatus.CREATED)
  async openSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('tableId', new ParseUUIDPipe()) tableId: string,
    @Req() request: Request,
  ): Promise<{ sessionId: string; guestToken: string; message: string }> {
    // Reuse the guest path by resolving the table's static token, so "host
    // seats a party" and "guest scans the label" produce the SAME sitting and
    // the same one-time token — one open code path, not two.
    const table = await this.query.board(merchantId);
    const row = table?.tables.find((candidate) => candidate.id === tableId);
    if (!row) throw new NotFoundException('Table not found');

    const result = await this.sessions.open({
      qrToken: row.qrToken,
      actor: toActor(user, request),
    });
    return {
      sessionId: result.session.id,
      guestToken: result.guestToken,
      message: result.message,
    };
  }

  /** The tab for one sitting — what the host checks before settling. */
  @Get(':merchantId/dining/sessions/:sessionId')
  async tab(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
  ): Promise<DiningSessionTabView> {
    const tab = await this.query.tab({ sessionId, merchantId });
    if (!tab) throw new NotFoundException('Session not found');
    return tab;
  }

  /**
   * Close a sitting.
   *
   * `status` defaults to `CLOSED` (paid and left); `ABANDONED` is the other
   * terminal state (nobody came back). Both are offered rather than guessed,
   * because the difference lands in the day's covers.
   */
  @Post(':merchantId/dining/sessions/:sessionId/close')
  @HttpCode(HttpStatus.OK)
  async closeSession(
    @CurrentUser() user: AuthenticatedUser,
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('sessionId', new ParseUUIDPipe()) sessionId: string,
    @Body() body: { status?: DiningSessionStatus },
    @Req() request: Request,
  ): Promise<CloseSessionResultView> {
    return this.sessions.close({
      merchantId,
      sessionId,
      ...(body.status !== undefined ? { to: body.status } : {}),
      actor: toActor(user, request),
    });
  }
}
