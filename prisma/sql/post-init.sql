-- ===========================================================================
--  Post-init SQL
-- ===========================================================================
--  Run ONCE after `prisma migrate dev --name init`.
--
--      psql "$DATABASE_URL" -f prisma/sql/post-init.sql
--
--  Everything here is either something Prisma cannot express (GIN trigram
--  index, conditional PostGIS objects) or seed data that must exist before the
--  API boots.
--
--  PostGIS is treated as an OPTIONAL CAPABILITY. If the extension is present
--  the script adds the `geography` column, its GIST index and the sync trigger;
--  if not, it installs a lat/lng bounding-box index instead and says so. The
--  schema therefore installs on a plain PostgreSQL (local dev, CI) and still
--  gets indexed geo queries on a PostGIS-enabled server.
--
--  ---------------------------------------------------------------------------
--  IDENTIFIER RULE (read before editing any SQL in this repo)
--  ---------------------------------------------------------------------------
--  Prisma only snake_cases TABLE names (via `@@map`). Every model FIELD without
--  an explicit `@map` keeps its Prisma name verbatim in the database, and the
--  schema uses camelCase field names. So the physical columns are:
--
--      platform_config         -> key, value, description, "updatedById", "updatedAt"
--      platform_config_history -> key, action, "previousValue", "newValue", "changedById", "changedAt"
--      orders                  -> "merchantId", "serviceDate", "platformFeeMinor", "refundDueMinor", ...
--      reviews                 -> "orderId", "merchantId", "customerId", "merchantReply", "hiddenAt", ...
--      merchant_payout_lines   -> "payoutId", "orderId", "platformFeeMinor", ...
--      menu_item_daily_stock   -> "menuItemId", "merchantId", "serviceDate", ...
--      outbox_events           -> "aggregateType", "aggregateId", "eventType", ...
--
--  Hand-written SQL must therefore QUOTE every multi-word column. Getting this
--  wrong fails at runtime, not at build time, so keep this list current.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions that must exist regardless
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Merchant name search (pg_trgm)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS merchants_name_trgm_idx
    ON merchants USING GIN (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 2. Geo — PostGIS path when available, bounding box otherwise
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  has_postgis boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis')
    INTO has_postgis;

  IF has_postgis THEN
    CREATE EXTENSION IF NOT EXISTS postgis;

    ALTER TABLE merchants
      ADD COLUMN IF NOT EXISTS location geography(Point, 4326);

    -- Backfill from the float pair Prisma maintains.
    UPDATE merchants
       SET location = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
     WHERE location IS NULL;

    CREATE INDEX IF NOT EXISTS merchants_location_gix
        ON merchants USING GIST (location);

    -- Discovery only ever scans ACTIVE merchants; a partial index is ~1/3 the size.
    CREATE INDEX IF NOT EXISTS merchants_location_active_gix
        ON merchants USING GIST (location)
     WHERE status = 'ACTIVE';

    -- Keep `location` derived rather than hand-maintained at every call site.
    CREATE OR REPLACE FUNCTION sync_merchant_location() RETURNS trigger AS $fn$
    BEGIN
      NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS merchants_sync_location ON merchants;
    CREATE TRIGGER merchants_sync_location
      BEFORE INSERT OR UPDATE OF latitude, longitude ON merchants
      FOR EACH ROW EXECUTE FUNCTION sync_merchant_location();

    RAISE NOTICE 'PostGIS enabled: geography column + GIST indexes + sync trigger created.';

  ELSE
    -- No PostGIS. A bounding-box prefilter on (latitude, longitude) plus a
    -- haversine refinement in the query is accurate enough for the merchant
    -- counts this platform will see, and needs no extension at all.
    CREATE INDEX IF NOT EXISTS merchants_lat_lng_idx
        ON merchants (latitude, longitude)
     WHERE status = 'ACTIVE';

    RAISE NOTICE 'PostGIS not available: created merchants_lat_lng_idx for bounding-box search instead.';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Platform configuration seeds
-- ---------------------------------------------------------------------------
-- These rows override the environment defaults at boot. Changing HK$3.50 is an
-- UPDATE here, not a redeploy.
--
-- Resolution order (see packages/domain/src/pricing/pricing-policy.ts):
--     platform_config row  ->  environment variable  ->  code default
INSERT INTO platform_config (key, value, description, "updatedAt") VALUES
  ('pricing.platform_fee_per_main_item_minor', '350'::jsonb,
   '中介費：每件主餐收取的固定金額（minor units，350 = HK$3.50）', now()),
  ('pricing.payment_fee_rate_bps', '340'::jsonb,
   '支付手續費百分比（basis points，340 = 3.40%）', now()),
  ('pricing.payment_fee_fixed_minor', '235'::jsonb,
   '支付手續費固定部分（minor units，235 = HK$2.35）', now()),
  ('pricing.count_add_on_items', 'false'::jsonb,
   '是否對加配菜/飲品亦收取按件中介費', now()),
  ('pricing.customer_service_fee_minor', '0'::jsonb,
   '向顧客收取的服務費（minor units，MVP 為 0）', now()),
  ('pricing.minimum_payout_minor', '0'::jsonb,
   '商戶結算下限；低於此值會擲出 NEGATIVE_MERCHANT_PAYOUT', now()),

  -- Cancellation policy. Same three-tier resolution as pricing, same registry
  -- (`apps/api/src/modules/pricing/pricing-config.registry.ts`), so the admin
  -- console can retune refunds without a deploy. All values are basis points.
  ('cancellation.grace_minutes', '2'::jsonb,
   '商戶接單後幾分鐘內顧客仍可免費取消（「手誤」窗口）', now()),
  ('cancellation.refund_bps_free', '10000'::jsonb,
   '免費取消：全額退還（10000 = 100%）', now()),
  ('cancellation.refund_bps_late', '0'::jsonb,
   '超過寬限期才取消：廚房已備料，預設不退', now()),
  ('cancellation.refund_bps_non_refundable', '0'::jsonb,
   '餐點已做好但顧客未取：預設不退', now()),
  ('cancellation.refund_bps_merchant_fault', '10000'::jsonb,
   '商戶拒單或取消：全額退還', now()),
  ('cancellation.refund_bps_platform_fault', '10000'::jsonb,
   '系統逾時導致訂單失效：全額退還', now()),
  ('cancellation.refund_bps_goodwill', '10000'::jsonb,
   '管理員代顧客取消時的預設退款比例', now())
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Review integrity
-- ---------------------------------------------------------------------------
-- The rating range is a CHECK rather than a Prisma `@db.SmallInt`, because the
-- domain exposes `Merchant.ratingAvg` to customers and an out-of-range row would
-- corrupt every ranking that reads it. Prisma cannot express CHECK constraints,
-- so it lives here. Guarded with a DO block so re-running the script is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_rating_range'
  ) THEN
    ALTER TABLE reviews
      ADD CONSTRAINT reviews_rating_range CHECK (rating BETWEEN 1 AND 5);
    RAISE NOTICE 'Added reviews_rating_range CHECK (1..5).';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. Reconciliation helper
-- ---------------------------------------------------------------------------
-- Daily check: the platform fee recorded on orders must equal the fee recorded
-- on payout lines. A non-zero delta means a settlement bug — alert on it.
CREATE OR REPLACE VIEW v_daily_platform_fee_reconciliation AS
SELECT o."merchantId",
       o."serviceDate",
       SUM(o."platformFeeMinor")                                          AS orders_platform_fee,
       COALESCE(SUM(l."platformFeeMinor"), 0)                             AS payout_platform_fee,
       SUM(o."platformFeeMinor") - COALESCE(SUM(l."platformFeeMinor"), 0) AS delta,
       COUNT(*) FILTER (WHERE l.id IS NULL)                               AS unsettled_orders
  FROM orders o
  LEFT JOIN merchant_payout_lines l ON l."orderId" = o.id
 WHERE o.status IN ('COMPLETED', 'EXPIRED')
 GROUP BY o."merchantId", o."serviceDate";

-- ---------------------------------------------------------------------------
-- 6. Report which geo strategy is active
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'postgis') THEN
    RAISE NOTICE 'Geo strategy: PostGIS (GIST index on merchants.location)';
  ELSE
    RAISE NOTICE 'Geo strategy: bounding box (btree index on merchants.latitude/longitude)';
  END IF;
END
$$;
