-- Category-scoped minimum gross margin: tile retail >= cost + $1.50, mosaic sheet
-- retail >= cost + $4.50.
--
-- Context (2026-09-22, owner): raise the standard $0.99 covering margin for these
-- categories to a $1.50 minimum gross margin on tile and $4.50 on mosaic sheets
-- (per_unit). Margin = retail - cost, so this needs a real cost; $0/unknown-cost
-- rows can't have a margin computed and are left alone (a separate zero-cost DQ
-- backlog). Charm pricing still applies: retail lands on the next 9-ending at/above
-- cost+margin. Mirrors the going-forward rule in backend/scrapers/base.js
-- upsertPricing. See [[category-margin-floors]].
--
-- Scope by category slug:
--   tile margin ($1.50): tile + backsplash/ceramic/commercial/fluted/large-format/
--     pool/porcelain/talavera/terrazzo/wood-look-tile, area-sold (per_sqft/sqft),
--     plus mosaic-tile sold by area (treated as tile).
--   mosaic margin ($4.50): mosaic-tile sold per_unit (per sheet).
-- Only ever RAISES a below-margin retail; rows already at/above the margin are left
-- untouched. retail_locked rows included (the margin is a hard minimum). Backup in
-- pricing_backup_tile_mosaic_margin. Roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_tile_mosaic_margin b WHERE b.sku_id = p.sku_id;

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

WITH tile_cats AS (
  SELECT id FROM categories WHERE slug IN ('tile','backsplash-tile','ceramic-tile',
    'commercial-tile','fluted-tile','large-format-tile','pool-tile','porcelain-tile',
    'talavera-tile','terrazzo-tile','wood-look-tile')
), mosaic_cat AS (
  SELECT id FROM categories WHERE slug = 'mosaic-tile'
),
-- Tile (and area-sold mosaic) below cost + $1.50 margin.
tile_rows AS (
  SELECT pr.sku_id, 1.50::numeric AS min_margin
  FROM pricing pr JOIN skus s ON s.id = pr.sku_id JOIN products p ON p.id = s.product_id
  WHERE p.category_id IN (SELECT id FROM tile_cats UNION SELECT id FROM mosaic_cat)
    AND pr.price_basis IN ('per_sqft','sqft')
    AND pr.cost > 0 AND pr.retail_price > 0 AND (pr.retail_price - pr.cost) < 1.50
),
-- Mosaic sheet (per_unit) below cost + $4.50 margin.
mosaic_rows AS (
  SELECT pr.sku_id, 4.50::numeric AS min_margin
  FROM pricing pr JOIN skus s ON s.id = pr.sku_id JOIN products p ON p.id = s.product_id
  WHERE p.category_id IN (SELECT id FROM mosaic_cat)
    AND pr.price_basis = 'per_unit'
    AND pr.cost > 0 AND pr.retail_price > 0 AND (pr.retail_price - pr.cost) < 4.50
),
targets AS (
  SELECT * FROM tile_rows UNION ALL SELECT * FROM mosaic_rows
)
SELECT t.sku_id, t.min_margin, pr.cost, pr.retail_price, NOW() AS backed_up_at
INTO TEMP _mf_backup
FROM targets t JOIN pricing pr ON pr.sku_id = t.sku_id;

DROP TABLE IF EXISTS pricing_backup_tile_mosaic_margin;
CREATE TABLE pricing_backup_tile_mosaic_margin AS SELECT * FROM _mf_backup;

-- Lift each below-margin retail to its charm-priced cost+margin floor.
UPDATE pricing pr
SET retail_price = _mf_floor_charm(b.cost + b.min_margin)
FROM _mf_backup b
WHERE pr.sku_id = b.sku_id;

DROP FUNCTION _mf_floor_charm(numeric);
DROP FUNCTION _mf_nearest_nine(numeric);

COMMIT;
