import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { AdminUsersService } from '../application/admin-users.service';
import { AdminUserQueryDto, UpdateUserDto } from './dto/admin.dto';
import { AdminUserView } from './admin.views';

@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list(
    @Query() query: AdminUserQueryDto,
  ): Promise<{ data: AdminUserView[]; total: number }> {
    return this.users.list(query);
  }

  @Get(':userId')
  get(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<AdminUserView> {
    return this.users.get(userId);
  }

  /**
   * Change a role, enable or disable an account.
   *
   * Returns 403 `SELF_MODIFICATION` when an admin targets their own role or
   * active flag, and 409 `LAST_ADMIN` when the change would leave the platform
   * with no enabled administrator.
   */
  @Patch(':userId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() dto: UpdateUserDto,
    @Req() request: Request,
  ): Promise<AdminUserView> {
    return this.users.update(userId, dto, toActor(user, request));
  }

  /** Force every device to sign in again. */
  @Post(':userId/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  revokeSessions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() request: Request,
  ): Promise<{ revoked: number }> {
    return this.users.revokeSessions(userId, toActor(user, request));
  }
}
