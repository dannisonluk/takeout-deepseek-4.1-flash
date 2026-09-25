-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'DECLINED', 'CANCELLED', 'NO_SHOW');
-- CreateTable
CREATE TABLE "reservation_settings" (
    "merchantId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "autoConfirm" BOOLEAN NOT NULL DEFAULT true,
    "slotMinutes" INTEGER NOT NULL DEFAULT 30,
    "turnMinutes" INTEGER NOT NULL DEFAULT 90,
    "seatsPerSlot" INTEGER NOT NULL DEFAULT 16,
    "minPartySize" INTEGER NOT NULL DEFAULT 1,
    "maxPartySize" INTEGER NOT NULL DEFAULT 8,
    "leadTimeMinutes" INTEGER NOT NULL DEFAULT 60,
    "advanceDays" INTEGER NOT NULL DEFAULT 14,
    "customerNotice" VARCHAR(500),
    "updatedById" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "reservation_settings_pkey" PRIMARY KEY ("merchantId")
);
-- CreateTable
CREATE TABLE "reservation_slots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "merchantId" UUID NOT NULL,
    "slotStart" TIMESTAMPTZ(3) NOT NULL,
    "booked" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "reservation_slots_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reservationNo" VARCHAR(24) NOT NULL,
    "merchantId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'PENDING',
    "partySize" INTEGER NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "turnMinutes" INTEGER NOT NULL,
    "serviceDate" DATE NOT NULL,
    "customerName" VARCHAR(80) NOT NULL,
    "contactPhone" VARCHAR(32) NOT NULL,
    "customerNote" TEXT,
    "merchantNote" TEXT,
    "statusReason" VARCHAR(300),
    "lastActor" "OrderActorType",
    "lastActorId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMPTZ(3),
    "seatedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "reservation_slots_merchantId_slotStart_key" ON "reservation_slots"("merchantId", "slotStart");
-- CreateIndex
CREATE UNIQUE INDEX "reservations_reservationNo_key" ON "reservations"("reservationNo");
-- CreateIndex
CREATE INDEX "reservations_merchantId_serviceDate_status_idx" ON "reservations"("merchantId", "serviceDate", "status");
-- CreateIndex
CREATE INDEX "reservations_merchantId_startsAt_idx" ON "reservations"("merchantId", "startsAt");
-- CreateIndex
CREATE INDEX "reservations_customerId_startsAt_idx" ON "reservations"("customerId", "startsAt" DESC);
-- AddForeignKey
ALTER TABLE "reservation_settings" ADD CONSTRAINT "reservation_settings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "reservation_slots" ADD CONSTRAINT "reservation_slots_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
