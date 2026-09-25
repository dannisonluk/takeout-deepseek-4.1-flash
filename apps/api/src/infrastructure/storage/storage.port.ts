/**
 * Object storage port (Cloudflare R2, S3-compatible).
 *
 * The database stores only `objectKey` — never a public URL. That keeps the
 * bucket and CDN domain swappable without a data migration, and lets a
 * signed-URL strategy replace a public bucket later.
 */
export interface PresignedUpload {
  readonly uploadUrl: string;
  readonly objectKey: string;
  readonly expiresInSeconds: number;
  readonly maxSizeBytes: number;
  /** Headers the client MUST send with the PUT for the signature to match. */
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string;
  readonly sizeBytes: number;
}

export interface ObjectStoragePort {
  /**
   * Whether this driver can actually store anything.
   *
   * `false` for R2 with no credentials. The media module reports it rather than
   * failing every upload with an SDK authentication error, and it is what lets
   * the local driver be selected automatically on a developer machine.
   */
  readonly configured: boolean;

  createPresignedUpload(params: {
    readonly objectKey: string;
    readonly contentType: string;
    readonly expiresInSeconds?: number;
  }): Promise<PresignedUpload>;

  /** Server-side write. The image pipeline uses this; clients use the presign. */
  putObject(params: {
    readonly objectKey: string;
    readonly body: Buffer;
    readonly contentType: string;
  }): Promise<void>;

  /** Server-side read, for re-deriving variants or serving through the API. */
  getObject(objectKey: string): Promise<StoredObject | null>;

  /** CDN URL for a stored key, or `null` when the key is empty. */
  buildPublicUrl(objectKey: string | null): string | null;

  delete(objectKey: string): Promise<void>;
}
