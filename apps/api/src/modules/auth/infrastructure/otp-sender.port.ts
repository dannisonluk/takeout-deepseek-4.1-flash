import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';

/** Injection token — application code depends on the port, never the adapter. */
export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * Where a login code goes.
 *
 * The platform has no SMS contract yet, so the default implementation writes
 * the code to the log and (outside production) lets the API echo it back so the
 * web app can pre-fill it. That keeps the login flow genuinely walkable in
 * development without pretending a message was delivered.
 *
 * Swapping in a real provider is one `useClass` in `AuthModule` — nothing in the
 * application layer knows how a code travels.
 */
export interface OtpSenderPort {
  send(
    phone: string,
    code: string,
    purpose: string,
  ): Promise<{ delivered: boolean; channel: string }>;

  /**
   * Whether the code may be returned in the API response.
   *
   * Part of the port rather than a guess at the concrete class, so the decision
   * lives with the adapter that actually knows its own delivery guarantee.
   */
  readonly exposesCode: boolean;
}

@Injectable()
export class ConsoleOtpSender implements OtpSenderPort {
  private readonly logger = new Logger(ConsoleOtpSender.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get exposesCode(): boolean {
    return this.config.nodeEnv !== 'production';
  }

  async send(
    phone: string,
    code: string,
    purpose: string,
  ): Promise<{ delivered: boolean; channel: string }> {
    // Logged in every environment: an operator with log access must be able to
    // complete a login for a user who cannot receive SMS.
    this.logger.log(`[OTP] ${purpose} code for ${phone} is ${code}`);

    return { delivered: false, channel: 'console' };
  }
}
