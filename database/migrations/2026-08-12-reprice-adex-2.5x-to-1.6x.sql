-- Reprice ADEX from the 2.5x markup to the 1.6x keystone.
--
-- Context: ADEX (import-adex.js / backfill-adex-skus.cjs) hard-coded retail = cost * 2.5,
-- leaving all 1342 ADEX SKUs at ~2.5x cost (~60% margin). The platform keystone is
-- retail = 1.6x cost. The earlier MSI reprice (2026-08-11) deliberately left ADEX untouched;
-- this migration brings ADEX onto the keystone. The import/backfill constants were also
-- switched to 1.6 so future imports match.
--
-- Scope: ADEX vendor only (0bbeac3b-5101-4335-be94-808a3c197126), retail/cost ratio in
-- 2.45-2.55, cost > 0, retail not locked. Ratio is used because pricing has no multiplier col.
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_reprice_adex25
-- before the UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_reprice_adex25 b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_adex25;
CREATE TABLE pricing_backup_reprice_adex25 AS
SELECT pr.sku_id, pr.cost, pr.retail_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '0bbeac3b-5101-4335-be94-808a3c197126'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

-- 2) Retail: 2.5x -> 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '0bbeac3b-5101-4335-be94-808a3c197126'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

COMMIT;
