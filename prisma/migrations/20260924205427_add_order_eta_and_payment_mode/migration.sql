-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('ONLINE', 'PAY_AT_STORE');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "estimatedReadyAt" TIMESTAMPTZ(3),
ADD COLUMN     "merchantNote" TEXT,
ADD COLUMN     "paymentMode" "PaymentMode" NOT NULL DEFAULT 'ONLINE',
ADD COLUMN     "readyInMinutes" INTEGER;

-- DropEnum
DROP TYPE "ImageVariant";
