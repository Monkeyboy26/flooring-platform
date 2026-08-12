-- Restore MAP as retail for James Martin Vanities (JMV).
--
-- Context: import-james-martin.js sets cost = MAP * 0.5 and retail = MAP (i.e. retail = 2x cost).
-- The 2026-07-20 "2x -> 1.6x" keystone reprice swept JMV in (it sat at exactly 2.0x) and dropped
-- retail to 1.6x cost, so current retail = 0.8 * MAP. JMV is MAP-priced (vanities, not keystone),
-- so this restores retail = MAP = 2x cost and records it in map_price. The importer now also
-- populates map_price on future imports.
--
-- Scope: JMV vendor only (75b1dd45-e9bf-4e8e-be8a-22dccc14e8df), cost > 0, retail not locked.
-- MAP = cost * 2 exactly: costs are MAP/2 of whole-dollar MAPs, so all end in .00/.50 (no drift).
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_jmv_map before UPDATE.
-- To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price, map_price = b.map_price
--   FROM pricing_backup_jmv_map b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_jmv_map;
CREATE TABLE pricing_backup_jmv_map AS
SELECT pr.sku_id, pr.cost, pr.retail_price, pr.map_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '75b1dd45-e9bf-4e8e-be8a-22dccc14e8df'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

-- 2) retail = MAP = cost * 2; also record map_price.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 2, 2),
    map_price    = ROUND(pr.cost * 2, 2)
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '75b1dd45-e9bf-4e8e-be8a-22dccc14e8df'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

COMMIT;
