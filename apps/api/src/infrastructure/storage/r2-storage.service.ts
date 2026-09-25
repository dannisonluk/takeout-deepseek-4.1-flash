import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ObjectStoragePort, PresignedUpload, StoredObject } from './storage.port';

/** Content types the presign endpoint will issue a signature for. */
export const ALLOWED_IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'] as const;

@Injectable()
export class R2StorageService implements ObjectStoragePort {
  private readonly client: S3Client;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = new S3Client({
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      // R2 requires path-style addressing.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
    });
  }

  /**
   * All three, not just the keys. A bucket name with no credentials produces an
   * SDK authentication error on every upload — which reads as a bug in the
   * media module rather than a missing secret.
   */
  get configured(): boolean {
    return Boolean(
      this.config.storage.accessKeyId && this.config.storage.secretAccessKey && this.config.storage.bucket,
    );
  }

  async putObject(params: {
    objectKey: string;
    body: Buffer;
    contentType: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.storage.bucket,
        Key: params.objectKey,
        Body: params.body,
        ContentType: params.contentType,
        // Derivatives are content-addressed by the original's checksum, so the
        // same key always holds the same bytes. Immutable caching is therefore
        // safe, and it is what makes the CDN worth having.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
  }

  async getObject(objectKey: string): Promise<StoredObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.storage.bucket, Key: objectKey }),
      );
      if (!response.Body) return null;

      // The SDK's stream mixin. `transformToByteArray` is the documented way to
      // get a Buffer without hand-piping the stream, and it is what avoids the
      // classic "the response ended before the body was consumed" bug.
      const body = Buffer.from(await response.Body.transformToByteArray());
      return {
        body,
        contentType: response.ContentType ?? 'application/octet-stream',
        sizeBytes: response.ContentLength ?? body.length,
      };
    } catch (error) {
      // A missing object is a normal outcome, not an exception the caller has to
      // know about — the pipeline treats `null` as "nothing to re-derive".
      const name = (error as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw error;
    }
  }

  async createPresignedUpload(params: {
    objectKey: string;
    contentType: string;
    expiresInSeconds?: number;
  }): Promise<PresignedUpload> {
    if (!ALLOWED_IMAGE_TYPES.includes(params.contentType as (typeof ALLOWED_IMAGE_TYPES)[number])) {
      throw new Error(
        `Unsupported content type ${params.contentType}. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`,
      );
    }

    const expiresInSeconds = params.expiresInSeconds ?? this.config.storage.presignTtlSeconds;

    const command = new PutObjectCommand({
      Bucket: this.config.storage.bucket,
      Key: params.objectKey,
      ContentType: params.contentType,
      // Enforced server-side by the signature — a client cannot upload 50 MB
      // by lying about the size.
      ContentLength: this.config.storage.maxUploadBytes,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });

    return {
      uploadUrl,
      objectKey: params.objectKey,
      expiresInSeconds,
      maxSizeBytes: this.config.storage.maxUploadBytes,
      requiredHeaders: { 'Content-Type': params.contentType },
    };
  }

  buildPublicUrl(objectKey: string | null): string | null {
    if (!objectKey) return null;
    const base = this.config.storage.publicBaseUrl.replace(/\/$/, '');
    return `${base}/${objectKey.replace(/^\//, '')}`;
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.storage.bucket, Key: objectKey }),
    );
  }
}
