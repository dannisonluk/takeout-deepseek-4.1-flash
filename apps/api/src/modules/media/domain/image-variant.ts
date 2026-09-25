/**
 * The derivatives the image pipeline produces.
 *
 * A TypeScript enum rather than a Postgres one: the variants are stored as keys
 * inside the `image_assets.variants` JSON column, so a database enum would
 * enforce nothing while needing a migration every time a size is added.
 *
 * The widths are NOT here — they are configuration (`MEDIA_*_WIDTH`), because
 * the right size for a phone list row is a product decision that should not
 * require a deploy. This file only names the slots.
 */
export enum ImageVariant {
  /** Menu list rows and the cart. */
  THUMB = 'THUMB',
  /** The merchant page and the order summary. */
  CARD = 'CARD',
  /** The item detail view. */
  FULL = 'FULL',
}

/** Fixed order, so a client can rely on it rather than on object key order. */
export const IMAGE_VARIANTS: readonly ImageVariant[] = [
  ImageVariant.THUMB,
  ImageVariant.CARD,
  ImageVariant.FULL,
];

export function isImageVariant(value: string): value is ImageVariant {
  return (IMAGE_VARIANTS as readonly string[]).includes(value.toUpperCase());
}
