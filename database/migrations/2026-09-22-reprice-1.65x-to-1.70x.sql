-- Reprice keystone items 1.65x -> 1.70x cost (retail margin goal 41%).
--
-- Context (2026-09-22, owner): standard markup moves from retail = 1.65x cost to
-- 1.70x cost, alongside a switch of the trade tiers to cost multiples (Silver 1.50x /
-- Gold 1.40x / Platinum 1.32x — handled separately). Second reprice; mirrors
-- 2026-09-22-reprice-1.6x-to-1.65x.sql.
--
-- Keystone cluster identified by ratio retail/cost in [1.60, 1.645+] — the current
-- 1.65x cluster (charm-priced to ~1.63-1.65). Band capped at 1.66 to exclude other
-- feeds (MSRP/MAP/2x) and the tile/mosaic margin-floored rows (which sit at a higher
-- ratio and are keystone-independent — left untouched). retail_locked untouched.
--
-- Recompute mirrors base.js priceRetail exactly: retail = charm( max( 1.70*cost,
-- cost + category minMargin ) ), where minMargin is $1.50 tile / $4.50 mosaic sheet
-- (per_unit) / $0.99 otherwise. So the tile/mosaic margin floors are preserved in the
-- same pass. Carpet cut/roll: nickel 1.70x each own cost, floored cost+$9/sqyd.
--
-- Reversible: pricing_backup_reprice_170. Roll back:
--   UPDATE pricing p SET retail_price=b.retail_price, cut_price=b.cut_price,
--     roll_price=b.roll_price FROM pricing_backup_reprice_170 b WHERE b.sku_id=p.sku_id;

BEGIN;

CREATE OR REPLACE FUNCTION _r7_nearest_nine(v numeric) RETURNS numeric AS $$
  SELECT GREATEST(9, floor((round($1 * 100) - 9) / 10.0) * 10 + 9) / 100.0;
$$ LANGUAGE sql IMMUTABLE;

-- retail = base.js priceRetail(1.70*cost) with the category margin floor.
CREATE OR REPLACE FUNCTION _r7_retail(cost numeric, min_margin numeric) RETURNS numeric AS $$
  WITH t AS (SELECT cost * 1.70 AS keystone, cost + min_margin AS marginfloor),
       g AS (SELECT GREATEST(keystone, marginfloor) AS target, marginfloor FROM t),
       n AS (SELECT _r7_nearest_nine(target) AS nine, marginfloor FROM g)
  SELECT round(CASE WHEN nine < marginfloor - 1e-9 THEN nine + 0.10 ELSE nine END, 2) FROM n;
$$ LANGUAGE sql IMMUTABLE;

-- carpet cut/roll: nickel 1.70x, floored at cost+$9 (= $1/sqft), nickel-rounded up.
CREATE OR REPLACE FUNCTION _r7_carpet(cost numeric) RETURNS numeric AS $$
  SELECT round(GREATEST(round(cost * 1.70 / 0.05) * 0.05,
    CASE WHEN round(cost * 1.70 / 0.05) * 0.05 < cost + 9 THEN ceil((cost + 9) / 0.05) * 0.05 ELSE 0 END), 2);
$$ LANGUAGE sql IMMUTABLE;

-- Per-sku category min margin, matching base.js.
CREATE OR REPLACE VIEW _r7_minmargin AS
  SELECT s.id AS sku_id,
    CASE
      WHEN c.slug = 'mosaic-tile' AND pr.price_basis = 'per_unit' THEN 4.50
      WHEN c.slug = 'mosaic-tile' THEN 1.50
      WHEN c.slug IN ('tile','backsplash-tile','ceramic-tile','commercial-tile','fluted-tile',
        'large-format-tile','pool-tile','porcelain-tile','talavera-tile','terrazzo-tile','wood-look-tile') THEN 1.50
      ELSE 0.99
    END AS min_margin
  FROM skus s JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN products p ON p.id = s.product_id
  LEFT JOIN categories c ON c.id = p.category_id;

-- 1) Backup rows any UPDATE touches (keystone band, own cost).
DROP TABLE IF EXISTS pricing_backup_reprice_170;
CREATE TABLE pricing_backup_reprice_170 AS
SELECT sku_id, cost, retail_price, cut_cost, cut_price, roll_cost, roll_price, NOW() AS backed_up_at
FROM pricing
WHERE (cost      > 0 AND retail_price IS NOT NULL AND retail_price > 0
        AND retail_price / cost BETWEEN 1.60 AND 1.66
        AND COALESCE(retail_locked, false) = false)
   OR (cut_cost  > 0 AND cut_price  IS NOT NULL AND cut_price  > 0 AND cut_price  / cut_cost  BETWEEN 1.60 AND 1.66)
   OR (roll_cost > 0 AND roll_price IS NOT NULL AND roll_price > 0 AND roll_price / roll_cost BETWEEN 1.60 AND 1.66);

-- 2) Retail: keystone 1.65x cluster -> 1.70x (charm + category margin floor).
UPDATE pricing pr
SET retail_price = _r7_retail(pr.cost, mm.min_margin)
FROM _r7_minmargin mm
WHERE pr.sku_id = mm.sku_id
  AND pr.cost > 0 AND pr.retail_price IS NOT NULL AND pr.retail_price > 0
  AND pr.retail_price / pr.cost BETWEEN 1.60 AND 1.66
  AND COALESCE(pr.retail_locked, false) = false;

-- 3) Carpet cut & roll.
UPDATE pricing SET cut_price = _r7_carpet(cut_cost)
WHERE cut_cost > 0 AND cut_price IS NOT NULL AND cut_price > 0 AND cut_price / cut_cost BETWEEN 1.60 AND 1.66;
UPDATE pricing SET roll_price = _r7_carpet(roll_cost)
WHERE roll_cost > 0 AND roll_price IS NOT NULL AND roll_price > 0 AND roll_price / roll_cost BETWEEN 1.60 AND 1.66;

DROP VIEW _r7_minmargin;
DROP FUNCTION _r7_retail(numeric, numeric);
DROP FUNCTION _r7_carpet(numeric);
DROP FUNCTION _r7_nearest_nine(numeric);

COMMIT;
