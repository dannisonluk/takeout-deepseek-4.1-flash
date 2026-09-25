import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ObjectStoragePort, PresignedUpload, StoredObject } from './storage.port';

/**
 * Filesystem object storage, for a machine that has no bucket.
 *
 * Exists because every media route used to fail on a fresh clone: R2 has no
 * credentials in `.env`, so `createPresignedUpload` threw an SDK authentication
 * error and the upload UI was untestable without a Cloudflare account. That is
 * the difference between "the media pipeline is implemented" and "the media
 * pipeline is implemented and you can watch it work".
 *
 * Two things it deliberately does **not** do:
 *
 *  1. **It never signs anything.** `createPresignedUpload` throws. A local
 *     filesystem has no signing authority, and inventing a signed-URL
 *     emulation would mean shipping an unauthenticated write endpoint — one
 *     that a `NODE_ENV` slip could expose. The multipart upload route is the
 *     supported path locally, and it goes through the same processor and the
 *     same table as production.
 *  2. **It is never selected in production.** `StorageModule` refuses to bind
 *     it when `NODE_ENV=production`, so a missing bucket credential is a boot
 *     failure rather than a deployment that quietly writes images to the
 *     container's ephemeral disk and loses them on the next deploy.
 */
@Injectable()
export class LocalStorageService implements ObjectStoragePort {
  private readonly logger = new Logger(LocalStorageService.name);
  private readonly root: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.storage.localDir);
  }

  readonly configured = true;

  /** Where the objects live. Logged at boot so nobody has to guess. */
  get rootDir(): string {
    return this.root;
  }

  createPresignedUpload(): Promise<PresignedUpload> {
    // Synchronous refusal wrapped in a rejected promise: the port is async, and
    // a caller that awaits gets a clear reason instead of an unhandled throw.
    return Promise.reject(
      new Error(
        'Presigned uploads require object storage (R2). Locally, upload through ' +
          'POST /v1/merchant/:merchantId/images instead — it runs the same image pipeline.',
      ),
    );
  }

  async putObject(params: {
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    const target = this.resolveKey(params.objectKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, params.body);
    this.logger.log(`stored ${params.objectKey} (${params.body.length} bytes)`);
  }

  async getObject(objectKey: string): Promise<StoredObject | null> {
    const target = this.resolveKey(objectKey);
    if (!existsSync(target)) return null;

    const [body, info] = await Promise.all([readFile(target), stat(target)]);
    return { body, contentType: contentTypeFor(objectKey), sizeBytes: info.size };
  }

  buildPublicUrl(objectKey: string | null): string | null {
    if (!objectKey) return null;
    return `${this.publicBaseUrl()}/${objectKey.replace(/^\//, '')}`;
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.resolveKey(objectKey), { force: true });
  }

  /** Base the API serves local objects from. Derived from PORT when unset. */
  private publicBaseUrl(): string {
    const configured = this.config.storage.localPublicBaseUrl.replace(/\/$/, '');
    if (configured) return configured;
    return `http://127.0.0.1:${this.config.port}/${this.config.apiPrefix}/media`;
  }

  /**
   * Map an object key to a path, refusing anything that escapes the root.
   *
   * `objectKey` reaches this method from a URL and from the database, so
   * `../../etc/passwd` has to be a rejection rather than a file read. The
   * containment check is done on the *resolved* path, after normalisation, so
   * it cannot be bypassed by a key that only looks harmless.
   */
  private resolveKey(objectKey: string): string {
    const target = resolve(join(this.root, normalize(objectKey)));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`Object key escapes the storage root: ${objectKey}`);
    }
    return target;
  }
}

/** Deterministic content type from the extension, so a served object is typed. */
export function contentTypeFor(objectKey: string): string {
  const extension = objectKey.slice(objectKey.lastIndexOf('.') + 1).toLowerCase();
  switch (extension) {
    case 'webp':
      return 'image/webp';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

/** Stable, filesystem-safe name for an uploaded original. */
export function originalObjectKey(
  merchantId: string,
  scope: string,
  checksum: string,
  extension: string,
): string {
  return `merchants/${merchantId}/${scope.toLowerCase()}/${checksum.slice(0, 16)}-${randomUUID()}.${extension}`;
}

/** Stable name for a derivative. Deterministic on the checksum, so re-deriving is a no-op. */
export function variantObjectKey(
  merchantId: string,
  scope: string,
  checksum: string,
  variant: string,
): string {
  return `merchants/${merchantId}/${scope.toLowerCase()}/${checksum.slice(0, 16)}-${variant.toLowerCase()}.webp`;
}

export function checksumOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}
