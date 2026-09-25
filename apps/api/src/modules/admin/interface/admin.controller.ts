import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { AuditLogView } from '../../../infrastructure/audit/audit.service';
import { OrderSweepReport } from '../../ordering/application/order-timeout-sweeper.service';
import { RefundSweepReport } from '../../payment/application/order-refund-reactor.service';
import { AdminDashboardService } from '../application/admin-dashboard.service';
import { AdminOpsService } from '../application/admin-ops.service';
import { AdminAuditQueryDto, AdminOutboxQueryDto } from './dto/admin.dto';
import {
  AdminOutboxEventView,
  AdminOutboxStatsView,
  DashboardStatsView,
} from './admin.views';
/**
 * Platform overview and operations.
 *
 * `RolesGuard` runs after `JwtAuthGuard`, which is what populates
 * `request.user`; the role check then throws `INSUFFICIENT_ROLE` (403 with a
 * machine-readable code) rather than returning a bare 403.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(
    private readonly dashboard: AdminDashboardService,
    private readonly ops: AdminOpsService,
  ) {}

  @Get('dashboard')
  stats(): Promise<DashboardStatsView> {
    return this.dashboard.stats();
  }

  /** Connectivity strip for the console header. */
  @Get('health')
  health(): Promise<{ database: boolean; redis: boolean }> {
    return this.ops.health();
  }

  @Get('audit')
  audit(@Query() query: AdminAuditQueryDto): Promise<{ data: AuditLogView[]; total: number }> {
    return this.ops.listAudit(query);
  }

  @Get('outbox')
  outbox(
    @Query() query: AdminOutboxQueryDto,
  ): Promise<{ data: AdminOutboxEventView[]; total: number }> {
    return this.ops.listOutbox(query);
  }

  @Get('outbox/stats')
  outboxStats(): Promise<AdminOutboxStatsView> {
    return this.ops.outboxStats();
  }

  @Post('outbox/:eventId/retry')
  @HttpCode(HttpStatus.OK)
  retryOutbox(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Req() request: Request,
  ): Promise<AdminOutboxEventView> {
    return this.ops.retryOutbox(eventId, toActor(user, request));
  }

  @Post('outbox/:eventId/dead-letter')
  @HttpCode(HttpStatus.OK)
  deadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Req() request: Request,
  ): Promise<AdminOutboxEventView> {
    return this.ops.deadLetter(eventId, toActor(user, request));
  }

  /**
   * Run the timeout sweeper and the refund reactor immediately.
   *
   * Both are background loops, so without a manual trigger two questions are
   * unanswerable: "this order has been stuck in PAID for an hour — is the
   * sweeper broken?" and "did the refund fire?". The e2e suite uses this too,
   * because a test that sleeps for a sweep interval is a test that flakes.
   */
  @Post('ops/sweep')
  @HttpCode(HttpStatus.OK)
  sweep(): Promise<{ orders: OrderSweepReport; refunds: RefundSweepReport }> {
    return this.ops.runSweeps();
  }
}
