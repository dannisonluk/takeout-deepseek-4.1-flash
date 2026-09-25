import { Global, Logger, Module } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { OBJECT_STORAGE } from '../../common/tokens';
import { LocalStorageService } from './local-storage.service';
import { R2StorageService } from './r2-storage.service';
import { ObjectStoragePort } from './storage.port';

/**
 * Binds the `ObjectStoragePort` to a driver.
 *
 * Global for the same reason as `PrismaModule` and `RedisModule`: it is
 * infrastructure with exactly one implementation per process, and making every
 * feature module import it would add noise without adding a decision.
 *
 * Nothing else in the codebase may import `R2StorageService` or
 * `LocalStorageService` directly — media, merchant and menu code all depend on
 * the `ObjectStoragePort` interface, so swapping to S3 proper (or a fake in
 * tests) is a one-line change here.
 *
 * The driver is chosen by a **factory**, not `useClass`, for the same reason
 * `PricingModule` resolves its engine through one: a class binding cannot
 * depend on configuration, and `STORAGE_DRIVER=auto` has to mean something.
 */
const logger = new Logger('StorageModule');

export function selectStorage(config: AppConfig): ObjectStoragePort {
  const r2 = new R2StorageService(config);
  const local = new LocalStorageService(config);

  switch (config.storage.driver) {
    case 'r2':
      if (!r2.configured) {
        throw new Error(
          'STORAGE_DRIVER=r2 but R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET are not all set',
        );
      }
      logger.log(`object storage: r2 (bucket ${config.storage.bucket})`);
      return r2;

    case 'local':
      if (config.nodeEnv === 'production') {
        // A container's filesystem is ephemeral. Booting with local storage in
        // production would mean every image disappears on the next deploy, and
        // nothing would report it — the URLs would just start 404ing.
        throw new Error(
          'STORAGE_DRIVER=local is refused in production: a container filesystem is ephemeral',
        );
      }
      logger.warn(`object storage: local (${local.rootDir}) — not for production`);
      return local;

    default:
      if (r2.configured) {
        logger.log(`object storage: r2 (bucket ${config.storage.bucket})`);
        return r2;
      }
      if (config.nodeEnv === 'production') {
        throw new Error(
          'No object storage configured. Set R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET ' +
            'in production — the local driver is not an option there.',
        );
      }
      logger.warn(
        `object storage: local (${local.rootDir}) — R2 has no credentials, so images are written ` +
          'to disk. Uploads work; presigned direct-to-bucket uploads do not.',
      );
      return local;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: OBJECT_STORAGE,
      useFactory: (config: AppConfig): ObjectStoragePort => selectStorage(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class StorageModule {}
