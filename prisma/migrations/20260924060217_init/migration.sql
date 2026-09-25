-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('CUSTOMER', 'MERCHANT_OWNER', 'MERCHANT_STAFF', 'RIDER', 'ADMIN');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "MenuItemAvailability" AS ENUM ('AVAILABLE', 'SOLD_OUT', 'HIDDEN');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'COMPLETED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderActorType" AS ENUM ('CUSTOMER', 'MERCHANT', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "FulfilmentMode" AS ENUM ('SELF_PICKUP', 'PLATFORM_FLEET', 'MERCHANT_FLEET');

-- CreateEnum
CREATE TYPE "PriorityLevel" AS ENUM ('NORMAL', 'EXPRESS');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'PAYME', 'OCTOPUS', 'FPS_QR', 'APPLE_PAY', 'GOOGLE_PAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "DriverStatus" AS ENUM ('OFFLINE', 'ONLINE_IDLE', 'ON_DELIVERY', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "IdentityVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryVehicle" AS ENUM ('MOTORCYCLE', 'BICYCLE', 'ON_FOOT');

-- CreateEnum
CREATE TYPE "DeliveryTaskStatus" AS ENUM ('OFFERED', 'ASSIGNED', 'PICKED_UP', 'DELIVERED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(32),
    "email" VARCHAR(255),
    "displayName" VARCHAR(120) NOT NULL,
    "avatarKey" VARCHAR(512),
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "locale" VARCHAR(16) NOT NULL DEFAULT 'zh-HK',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customerId" UUID NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "addressLine" VARCHAR(255) NOT NULL,
    "district" VARCHAR(80),
    "region" VARCHAR(40) NOT NULL DEFAULT 'HK',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerId" UUID NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "nameEn" VARCHAR(160),
    "description" TEXT,
    "phone" VARCHAR(32),
    "logoKey" VARCHAR(512),
    "coverImageKey" VARCHAR(512),
    "status" "MerchantStatus" NOT NULL DEFAULT 'DRAFT',
    "addressLine1" VARCHAR(255) NOT NULL,
    "addressLine2" VARCHAR(255),
    "district" VARCHAR(80),
    "region" VARCHAR(40) NOT NULL DEFAULT 'HK',
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "prepTimeMinutes" INTEGER NOT NULL DEFAULT 15,
    "pickupWindowMinutes" INTEGER NOT NULL DEFAULT 60,
    "acceptsOrders" BOOLEAN NOT NULL DEFAULT true,
    "autoAcceptOrders" BOOLEAN NOT NULL DEFAULT false,
    "acceptTimeoutMinutes" INTEGER NOT NULL DEFAULT 5,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Hong_Kong',
    "ratingAvg" DECIMAL(3,2),
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_staff" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "isManager" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_operating_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "opensAtMinute" INTEGER NOT NULL,
    "closesAtMinute" INTEGER NOT NULL,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "merchant_operating_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "nameEn" VARCHAR(120),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "categoryId" UUID,
    "name" VARCHAR(160) NOT NULL,
    "nameEn" VARCHAR(160),
    "description" TEXT,
    "imageKey" VARCHAR(512),
    "imageBlurhash" VARCHAR(120),
    "priceMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'HKD',
    "isMainItem" BOOLEAN NOT NULL DEFAULT false,
    "availability" "MenuItemAvailability" NOT NULL DEFAULT 'AVAILABLE',
    "dailyQuota" INTEGER,
    "prepTimeMinutes" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_daily_stock" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "menuItemId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "serviceDate" DATE NOT NULL,
    "quota" INTEGER NOT NULL DEFAULT 0,
    "sold" INTEGER NOT NULL DEFAULT 0,
    "held" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "menu_item_daily_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderNo" VARCHAR(24) NOT NULL,
    "pickupCode" VARCHAR(8),
    "customerId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "fulfilmentMode" "FulfilmentMode" NOT NULL DEFAULT 'SELF_PICKUP',
    "priority" "PriorityLevel" NOT NULL DEFAULT 'NORMAL',
    "scheduledPickupAt" TIMESTAMPTZ(3),
    "serviceDate" DATE NOT NULL,
    "prepTimeMinutes" INTEGER NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "readyAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "acceptDeadlineAt" TIMESTAMPTZ(3),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'HKD',
    "subtotalMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "paymentFeeMinor" INTEGER NOT NULL,
    "customerServiceFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL,
    "merchantPayoutMinor" INTEGER NOT NULL,
    "mainItemCount" INTEGER NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "customerNote" TEXT,
    "contactPhone" VARCHAR(32),
    "deliveryTaskId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "menuItemId" UUID,
    "nameSnapshot" VARCHAR(160) NOT NULL,
    "imageKeySnapshot" VARCHAR(512),
    "unitPriceMinor" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    "isMainItem" BOOLEAN NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actor" "OrderActorType" NOT NULL,
    "actorId" UUID,
    "reason" TEXT,
    "sideEffects" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "idempotencyKey" VARCHAR(120) NOT NULL,
    "providerRef" VARCHAR(160),
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'HKD',
    "amountMinor" INTEGER NOT NULL,
    "processingFeeMinor" INTEGER NOT NULL DEFAULT 0,
    "failureCode" VARCHAR(80),
    "failureMessage" TEXT,
    "authorizedAt" TIMESTAMPTZ(3),
    "capturedAt" TIMESTAMPTZ(3),
    "rawPayload" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paymentId" UUID NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" VARCHAR(160),
    "requestedBy" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMPTZ(3),

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_payouts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "grossSubtotalMinor" BIGINT NOT NULL,
    "platformFeeMinor" BIGINT NOT NULL,
    "paymentFeeMinor" BIGINT NOT NULL,
    "netPayoutMinor" BIGINT NOT NULL,
    "orderCount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'HKD',
    "reference" VARCHAR(120),
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_payout_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "payoutId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "subtotalMinor" INTEGER NOT NULL,
    "platformFeeMinor" INTEGER NOT NULL,
    "paymentFeeMinor" INTEGER NOT NULL,
    "merchantPayoutMinor" INTEGER NOT NULL,

    CONSTRAINT "merchant_payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_config" (
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "aggregateType" VARCHAR(60) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" VARCHAR(120) NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "vehicle" "DeliveryVehicle" NOT NULL DEFAULT 'MOTORCYCLE',
    "status" "DriverStatus" NOT NULL DEFAULT 'OFFLINE',
    "verification" "IdentityVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "documentKey" VARCHAR(512),
    "verifiedAt" TIMESTAMPTZ(3),
    "maxConcurrentTasks" INTEGER NOT NULL DEFAULT 3,
    "acceptanceRate" DECIMAL(4,3) NOT NULL DEFAULT 1.0,
    "completedTaskCount" INTEGER NOT NULL DEFAULT 0,
    "allowedMerchantIds" UUID[],
    "onlineSince" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "riderId" UUID,
    "mode" "FulfilmentMode" NOT NULL DEFAULT 'PLATFORM_FLEET',
    "status" "DeliveryTaskStatus" NOT NULL DEFAULT 'OFFERED',
    "pickupLatitude" DOUBLE PRECISION NOT NULL,
    "pickupLongitude" DOUBLE PRECISION NOT NULL,
    "dropoffLatitude" DOUBLE PRECISION NOT NULL,
    "dropoffLongitude" DOUBLE PRECISION NOT NULL,
    "estimatedDistanceKm" DOUBLE PRECISION,
    "etaMinutes" INTEGER,
    "assignedAt" TIMESTAMPTZ(3),
    "pickedUpAt" TIMESTAMPTZ(3),
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "delivery_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_isActive_idx" ON "users"("role", "isActive");

-- CreateIndex
CREATE INDEX "users_createdAt_idx" ON "users"("createdAt");

-- CreateIndex
CREATE INDEX "customer_addresses_customerId_idx" ON "customer_addresses"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");

-- CreateIndex
CREATE INDEX "merchants_status_acceptsOrders_idx" ON "merchants"("status", "acceptsOrders");

-- CreateIndex
CREATE INDEX "merchants_district_status_idx" ON "merchants"("district", "status");

-- CreateIndex
CREATE INDEX "merchants_name_idx" ON "merchants" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "merchant_staff_userId_idx" ON "merchant_staff"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_staff_merchantId_userId_key" ON "merchant_staff"("merchantId", "userId");

-- CreateIndex
CREATE INDEX "merchant_operating_hours_merchantId_idx" ON "merchant_operating_hours"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_operating_hours_merchantId_dayOfWeek_key" ON "merchant_operating_hours"("merchantId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "menu_categories_merchantId_sortOrder_idx" ON "menu_categories"("merchantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "menu_categories_merchantId_name_key" ON "menu_categories"("merchantId", "name");

-- CreateIndex
CREATE INDEX "menu_items_merchantId_availability_sortOrder_idx" ON "menu_items"("merchantId", "availability", "sortOrder");

-- CreateIndex
CREATE INDEX "menu_items_categoryId_idx" ON "menu_items"("categoryId");

-- CreateIndex
CREATE INDEX "menu_item_daily_stock_merchantId_serviceDate_idx" ON "menu_item_daily_stock"("merchantId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_daily_stock_menuItemId_serviceDate_key" ON "menu_item_daily_stock"("menuItemId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "orders_orderNo_key" ON "orders"("orderNo");

-- CreateIndex
CREATE INDEX "orders_merchantId_status_createdAt_idx" ON "orders"("merchantId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_customerId_createdAt_idx" ON "orders"("customerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_status_acceptDeadlineAt_idx" ON "orders"("status", "acceptDeadlineAt");

-- CreateIndex
CREATE INDEX "orders_status_scheduledPickupAt_idx" ON "orders"("status", "scheduledPickupAt");

-- CreateIndex
CREATE INDEX "orders_merchantId_serviceDate_status_idx" ON "orders"("merchantId", "serviceDate", "status");

-- CreateIndex
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");

-- CreateIndex
CREATE INDEX "order_items_menuItemId_idx" ON "order_items"("menuItemId");

-- CreateIndex
CREATE INDEX "order_status_events_orderId_createdAt_idx" ON "order_status_events"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "order_status_events_toStatus_createdAt_idx" ON "order_status_events"("toStatus", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_orderId_status_idx" ON "payments"("orderId", "status");

-- CreateIndex
CREATE INDEX "payments_merchantId_createdAt_idx" ON "payments"("merchantId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_providerRef_key" ON "payments"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "refunds_paymentId_status_idx" ON "refunds"("paymentId", "status");

-- CreateIndex
CREATE INDEX "merchant_payouts_status_periodEnd_idx" ON "merchant_payouts"("status", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payouts_merchantId_periodStart_periodEnd_key" ON "merchant_payouts"("merchantId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "merchant_payout_lines_payoutId_idx" ON "merchant_payout_lines"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_payout_lines_orderId_key" ON "merchant_payout_lines"("orderId");

-- CreateIndex
CREATE INDEX "outbox_events_status_availableAt_idx" ON "outbox_events"("status", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_version_idx" ON "outbox_events"("aggregateType", "aggregateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_userId_key" ON "driver_profiles"("userId");

-- CreateIndex
CREATE INDEX "driver_profiles_status_verification_idx" ON "driver_profiles"("status", "verification");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_tasks_orderId_key" ON "delivery_tasks"("orderId");

-- CreateIndex
CREATE INDEX "delivery_tasks_riderId_status_idx" ON "delivery_tasks"("riderId", "status");

-- CreateIndex
CREATE INDEX "delivery_tasks_merchantId_status_idx" ON "delivery_tasks"("merchantId", "status");

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_staff" ADD CONSTRAINT "merchant_staff_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_staff" ADD CONSTRAINT "merchant_staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_operating_hours" ADD CONSTRAINT "merchant_operating_hours_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "menu_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_daily_stock" ADD CONSTRAINT "menu_item_daily_stock_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_daily_stock" ADD CONSTRAINT "menu_item_daily_stock_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payouts" ADD CONSTRAINT "merchant_payouts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payout_lines" ADD CONSTRAINT "merchant_payout_lines_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "merchant_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_payout_lines" ADD CONSTRAINT "merchant_payout_lines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tasks" ADD CONSTRAINT "delivery_tasks_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "driver_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
