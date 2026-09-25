import { Inject, Injectable, Logger } from '@nestjs/common';
import { ImageVariant } from '../domain/image-variant';
import { encode as encodeBlurhash } from 'blurhash';
import sharp from 'sharp';
import { APP_CONFIG } from '../../../config/config.module';
import { AppConfig } from '../../../config/configuration';
import { ImageProcessingFailedError } from '../domain/media.errors';

/** One derivative, with its bytes still in memory so the caller decides where. */
export interface ProcessedVariant {
  readonly variant: ImageVariant;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly body: Buffer;
}

export interface ProcessedImage {
  /** Of the ORIGINAL, after EXIF orientation is applied. */
  readonly width: number;
  readonly height: number;
  /** The format sharp detected, not the one the client claimed. */
  readonly format: string;
  /** BlurHash placeholder, ~28 characters. */
  readonly blurhash: string;
  readonly variants: readonly ProcessedVariant[];
}

/** How wide the tiny image fed to the BlurHash encoder is. */
const BLURHASH_SAMPLE_WIDTH = 32;

/**
 * Turns an uploaded image into what the platform actually serves.
 *
 * Three properties this class exists to guarantee:
 *
 *  1. **The bytes we store are the bytes we encoded.** Every derivative is
 *     re-encoded through sharp rather than passed through, which strips EXIF
 *     (including GPS), normalises the colour profile, and means a file that
 *     merely *claims* to be a PNG cannot reach the CDN.
 *  2. **Nothing is trusted from the client.** The content type the uploader
 *     sent is used only to pick a rejection message; `sharp.metadata()` is what
 *     decides the format. A `.jpg` full of PHP is not an image and is refused
 *     here rather than stored.
 *  3. **The cost is bounded before the work starts.** `limitInputPixels` makes
 *     sharp refuse a decompression bomb at header-parse time, so a 5 MB upload
 *     cannot ask for 20 GB of memory.
 *
 * It is deliberately a *pure* function of the input bytes: no database, no
 * storage, no config beyond the widths. That is what lets it be tested with a
 * generated buffer and no fixtures, and what makes it safe to call from a
 * background re-derivation job later.
 */
@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** The three output sizes, in the order the pipeline produces them. */
  get variantWidths(): Readonly<Record<ImageVariant, number>> {
    const { thumb, card, full } = this.config.media.variantWidths;
    return { THUMB: thumb, CARD: card, FULL: full };
  }

  async process(input: Buffer): Promise<ProcessedImage> {
    if (input.length === 0) {
      throw new ImageProcessingFailedError('the upload was empty');
    }

    const pipeline = () =>
      sharp(input, {
        // Refuses a decompression bomb at header-parse time, before any pixel
        // buffer is allocated.
        limitInputPixels: this.config.media.maxPixels,
        // `error` rather than the default `warning`: a truncated JPEG decodes
        // to a grey rectangle, and storing that silently is worse than
        // rejecting the upload.
        failOn: 'error',
      });

    let metadata;
    try {
      metadata = await pipeline().metadata();
    } catch (error) {
      throw new ImageProcessingFailedError(describe(error));
    }

    if (!metadata.width || !metadata.height) {
      throw new ImageProcessingFailedError('the file has no readable pixel dimensions');
    }

    // EXIF orientation 5-8 rotate by 90°, so the displayed image has the
    // dimensions swapped. Reading `metadata.width` directly would store a
    // portrait photo as landscape and make every client letterbox it.
    const rotated = (metadata.orientation ?? 1) >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;

    const variants: ProcessedVariant[] = [];
    for (const [variant, targetWidth] of Object.entries(this.variantWidths) as Array<
      [ImageVariant, number]
    >) {
      try {
        const { data, info } = await pipeline()
          // `.rotate()` with no argument applies the EXIF orientation and then
          // drops the tag, so the stored pixels are the right way up.
          .rotate()
          .resize({
            width: targetWidth,
            // A 200px logo must not be upscaled into a blurry 1280px "full"
            // derivative — that is bytes for no information.
            withoutEnlargement: true,
            fit: 'inside',
          })
          .webp({ quality: this.config.media.webpQuality })
          .toBuffer({ resolveWithObject: true });

        variants.push({
          variant,
          width: info.width,
          height: info.height,
          bytes: data.length,
          body: data,
        });
      } catch (error) {
        throw new ImageProcessingFailedError(`${variant} derivative failed: ${describe(error)}`);
      }
    }

    const blurhash = await this.computeBlurhash(pipeline);

    this.logger.log(
      `processed ${width}x${height} ${metadata.format} -> ` +
        variants.map((entry) => `${entry.variant} ${entry.width}x${entry.height}`).join(', ') +
        ` (${variants.reduce((sum, entry) => sum + entry.bytes, 0)} bytes of derivatives)`,
    );

    return {
      width,
      height,
      format: metadata.format ?? 'unknown',
      blurhash,
      variants,
    };
  }

  /**
   * A BlurHash placeholder, or `''` when one cannot be computed.
   *
   * Never fatal: the hash is a progressive-enhancement nicety, and refusing an
   * otherwise-good upload because a placeholder failed would be the tail
   * wagging the dog. The failure is logged instead, and the caller stores null.
   */
  private async computeBlurhash(pipeline: () => sharp.Sharp): Promise<string> {
    try {
      const { data, info } = await pipeline()
        .rotate()
        // `ensureAlpha` is not optional: the encoder requires 4 bytes per
        // pixel and throws "Width and height must match the pixels array" for
        // the 3-channel buffer sharp produces by default. That message points
        // nowhere near the cause.
        .ensureAlpha()
        .resize({ width: BLURHASH_SAMPLE_WIDTH, fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });

      return encodeBlurhash(
        new Uint8ClampedArray(data),
        info.width,
        info.height,
        this.config.media.blurhashComponentsX,
        this.config.media.blurhashComponentsY,
      );
    } catch (error) {
      this.logger.warn(`BlurHash could not be computed: ${describe(error)}`);
      return '';
    }
  }
}

/** sharp's messages are precise; keep them, but never let them reach a client raw. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
