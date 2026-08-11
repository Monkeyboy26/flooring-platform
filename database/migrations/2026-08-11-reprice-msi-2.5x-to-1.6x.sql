-- Reprice the MSI 2.5x price-list batch to the 1.6x keystone.
--
-- Context: 177 MSI SKUs (imported 2026-04-26 by backend/scripts/import-msi-pricelist.js,
-- which hard-coded retail = cost * 2.5) sit at ~2.5x cost (~60% margin). The platform
-- keystone is retail = 1.6x cost (see 2026-07-20-reprice-2x-to-1.6x.sql). That earlier
-- migration deliberately used a narrow 1.95-2.05 band and left the 2.5x cluster untouched;
-- this migration finishes the job for MSI only.
--
-- Scope: MSI vendor only (550e8400-e29b-41d4-a716-446655440001), retail/cost ratio in
-- 2.45-2.55, cost > 0, retail not locked. Ratio is used because pricing has no multiplier
-- column. Other vendors with 2.5x (ADEX, Melange, etc.) are intentionally NOT touched.
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_reprice_msi25
-- before the UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_reprice_msi25 b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_msi25;
CREATE TABLE pricing_backup_reprice_msi25 AS
SELECT pr.sku_id, pr.cost, pr.retail_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440001'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

-- 2) Retail: 2.5x -> 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '550e8400-e29b-41d4-a716-446655440001'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

COMMIT;
