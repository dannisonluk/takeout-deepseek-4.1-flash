-- CreateEnum
CREATE TYPE "AnalyticsTier" AS ENUM ('NONE', 'BASIC', 'PRO');

-- CreateEnum
CREATE TYPE "ClosureReason" AS ENUM ('PUBLIC_HOLIDAY', 'STAFF_HOLIDAY', 'PRIVATE_EVENT', 'MAINTENANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "WaitlistStatus" AS ENUM ('WAITING', 'CALLED', 'SEATED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('OPEN', 'IN_DISCUSSION', 'RESOLVED_OFFLINE', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RefundReasonCode" AS ENUM ('NEVER_RECEIVED', 'WRONG_ITEM', 'QUALITY', 'LATE', 'DUPLICATE_CHARGE', 'OTHER');

-- CreateEnum
CREATE TYPE "DiningSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'ABANDONED');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "analyticsTier" "AnalyticsTier" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "diningSessionId" UUID;

-- CreateTable
CREATE TABLE "merchant_closures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "serviceDate" DATE NOT NULL,
    "reason" "ClosureReason" NOT NULL DEFAULT 'OTHER',
    "note" VARCHAR(300),
    "cancelledReservationsAt" TIMESTAMPTZ(3),
    "cancelledReservationCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist_settings" (
    "merchantId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "acceptWhenClosed" BOOLEAN NOT NULL DEFAULT false,
    "minPartySize" INTEGER NOT NULL DEFAULT 1,
    "maxPartySize" INTEGER NOT NULL DEFAULT 10,
    "averageTurnMinutes" INTEGER NOT NULL DEFAULT 45,
    "callTimeoutMinutes" INTEGER NOT NULL DEFAULT 10,
    "customerNotice" VARCHAR(500),
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waitlist_settings_pkey" PRIMARY KEY ("merchantId")
);

-- CreateTable
CREATE TABLE "waitlist_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "ticketNo" VARCHAR(16) NOT NULL,
    "serviceDate" DATE NOT NULL,
    "status" "WaitlistStatus" NOT NULL DEFAULT 'WAITING',
    "partySize" INTEGER NOT NULL,
    "guestName" VARCHAR(80) NOT NULL,
    "contactPhone" VARCHAR(32) NOT NULL,
    "note" TEXT,
    "joinedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quotedMinutes" INTEGER,
    "calledAt" TIMESTAMPTZ(3),
    "seatedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "statusReason" VARCHAR(300),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dining_tables" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "label" VARCHAR(80),
    "seats" INTEGER NOT NULL DEFAULT 4,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "qrToken" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dining_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dining_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "status" "DiningSessionStatus" NOT NULL DEFAULT 'OPEN',
    "partySize" INTEGER,
    "serviceDate" DATE NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "closedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dining_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "merchantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'OPEN',
    "reasonCode" "RefundReasonCode" NOT NULL,
    "requestedAmountMinor" INTEGER,
    "orderTotalMinor" INTEGER NOT NULL,
    "customerNote" TEXT,
    "merchantNote" TEXT,
    "settledAmountMinor" INTEGER,
    "settlementReference" VARCHAR(120),
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_closures_merchantId_serviceDate_idx" ON "merchant_closures"("merchantId", "serviceDate");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_closures_merchantId_serviceDate_key" ON "merchant_closures"("merchantId", "serviceDate");

-- CreateIndex
CREATE INDEX "waitlist_entries_merchantId_serviceDate_status_joinedAt_idx" ON "waitlist_entries"("merchantId", "serviceDate", "status", "joinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_entries_merchantId_serviceDate_ticketNo_key" ON "waitlist_entries"("merchantId", "serviceDate", "ticketNo");

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_qrToken_key" ON "dining_tables"("qrToken");

-- CreateIndex
CREATE INDEX "dining_tables_merchantId_isActive_idx" ON "dining_tables"("merchantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "dining_tables_merchantId_code_key" ON "dining_tables"("merchantId", "code");

-- CreateIndex
CREATE INDEX "dining_sessions_merchantId_status_idx" ON "dining_sessions"("merchantId", "status");

-- CreateIndex
CREATE INDEX "dining_sessions_tableId_status_idx" ON "dining_sessions"("tableId", "status");

-- CreateIndex
CREATE INDEX "dining_sessions_merchantId_serviceDate_idx" ON "dining_sessions"("merchantId", "serviceDate");

-- CreateIndex
CREATE INDEX "refund_requests_orderId_status_idx" ON "refund_requests"("orderId", "status");

-- CreateIndex
CREATE INDEX "refund_requests_merchantId_status_createdAt_idx" ON "refund_requests"("merchantId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "refund_requests_customerId_createdAt_idx" ON "refund_requests"("customerId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "orders_diningSessionId_createdAt_idx" ON "orders"("diningSessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_diningSessionId_fkey" FOREIGN KEY ("diningSessionId") REFERENCES "dining_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_closures" ADD CONSTRAINT "merchant_closures_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_settings" ADD CONSTRAINT "waitlist_settings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_tables" ADD CONSTRAINT "dining_tables_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dining_sessions" ADD CONSTRAINT "dining_sessions_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "dining_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

