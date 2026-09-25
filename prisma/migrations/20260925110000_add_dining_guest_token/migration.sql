-- ===========================================================================
--  店內點餐 — the per-sitting guest token and guest identity
-- ===========================================================================
--  The shop's decision for 店內點餐 was "an one-time QR code is assigned at
--  seating". That means the STATIC table code (dining_tables.qrToken) opens a
--  sitting, and ordering authority lives on a token minted per sitting — so a
--  photograph of a table code taken on a previous visit, or of the table next
--  door, cannot add a round to somebody else's bill.
--
--  Two columns, both nullable, so the migration is safe on a database that
--  already has sittings (they simply have no guest token, and cannot be
--  ordered against until reopened).
--
--  IDENTIFIER RULE: Prisma emits camelCase column names for fields without an
--  explicit @map — so everything below is quoted. See prisma/sql/post-init.sql.
-- ===========================================================================

-- AlterTable
ALTER TABLE "dining_sessions" ADD COLUMN "guestToken" VARCHAR(64);
ALTER TABLE "dining_sessions" ADD COLUMN "guestCustomerId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "dining_sessions_guestToken_key" ON "dining_sessions"("guestToken");

-- AddForeignKey
ALTER TABLE "dining_sessions"
  ADD CONSTRAINT "dining_sessions_guestCustomerId_fkey"
  FOREIGN KEY ("guestCustomerId") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
