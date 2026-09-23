-- Reprice keystone items 1.6x -> 1.65x cost + retune trade tiers.
--
-- Context (2026-09-22, owner): the store's standard markup moves from retail = 1.6x
-- cost to retail = 1.65x cost, and the trade tiers move to cost-based multiples:
--   Silver 1.5x / Gold 1.4x / Platinum 1.3x cost.
-- Trade price is computed as a discount off retail, so against a 1.65x retail those
-- multiples become discounts of:
--   Silver   1 - 1.5/1.65 =  9.091%
--   Gold     1 - 1.4/1.65 = 15.152%
--   Platinum 1 - 1.3/1.65 = 21.212%
--
-- The keystone cluster is identified by ratio (pricing has no multiplier column):
-- retail/cost in [1.55, 1.645]. That captures the 1.6x cluster (charm-priced down to
-- ~1.55 on cheap items, and the exactly-1.60 nickel rows from the 2026-07 reprice)
-- while excluding the 1.65x feeds already in place, MSRP/MAP, 2x/2.5x, and oddballs.
-- retail_locked (Home-Depot-matched) rows are intentionally set and are left untouched.
--
-- Retail is recomputed the SAME way backend/scrapers/base.js does at upsert time, so a
-- future rescrape produces identical prices (no drift): charm-priced to the nearest
-- 9-ending at or below 1.65x cost, then lifted to the covering margin floor
-- (cost + $0.99) for area-covering rows (price_basis per_sqft/sqft). Carpet cut/roll
-- (per-sqyd) are nickel-rounded at 1.65x their own cost and floored at cost + $9
-- (= $1/sqft). Both floors are preserved. See [[covering-margin-floor]].
--
-- Re-runnable and value-idempotent (the recompute is deterministic). Reversible: the
-- affected rows are copied into pricing_backup_reprice_165 before any UPDATE. Roll back:
--   UPDATE pricing p SET retail_price = b.retail_price, cut_price = b.cut_price,
--     roll_price = b.roll_price
--   FROM pricing_backup_reprice_165 b WHERE b.sku_id = p.sku_id;

BEGIN;

-- Helpers (transaction-scoped feel; dropped at the end). Mirror base.js priceRetail.
-- Largest value ending in .X9 that is <= v (round DOWN only), floored at $0.09.
CREATE OR REPLACE FUNCTION _rp_nearest_nine(v numeric) RETURNS numeric AS $$
  SELECT GREATEST(9, floor((round($1 * 100) - 9) / 10.0) * 10 + 9) / 100.0;
$$ LANGUAGE sql IMMUTABLE;

-- Store retail from cost: charm-priced 1.65x, with covering floor (cost+0.99) when
-- `covering` is true. Matches base.js: nine = nearestNine(max(1.65*cost, floorMin));
-- if nine < floorMin bump up one dime.
CREATE OR REPLACE FUNCTION _rp_retail(cost numeric, covering boolean) RETURNS numeric AS $$
  WITH t AS (
    SELECT (CASE WHEN covering THEN cost + 0.99 ELSE 0 END) AS floormin
  ), n AS (
    SELECT floormin,
           _rp_nearest_nine(GREATEST(cost * 1.65, floormin)) AS nine
    FROM t
  )
  SELECT round(
    CASE WHEN floormin > 0 AND nine < floormin - 1e-9
         THEN nine + 0.10
         ELSE nine END, 2)
  FROM n;
$$ LANGUAGE sql IMMUTABLE;

-- Carpet cut/roll: nickel-rounded 1.65x, floored at cost + $9 (= $1/sqft, 9 sqft/sqyd,
-- nickel-rounded UP). Matches base.js carpetFloor.
CREATE OR REPLACE FUNCTION _rp_carpet(cost numeric) RETURNS numeric AS $$
  SELECT round(
    GREATEST(
      round(cost * 1.65 / 0.05) * 0.05,
      CASE WHEN round(cost * 1.65 / 0.05) * 0.05 < cost + 9
           THEN ceil((cost + 9) / 0.05) * 0.05
           ELSE 0 END
    ), 2);
$$ LANGUAGE sql IMMUTABLE;

-- 1) Backup every row any UPDATE below will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_165;
CREATE TABLE pricing_backup_reprice_165 AS
SELECT sku_id, cost, retail_price, cut_cost, cut_price, roll_cost, roll_price, NOW() AS backed_up_at
FROM pricing
WHERE (cost      > 0 AND retail_price IS NOT NULL AND retail_price > 0
        AND retail_price / cost BETWEEN 1.55 AND 1.645
        AND COALESCE(retail_locked, false) = false)
   OR (cut_cost  > 0 AND cut_price  IS NOT NULL AND cut_price  > 0
        AND cut_price  / cut_cost  BETWEEN 1.55 AND 1.645)
   OR (roll_cost > 0 AND roll_price IS NOT NULL AND roll_price > 0
        AND roll_price / roll_cost BETWEEN 1.55 AND 1.645);

-- 2) Retail: keystone 1.6x cluster -> 1.65x cost (charm + covering floor).
UPDATE pricing
SET retail_price = _rp_retail(cost, price_basis IN ('per_sqft', 'sqft'))
WHERE cost > 0 AND retail_price IS NOT NULL AND retail_price > 0
  AND retail_price / cost BETWEEN 1.55 AND 1.645
  AND COALESCE(retail_locked, false) = false;

-- 3) Carpet cut & roll lines: 1.65x each against its own cost, $9/sqyd floored.
UPDATE pricing
SET cut_price = _rp_carpet(cut_cost)
WHERE cut_cost > 0 AND cut_price IS NOT NULL AND cut_price > 0
  AND cut_price / cut_cost BETWEEN 1.55 AND 1.645;

UPDATE pricing
SET roll_price = _rp_carpet(roll_cost)
WHERE roll_cost > 0 AND roll_price IS NOT NULL AND roll_price > 0
  AND roll_price / roll_cost BETWEEN 1.55 AND 1.645;

-- 4) Trade tiers -> cost-based multiples against the new 1.65x retail.
UPDATE margin_tiers SET discount_percent =  9.091 WHERE name = 'Silver';
UPDATE margin_tiers SET discount_percent = 15.152 WHERE name = 'Gold';
UPDATE margin_tiers SET discount_percent = 21.212 WHERE name = 'Platinum';

DROP FUNCTION _rp_retail(numeric, boolean);
DROP FUNCTION _rp_carpet(numeric);
DROP FUNCTION _rp_nearest_nine(numeric);

COMMIT;
