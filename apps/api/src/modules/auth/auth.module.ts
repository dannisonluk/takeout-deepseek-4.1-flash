import { Module } from '@nestjs/common';
import { AuthService } from './application/auth.service';
import { TokenService } from './domain/token.service';
import { ConsoleOtpSender, OTP_SENDER } from './infrastructure/otp-sender.port';
import { AuthController } from './interface/auth.controller';

/**
 * Authentication.
 *
 * `TokenService` is exported because the WebSocket handshake and any future
 * service that mints tokens must sign them the same way the HTTP guard verifies
 * them — one implementation, no drift.
 */
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    // The only place the OTP transport is chosen. Swapping to a real SMS
    // provider is this one line.
    { provide: OTP_SENDER, useClass: ConsoleOtpSender },
  ],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
