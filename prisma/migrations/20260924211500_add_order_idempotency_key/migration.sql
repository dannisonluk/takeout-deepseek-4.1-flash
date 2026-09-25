-- Durable order idempotency.
--
-- The `Idempotency-Key` header was previously enforced ONLY by a Redis `SET NX`
-- lock in `CustomerOrderController.create`. Redis is optional in this
-- deployment, and `RedisService.acquire` fails closed, so an unreachable Redis
-- turned every idempotent checkout into a 500 — customers could not order at
-- all, while Postgres was perfectly capable of telling the two submissions
-- apart.
--
-- The column is nullable: a caller is not obliged to send the header, and the
-- API only promises idempotency when one is present. NULLs do not collide in a
-- Postgres unique index, so an order placed without a key is unaffected.
ALTER TABLE "orders" ADD COLUMN "idempotencyKey" VARCHAR(120);

CREATE UNIQUE INDEX "orders_idempotencyKey_key" ON "orders"("idempotencyKey");
