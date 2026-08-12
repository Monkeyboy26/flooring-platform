-- Reprice Alaska Tile (AKT) to the 1.6x keystone on cost.
--
-- Context: import-alaska-tile.js stored cost = pallet price but computed retail off the
-- higher job-pack price (retail = jobPack * 1.6), so effective retail/cost ran ~2.2-2.6x.
-- This normalizes Alaska to the platform keystone: retail = 1.6 * cost. The importer was
-- also switched to base retail on cost so future imports match.
--
-- Scope: Alaska Tile vendor only (038dcf2b-39e2-4f31-a55d-3822fa2f354e), cost > 0,
-- retail not locked. All rows repriced (no ratio band — the whole vendor moves to 1.6x).
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_reprice_akt
-- before the UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_reprice_akt b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_akt;
CREATE TABLE pricing_backup_reprice_akt AS
SELECT pr.sku_id, pr.cost, pr.retail_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '038dcf2b-39e2-4f31-a55d-3822fa2f354e'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

-- 2) Retail: 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '038dcf2b-39e2-4f31-a55d-3822fa2f354e'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

COMMIT;
