import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { toActor } from '../../../common/auth/actor';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import { Roles, RolesGuard } from '../../../common/auth/roles.guard';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AdminConfigService } from '../application/admin-config.service';
import { UpsertPlatformConfigDto } from './dto/admin.dto';
import {
  CancellationPolicyView,
  PlatformConfigHistoryView,
  PlatformConfigView,
  PricingPolicyView,
} from './admin.views';

/**
 * Runtime configuration — the screen that moves the HK$3.50 per-item fee and
 * the cancellation refund percentages.
 *
 * `GET` returns the registry union the stored rows, so every configurable knob
 * appears even before anyone has overridden it, alongside the value that would
 * apply if the override were cleared. `PUT` writes and then reloads the live
 * policies in place, so the new rate is in force on the next order rather than
 * on the next deploy.
 *
 * Keys contain dots (`pricing.platform_fee_per_main_item_minor`). That is legal
 * in a path segment, so no encoding is needed.
 *
 * Route order matters: `history` and `rollback` are declared before the bare
 * `:key` handlers they would otherwise be shadowed by — `GET /admin/config/
 * cancellation.grace_minutes/history` is two segments, so it cannot actually
 * collide with `GET /admin/config/pricing`, but keeping the literals first
 * means a future single-segment literal cannot be swallowed by `:key`.
 */
@Controller('admin/config')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminConfigController {
  constructor(private readonly config: AdminConfigService) {}

  @Get()
  list(): Promise<PlatformConfigView[]> {
    return this.config.list();
  }

  /** The pricing policy in force right now, with the layer it came from. */
  @Get('pricing')
  pricing(): PricingPolicyView {
    return this.config.currentPolicy();
  }

  /** The cancellation policy in force right now. */
  @Get('cancellation')
  cancellation(): CancellationPolicyView {
    return this.config.currentCancellationPolicy();
  }

  /** Every recorded write for one key, newest first. */
  @Get(':key/history')
  history(
    @Param('key') key: string,
    @Query('limit') limit?: string,
  ): Promise<PlatformConfigHistoryView[]> {
    const parsed = Number.parseInt(limit ?? '50', 10);
    return this.config.history(key, Number.isFinite(parsed) ? parsed : 50);
  }

  @Put(':key')
  @HttpCode(HttpStatus.OK)
  upsert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Body() dto: UpsertPlatformConfigDto,
    @Req() request: Request,
  ): Promise<PlatformConfigView> {
    return this.config.upsert(key, dto, toActor(user, request));
  }

  /**
   * Put a key back to the value recorded in a history row.
   *
   * A `POST` to a sub-resource rather than a `DELETE`: the history entry is not
   * consumed, and a new row is appended so the trail keeps its holes filled.
   */
  @Post(':key/rollback/:historyId')
  @HttpCode(HttpStatus.OK)
  rollback(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Param('historyId') historyId: string,
    @Req() request: Request,
  ): Promise<PlatformConfigView> {
    return this.config.rollback(key, historyId, toActor(user, request));
  }

  /**
   * Remove the override, reverting the key to the environment / code default.
   *
   * Idempotent: deleting an override that does not exist returns the key in its
   * already-reverted state rather than a 404.
   */
  @Delete(':key')
  @HttpCode(HttpStatus.OK)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('key') key: string,
    @Req() request: Request,
  ): Promise<PlatformConfigView> {
    return this.config.remove(key, toActor(user, request));
  }
}
