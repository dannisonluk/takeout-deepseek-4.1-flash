import { ImageAssetStatus } from '@prisma/client';
import { IMAGE_VARIANTS, ImageVariant } from '../domain/image-variant';

/** One derivative, as the client needs it. */
export interface ImageVariantView {
  readonly variant: ImageVariant;
  /** The storage key. What the database keeps. */
  readonly key: string;
  /** Where to fetch it. Null only when no driver can build a URL. */
  readonly url: string | null;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export interface ImageAssetView {
  readonly id: string;
  readonly merchantId: string;
  /** `MENU_ITEM` | `MERCHANT_LOGO` | `MERCHANT_COVER`. */
  readonly scope: string;
  readonly status: ImageAssetStatus;
  /** The format sharp detected — not the one the client claimed. */
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Render this as a blurred rectangle while `variants` load. */
  readonly blurhash: string | null;
  readonly originalKey: string;
  readonly originalUrl: string | null;
  /** Ordered THUMB, CARD, FULL. Empty unless `status` is READY. */
  readonly variants: readonly ImageVariantView[];
  readonly failureReason: string | null;
  readonly createdAt: string;
}

/** The shape stored in `image_assets.variants`, before URLs are attached. */
export interface StoredVariant {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

export type StoredVariants = Partial<Record<ImageVariant, StoredVariant>>;

/**
 * Fixed order, so a client can rely on it rather than on object key order.
 *
 * Aliased to the domain constant rather than re-listed: a second literal array
 * is how a new variant silently goes missing from one of the two.
 */
export const VARIANT_ORDER: readonly ImageVariant[] = IMAGE_VARIANTS;

/**
 * `variants` is `Json`, so it is `unknown` until checked.
 *
 * A row written by an older pipeline version, or half-written by a crash, must
 * not take down the whole list — an asset with an unreadable `variants` column
 * renders as an asset with no derivatives.
 */
export function readStoredVariants(raw: unknown): StoredVariants {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: StoredVariants = {};

  for (const variant of VARIANT_ORDER) {
    const entry = source[variant];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    if (typeof value.key !== 'string' || !value.key) continue;

    out[variant] = {
      key: value.key,
      width: Number(value.width ?? 0),
      height: Number(value.height ?? 0),
      bytes: Number(value.bytes ?? 0),
    };
  }

  return out;
}
