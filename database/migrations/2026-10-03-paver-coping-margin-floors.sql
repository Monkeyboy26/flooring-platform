-- Extend the $1.50 tile margin floor to pavers and pool coping.
--
-- Context (2026-10-03, owner): the 2026-09-22 tile/mosaic margin floor gated the
-- $1.50 minimum gross margin to a hardcoded allowlist of tile category slugs.
-- Saltillo pavers live under the `pavers` slug and pool coping under `pool-coping`,
-- neither of which was in that set, so they fell through to the standard $0.99
-- covering margin. Both are tile-like products and the owner wants them held to the
-- same $1.50 floor. base.js upsertPricing now treats both slugs as isTileCat (which
-- applies the floor regardless of price_basis), so this backfill mirrors that: it
-- lifts any below-margin row with a real cost, per_sqft OR per_unit.
--
-- Margin = retail - cost; needs a real cost, so $0/unknown-cost rows are left alone.
-- Charm pricing still applies: retail lands on the next 9-ending at/above cost+$1.50.
-- Only ever RAISES a below-margin retail; rows already at/above are untouched.
-- retail_locked rows included (the margin is a hard minimum). Backup in
-- pricing_backup_paver_coping_margin. Roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_paver_coping_margin b WHERE b.sku_id = p.sku_id;
-- See [[category-margin-floors]].

BEGIN;

-- Largest value ending in .X9 that is <= v (round DOWN), floored at $0.09.
CREATE OR REPLACE FUNCTION _mf_nearest_nine(v numeric) RETURNS numeric AS $$
  SELECT GREATEST(9, floor((round($1 * 100) - 9) / 10.0) * 10 + 9) / 100.0;
$$ LANGUAGE sql IMMUTABLE;

-- Smallest 9-ending >= target (floor up to a 9-ending). Matches base.js priceRetail.
CREATE OR REPLACE FUNCTION _mf_floor_charm(target numeric) RETURNS numeric AS $$
  SELECT round(
    CASE WHEN _mf_nearest_nine($1) < $1 - 1e-9
         THEN _mf_nearest_nine($1) + 0.10
         ELSE _mf_nearest_nine($1) END, 2);
$$ LANGUAGE sql IMMUTABLE;

WITH paver_coping_cats AS (
  SELECT id FROM categories WHERE slug IN ('pavers','pool-coping')
),
-- Any paver/coping row below cost + $1.50 margin, any basis (matches base.js isTileCat).
target_rows AS (
  SELECT pr.sku_id, 1.50::numeric AS min_margin
  FROM pricing pr JOIN skus s ON s.id = pr.sku_id JOIN products p ON p.id = s.product_id
  WHERE p.category_id IN (SELECT id FROM paver_coping_cats)
    AND pr.cost > 0 AND pr.retail_price > 0 AND (pr.retail_price - pr.cost) < 1.50
)
SELECT t.sku_id, t.min_margin, pr.cost, pr.retail_price, NOW() AS backed_up_at
INTO TEMP _mf_backup
FROM target_rows t JOIN pricing pr ON pr.sku_id = t.sku_id;

DROP TABLE IF EXISTS pricing_backup_paver_coping_margin;
CREATE TABLE pricing_backup_paver_coping_margin AS SELECT * FROM _mf_backup;

-- Lift each below-margin retail to its charm-priced cost+$1.50 floor.
UPDATE pricing pr
SET retail_price = _mf_floor_charm(b.cost + b.min_margin)
FROM _mf_backup b
WHERE pr.sku_id = b.sku_id;

DROP FUNCTION _mf_floor_charm(numeric);
DROP FUNCTION _mf_nearest_nine(numeric);

COMMIT;
