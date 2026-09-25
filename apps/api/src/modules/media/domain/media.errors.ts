import { DomainError } from '@takeout/domain';

/** Codes line up with `DOMAIN_CODE_TO_STATUS` in the exception filter. */

/**
 * The upload is not an image sharp can read, is larger than the pixel ceiling,
 * or a derivative could not be encoded.
 *
 * 422, not 400: the request was well-formed — the bytes arrived, the content
 * type was one we accept — and it is the *content* that cannot be used. The
 * message carries sharp's own diagnosis, because "upload failed" tells the
 * merchant nothing and "not a valid WebP: the file is truncated" tells them to
 * re-export.
 */
export class ImageProcessingFailedError extends DomainError {
  constructor(readonly reason: string) {
    super('IMAGE_PROCESSING_FAILED', `圖片無法處理：${reason}`, { reason });
  }
}

/** The asset exists but is not READY, so there is nothing to serve. */
export class ImageAssetNotReadyError extends DomainError {
  constructor(
    readonly assetId: string,
    readonly status: string,
  ) {
    super('IMAGE_ASSET_NOT_READY', `圖片尚未處理完成（狀態：${status}）`, { assetId, status });
  }
}

export class ImageAssetNotFoundError extends DomainError {
  constructor(readonly assetId: string) {
    super('IMAGE_ASSET_NOT_FOUND', '找不到該圖片', { assetId });
  }
}

/**
 * No storage driver can accept a write.
 *
 * 503 rather than 500: the deployment is healthy and the request is fine — the
 * object store is the missing dependency, and retrying after an operator fixes
 * it is the right instruction.
 */
export class StorageUnavailableError extends DomainError {
  constructor(readonly detail: string) {
    super('STORAGE_UNAVAILABLE', `物件儲存不可用：${detail}`, { detail });
  }
}
