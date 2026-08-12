-- Apply the 1.6x keystone to LDZ Flooring.
--
-- Context: import-ldz.js priced field tiles at retail = MAP (~1.42-1.45x cost), while only
-- accessories used cost * 1.6. This normalizes LDZ to the platform keystone: retail = 1.6 * cost.
-- 1.6x cost > MAP on every LDZ SKU, so the MAP floor (map_price) is preserved, not violated.
-- The importer was also switched to base field-tile retail on cost * 1.6.
--
-- Scope: LDZ vendor only (80b5b342-9cf3-45b2-bad6-44326a1e70a1), cost > 0, retail not locked.
-- map_price is left untouched.
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_reprice_ldz
-- before the UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_reprice_ldz b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_ldz;
CREATE TABLE pricing_backup_reprice_ldz AS
SELECT pr.sku_id, pr.cost, pr.retail_price, pr.map_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '80b5b342-9cf3-45b2-bad6-44326a1e70a1'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

-- 2) Retail: 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '80b5b342-9cf3-45b2-bad6-44326a1e70a1'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

COMMIT;
