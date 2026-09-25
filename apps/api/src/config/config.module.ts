import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { AppConfig, configuration, validateEnv } from './configuration';

export const APP_CONFIG = Symbol('APP_CONFIG');

/**
 * Provides the frozen, validated `AppConfig` under a DI token.
 *
 * `@nestjs/config` is used only to load `.env` files into `process.env`; the
 * typed object is built by `configuration()` and validated once at boot, so
 * nothing downstream has to deal with `string | undefined`.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env', '../../.env'],
      cache: true,
    }),
  ],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => Object.freeze(configuration()),
    },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {
  constructor() {
    // Validate as soon as the module is instantiated — fail at boot, not on the
    // first request that happens to need a secret.
    validateEnv(configuration());
  }
}
