import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImageVariant, isImageVariant } from './domain/image-variant';
import { IdGenerator } from '@takeout/domain';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Response } from 'express';
import { JwtAuthGuard, MerchantScopeGuard } from '../../common/auth/jwt-auth.guard';
import { AuthenticatedUser } from '../../common/auth/authenticated-user';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ID_GENERATOR, OBJECT_STORAGE } from '../../common/tokens';
import { APP_CONFIG } from '../../config/config.module';
import { AppConfig } from '../../config/configuration';
import { ALLOWED_IMAGE_TYPES } from '../../infrastructure/storage/r2-storage.service';
import { ObjectStoragePort } from '../../infrastructure/storage/storage.port';
import { ImageAssetService } from './application/image-asset.service';
import { ImageProcessorService } from './application/image-processor.service';
import {
  ImageAssetNotFoundError,
  ImageProcessingFailedError,
} from './domain/media.errors';
import { ImageAssetView } from './interface/media.view';

export enum MediaScope {
  MENU_ITEM = 'MENU_ITEM',
  MERCHANT_LOGO = 'MERCHANT_LOGO',
  MERCHANT_COVER = 'MERCHANT_COVER',
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/**
 * The shape multer hands us in memory.
 *
 * Declared locally rather than pulling in `@types/multer` for one interface —
 * and `Express.Multer.File` would drag Express's own augmentation into every
 * file that mentions it.
 */
interface UploadedImage {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

export class PresignUploadDto {
  @IsEnum(MediaScope)
  scope!: MediaScope;

  @IsInt()
  @Min(1)
  @Max(5 * 1024 * 1024, { message: 'Images are limited to 5 MB' })
  sizeBytes!: number;

  @IsOptional()
  @IsEnum(Object.fromEntries(ALLOWED_IMAGE_TYPES.map((type) => [type, type])))
  contentType?: string;
}

export class UploadImageDto {
  @IsEnum(MediaScope)
  scope!: MediaScope;
}

/**
 * Image upload and management.
 *
 * Two upload paths, and the difference is deliberate:
 *
 *  - **`POST presign`** — the production path. The API never proxies image
 *    bytes: it signs a short-lived PUT and the browser sends the file straight
 *    to the bucket. Cheapest by far for a large file, and it is what the
 *    merchant portal uses when object storage is configured.
 *  - **`POST /`** (multipart) — the API receives the bytes, runs the pipeline,
 *    and stores the original plus three derivatives itself. This is the path
 *    that works with no bucket at all, and the one that is exercised end to end
 *    in development.
 *
 * Both end up in the same `image_assets` row shape. The presign path leaves
 * `status` at PENDING because nothing has processed the object yet; the
 * multipart path returns READY with the derivatives attached.
 */
@Controller('merchant/:merchantId/images')
@UseGuards(JwtAuthGuard, MerchantScopeGuard)
export class MediaController {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    private readonly assets: ImageAssetService,
  ) {}

  @Post('presign')
  @HttpCode(HttpStatus.OK)
  async presign(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: PresignUploadDto,
  ) {
    const contentType = dto.contentType ?? 'image/webp';
    const objectKey = buildObjectKey(
      merchantId,
      dto.scope,
      this.idGenerator.next(),
      EXTENSION_BY_TYPE[contentType] ?? 'bin',
    );

    return this.storage.createPresignedUpload({ objectKey, contentType });
  }

  /**
   * Upload an image and get the processed asset back.
   *
   * The response is `READY` with three WebP derivatives and a BlurHash, because
   * the work is done before the response — there is no queue. That is the right
   * trade for a 5 MB image on a LAN-scale deployment: a queue would add a
   * broker, a worker and a polling UI to save a few hundred milliseconds.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Body() dto: UploadImageDto,
    @UploadedFile() file: UploadedImage | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ImageAssetView> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('file 欄位為必填（multipart/form-data）');
    }
    // The cheap check. sharp is authoritative about what the bytes actually
    // are; this only rejects a clearly-wrong upload before decoding it.
    if (!file.mimetype.startsWith('image/')) {
      throw new ImageProcessingFailedError(`不支援的檔案類型 ${file.mimetype}`);
    }

    return this.assets.ingest({
      merchantId,
      scope: dto.scope,
      createdById: user.userId,
      claimedContentType: file.mimetype,
      body: file.buffer,
    });
  }

  @Get()
  async list(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Query('limit') limit?: string,
  ): Promise<{ assets: ImageAssetView[]; storage: { driver: string; configured: boolean } }> {
    const parsed = Number.parseInt(limit ?? '', 10);
    return {
      assets: await this.assets.listForMerchant(merchantId, Number.isFinite(parsed) ? parsed : 60),
      // Reported so the portal can explain why an upload would fail, instead of
      // showing a generic error for a deployment with no bucket.
      storage: {
        driver: this.storage.configured ? 'object-storage' : 'unavailable',
        configured: this.storage.configured,
      },
    };
  }

  @Get(':assetId')
  async detail(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
  ): Promise<ImageAssetView> {
    return this.assets.findForMerchant(merchantId, assetId);
  }

  @Delete(':assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('merchantId', new ParseUUIDPipe()) merchantId: string,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
  ): Promise<void> {
    await this.assets.remove(merchantId, assetId);
  }
}

/**
 * Serves stored images.
 *
 * Unauthenticated, and that is not a leak: an image the platform shows to every
 * customer is public by definition, and the asset id is a random UUID. The
 * alternative — signing every derivative URL — buys nothing while making the
 * `<img src>` in a menu list impossible.
 *
 * With a CDN configured the request is a 302 to it, so bytes never travel
 * through the API in production. Without one the API streams the object, which
 * is what makes a local run show real images.
 */
@Controller('media')
export class MediaServeController {
  private readonly logger = new Logger(MediaServeController.name);

  constructor(
    private readonly assets: ImageAssetService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get(':assetId/:variant')
  async serveVariant(
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Param('variant') variant: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.send(response, await this.assets.resolveForServing(assetId, parseVariant(variant)));
  }

  @Get(':assetId')
  async serveOriginal(
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.send(response, await this.assets.resolveForServing(assetId, null));
  }

  private async send(
    response: Response,
    resolved: { key: string; contentType: string; publicUrl: string | null },
  ): Promise<void> {
    if (resolved.publicUrl && this.config.storage.publicBaseUrl) {
      response.redirect(HttpStatus.FOUND, resolved.publicUrl);
      return;
    }

    const object = await this.storage.getObject(resolved.key);
    if (!object) throw new ImageAssetNotFoundError(resolved.key);

    // `res.end` rather than `res.send`: Express rewrites the Content-Type on
    // `send` and appends its own charset, which is exactly the trap the metrics
    // controller hit. `end` writes the headers we set, byte for byte.
    response.setHeader('Content-Type', resolved.contentType);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('Content-Length', String(object.body.length));
    response.end(object.body);
  }
}

/** `thumb` / `card` / `full`, case-insensitive. Anything else is a 404. */
function parseVariant(value: string): ImageVariant {
  const upper = value.toUpperCase();
  // `isImageVariant` is the single source of truth for the vocabulary; listing
  // the members here again is how a newly added variant 404s in production
  // while the rest of the pipeline happily writes it.
  if (isImageVariant(upper)) return upper as ImageVariant;
  throw new ImageAssetNotFoundError(`variant ${value}`);
}

function buildObjectKey(
  merchantId: string,
  scope: MediaScope,
  id: string,
  extension: string,
): string {
  switch (scope) {
    case MediaScope.MENU_ITEM:
      return `merchants/${merchantId}/items/${id}.${extension}`;
    case MediaScope.MERCHANT_LOGO:
      return `merchants/${merchantId}/branding/logo-${id}.${extension}`;
    case MediaScope.MERCHANT_COVER:
      return `merchants/${merchantId}/branding/cover-${id}.${extension}`;
  }
}

@Module({
  imports: [
    // `registerAsync` rather than `register`: the size limit is configuration,
    // and a decorator cannot read it. Without the limit multer buffers an
    // unbounded body into memory before any handler sees it.
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        limits: { fileSize: config.storage.maxUploadBytes, files: 1 },
      }),
    }),
  ],
  controllers: [MediaController, MediaServeController],
  providers: [ImageProcessorService, ImageAssetService],
  exports: [ImageProcessorService, ImageAssetService],
})
export class MediaModule {}
