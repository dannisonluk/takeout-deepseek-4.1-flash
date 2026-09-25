import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../../common/auth/authenticated-user';
import { JwtAuthGuard } from '../../../common/auth/jwt-auth.guard';
import {
  AuthProfileView,
  AuthService,
  OtpRequestedView,
  RequestMeta,
  SessionView,
} from '../application/auth.service';
import { RefreshTokenDto, RequestOtpDto, VerifyOtpDto } from './dto/auth.dto';

/**
 * Phone-OTP login.
 *
 * Two steps rather than one, because the second step is where the account is
 * resolved: a phone that has never logged in is registered on first successful
 * verify, so there is no separate signup endpoint to keep in sync.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  requestOtp(@Body() dto: RequestOtpDto): Promise<OtpRequestedView> {
    return this.auth.requestOtp(normalisePhone(dto.phone), dto.purpose ?? 'LOGIN');
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body() dto: VerifyOtpDto, @Req() request: Request): Promise<SessionView> {
    return this.auth.verifyOtp(normalisePhone(dto.phone), dto.code, requestMeta(request));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<SessionView> {
    return this.auth.refresh(dto.refreshToken, requestMeta(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Body() dto: RefreshTokenDto): Promise<{ revoked: boolean }> {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser): Promise<AuthProfileView> {
    return this.auth.profile(user.userId);
  }
}

/**
 * `9123 4567` / `+852 9123 4567` / `85291234567` → `+85291234567`.
 *
 * Normalising at the edge means every downstream comparison — the OTP hash, the
 * unique index on `users.phone` — sees one canonical form.
 */
function normalisePhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  const local = digits.startsWith('852') ? digits.slice(3) : digits;
  return `+852${local}`;
}

function requestMeta(request: Request): RequestMeta {
  return {
    // `x-forwarded-for` first: behind a proxy, `socket.remoteAddress` is the proxy.
    ip:
      (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      request.socket.remoteAddress ??
      null,
    userAgent: request.headers['user-agent'] ?? null,
  };
}
