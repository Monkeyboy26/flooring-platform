-- Reprice Melange Boutique Tile (MLG) from the 2.5x markup to the 1.6x keystone.
--
-- Context: import-melange.js hard-coded retail = cost * 2.5, leaving all 366 MLG SKUs at
-- a uniform 2.5x cost. Same case as ADEX (the 2026-08-11 MSI reprice comment named ADEX,
-- Melange as the intentionally-untouched 2.5x vendors). This brings MLG onto the keystone.
-- The import constant was also switched to 1.6 so future imports match.
--
-- Scope: Melange vendor only (12a55bb7-a610-4abd-94f7-6f0d96c880e9), retail/cost ratio in
-- 2.45-2.55, cost > 0, retail not locked.
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_reprice_mlg25
-- before the UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_reprice_mlg25 b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_mlg25;
CREATE TABLE pricing_backup_reprice_mlg25 AS
SELECT pr.sku_id, pr.cost, pr.retail_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '12a55bb7-a610-4abd-94f7-6f0d96c880e9'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

-- 2) Retail: 2.5x -> 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '12a55bb7-a610-4abd-94f7-6f0d96c880e9'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

COMMIT;
