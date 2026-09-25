-- CreateEnum
CREATE TYPE "ImageVariant" AS ENUM ('THUMB', 'CARD', 'FULL');

-- CreateEnum
CREATE TYPE "ImageAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "image_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "scope" VARCHAR(24) NOT NULL,
    "originalKey" VARCHAR(512) NOT NULL,
    "contentType" VARCHAR(64) NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "blurhash" VARCHAR(64),
    "variants" JSONB,
    "status" "ImageAssetStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "image_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_assets_merchantId_scope_createdAt_idx" ON "image_assets"("merchantId", "scope", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "image_assets_status_createdAt_idx" ON "image_assets"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "image_assets_merchantId_checksum_key" ON "image_assets"("merchantId", "checksum");

-- AddForeignKey
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_assets" ADD CONSTRAINT "image_assets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
