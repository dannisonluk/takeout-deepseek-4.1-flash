import { Inject, Injectable, Logger } from '@nestjs/common';
import { ImageAssetStatus } from '@prisma/client';
import { ImageVariant } from '../domain/image-variant';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { OBJECT_STORAGE } from '../../../common/tokens';
import {
  checksumOf,
  contentTypeFor,
  originalObjectKey,
  variantObjectKey,
} from '../../../infrastructure/storage/local-storage.service';
import { ObjectStoragePort } from '../../../infrastructure/storage/storage.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  ImageAssetNotFoundError,
  ImageAssetNotReadyError,
  ImageProcessingFailedError,
  StorageUnavailableError,
} from '../domain/media.errors';
import { ImageProcessorService } from './image-processor.service';
import {
  ImageAssetView,
  ImageVariantView,
  StoredVariants,
  VARIANT_ORDER,
  readStoredVariants,
} from '../interface/media.view';

export interface IngestImageParams {
  readonly merchantId: string;
  readonly scope: string;
  readonly createdById: string | null;
  /** The claimed content type. Recorded only if sharp agrees it is an image. */
  readonly claimedContentType: string;
  readonly body: Buffer;
}

/** MIME type for a format sharp reported. */
function mimeForFormat(format: string): string {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'gif':
      return 'image/gif';
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

/**
 * The image pipeline's orchestration: one row, one original, three derivatives.
 *
 * Three rules it enforces:
 *
 *  1. **Record before touching the bytes.** A `PENDING` row is written first, so
 *     a process that dies mid-decode leaves something an operator can find. The
 *     row then becomes `READY` or `FAILED` — never deleted, because "this upload
 *     failed and here is why" is the answer to the only question a merchant
 *     asks about a missing image.
 *  2. **The same bytes are stored once.** `(merchantId, checksum)` is unique, so
 *     re-uploading a file — a retry after a timeout, a merchant clicking twice —
 *     returns the existing asset instead of a second copy with a second key.
 *  3. **A failure is not a silent gap.** Every path that can fail updates the
 *     row before throwing, which is what stops "the merchant says the image
 *     vanished" from being unanswerable.
 */
@Injectable()
export class ImageAssetService {
  private readonly logger = new Logger(ImageAssetService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    private readonly processor: ImageProcessorService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async ingest(params: IngestImageParams): Promise<ImageAssetView> {
    if (!this.storage.configured) {
      throw new StorageUnavailableError('no object storage driver is configured');
    }

    const checksum = checksumOf(params.body);

    // Already processed? Return it. This is the normal case for a retried
    // upload, and it is why a duplicate click does not cost a second decode.
    const existing = await this.prisma.imageAsset.findUnique({
      where: { merchantId_checksum: { merchantId: params.merchantId, checksum } },
    });
    if (existing && existing.status === 'READY') return this.toView(existing);

    const extension = extensionFor(params.claimedContentType);
    const originalKey = originalObjectKey(params.merchantId, params.scope, checksum, extension);

    // Step 1: durable, before anything expensive. `upsert` on the unique key so
    // a previous FAILED attempt for the same bytes is retried rather than
    // colliding.
    const asset = await this.prisma.imageAsset.upsert({
      where: { merchantId_checksum: { merchantId: params.merchantId, checksum } },
      create: {
        merchantId: params.merchantId,
        scope: params.scope,
        originalKey,
        contentType: params.claimedContentType,
        sizeBytes: params.body.length,
        checksum,
        status: ImageAssetStatus.PENDING,
        createdById: params.createdById,
      },
      update: {
        status: ImageAssetStatus.PENDING,
        failureReason: null,
        scope: params.scope,
        createdById: params.createdById,
      },
      select: { id: true },
    });

    // Step 2: decode and encode. Pure, no I/O.
    let processed;
    try {
      processed = await this.processor.process(params.body);
    } catch (error) {
      await this.markFailed(asset.id, error instanceof Error ? error.message : String(error));
      throw error;
    }

    // Step 3: store. Anything that fails here leaves a FAILED row too — a
    // derivative that never reached the bucket is not a READY asset.
    const stored: StoredVariants = {};
    try {
      await this.storage.putObject({
        objectKey: originalKey,
        body: params.body,
        // The DETECTED type, not the claimed one. A file that merely says it is
        // a PNG should not be served as one.
        contentType: mimeForFormat(processed.format),
      });

      for (const variant of processed.variants) {
        const key = variantObjectKey(params.merchantId, params.scope, checksum, variant.variant);
        await this.storage.putObject({
          objectKey: key,
          body: variant.body,
          contentType: 'image/webp',
        });
        stored[variant.variant] = {
          key,
          width: variant.width,
          height: variant.height,
          bytes: variant.bytes,
        };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.markFailed(asset.id, `storing derivatives failed: ${reason}`);
      throw new StorageUnavailableError(reason);
    }

    const ready = await this.prisma.imageAsset.update({
      where: { id: asset.id },
      data: {
        status: ImageAssetStatus.READY,
        contentType: mimeForFormat(processed.format),
        width: processed.width,
        height: processed.height,
        // Null rather than '' when the placeholder could not be computed: an
        // empty string is a placeholder a client would try to render.
        blurhash: processed.blurhash || null,
        variants: stored as object,
        failureReason: null,
      },
    });

    this.logger.log(
      `asset ${ready.id}: ${ready.scope} for merchant ${ready.merchantId}, ` +
        `${Object.keys(stored).length} derivatives`,
    );

    return this.toView(ready);
  }

  /** A merchant's own images, newest first. */
  async listForMerchant(merchantId: string, limit = 60): Promise<ImageAssetView[]> {
    const rows = await this.prisma.imageAsset.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((row) => this.toView(row));
  }

  /**
   * Scoped by merchant on purpose: an id alone must not let one merchant read
   * another's asset, and the 404 does not distinguish "not yours" from "does
   * not exist".
   */
  async findForMerchant(merchantId: string, assetId: string): Promise<ImageAssetView> {
    const row = await this.prisma.imageAsset.findFirst({ where: { id: assetId, merchantId } });
    if (!row) throw new ImageAssetNotFoundError(assetId);
    return this.toView(row);
  }

  async remove(merchantId: string, assetId: string): Promise<void> {
    const row = await this.prisma.imageAsset.findFirst({
      where: { id: assetId, merchantId },
      select: { id: true, originalKey: true, variants: true },
    });
    if (!row) throw new ImageAssetNotFoundError(assetId);

    // Objects first, then the row. The other order leaves orphaned bytes with
    // nothing pointing at them, which is a storage leak nobody can find.
    const variants = readStoredVariants(row.variants);
    for (const key of [row.originalKey, ...VARIANT_ORDER.map((v) => variants[v]?.key)]) {
      if (!key) continue;
      try {
        await this.storage.delete(key);
      } catch (error) {
        // A missing object is fine; a driver error is logged and the row still
        // goes, because a row pointing at deleted bytes is worse than a byte
        // nobody points at.
        this.logger.warn(`could not delete ${key}: ${String(error)}`);
      }
    }

    await this.prisma.imageAsset.delete({ where: { id: row.id } });
  }

  /**
   * The bytes (or the CDN URL) for one variant of one asset.
   *
   * `variant` of `null` means the original. Only READY assets resolve — serving
   * a PENDING one would hand out half-written bytes, and serving a FAILED one
   * would hand out the bytes of something we could not decode.
   */
  async resolveForServing(
    assetId: string,
    variant: ImageVariant | null,
  ): Promise<{ key: string; contentType: string; publicUrl: string | null }> {
    const row = await this.prisma.imageAsset.findUnique({
      where: { id: assetId },
      select: { status: true, originalKey: true, contentType: true, variants: true },
    });
    if (!row) throw new ImageAssetNotFoundError(assetId);
    if (row.status !== 'READY') throw new ImageAssetNotReadyError(assetId, row.status);

    const key = variant ? readStoredVariants(row.variants)[variant]?.key : row.originalKey;
    if (!key) throw new ImageAssetNotFoundError(`${assetId}/${variant ?? 'original'}`);

    return {
      key,
      // A derivative is always WebP; the original is whatever sharp detected.
      contentType: variant ? 'image/webp' : row.contentType || contentTypeFor(key),
      publicUrl: this.storage.buildPublicUrl(key),
    };
  }

  private async markFailed(assetId: string, reason: string): Promise<void> {
    this.logger.error(`asset ${assetId} failed: ${reason}`);
    await this.prisma.imageAsset.update({
      where: { id: assetId },
      data: { status: ImageAssetStatus.FAILED, failureReason: reason.slice(0, 2000) },
    });
  }

  private toView(row: {
    id: string;
    merchantId: string;
    scope: string;
    status: ImageAssetStatus;
    contentType: string;
    sizeBytes: number;
    checksum: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    originalKey: string;
    variants: unknown;
    failureReason: string | null;
    createdAt: Date;
  }): ImageAssetView {
    const stored = readStoredVariants(row.variants);

    const variants: ImageVariantView[] = VARIANT_ORDER.flatMap((variant) => {
      const entry = stored[variant];
      if (!entry) return [];
      return [
        {
          variant,
          key: entry.key,
          url: this.storage.buildPublicUrl(entry.key),
          width: entry.width,
          height: entry.height,
          bytes: entry.bytes,
        },
      ];
    });

    return {
      id: row.id,
      merchantId: row.merchantId,
      scope: row.scope,
      status: row.status,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      checksum: row.checksum,
      width: row.width,
      height: row.height,
      blurhash: row.blurhash,
      originalKey: row.originalKey,
      originalUrl: this.storage.buildPublicUrl(row.originalKey),
      variants,
      failureReason: row.failureReason,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    default:
      return 'bin';
  }
}
