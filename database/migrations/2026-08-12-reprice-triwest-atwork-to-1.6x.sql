-- Reprice the Tri-West @work carpet-tile outliers from 2.5x to the 1.6x keystone.
--
-- Context: 5,682 of 5,701 Tri-West SKUs already sit at 1.6x. The 19 exceptions are the
-- @work commercial carpet tiles seeded by backend/scripts/insert-atwork-carpet-tile.cjs,
-- whose retail fallback was cost * 2.5. This brings them onto the keystone with the rest
-- of the vendor. The seed script's fallback was also switched to 1.6x.
--
-- Scope: Tri-West vendor (550e8400-e29b-41d4-a716-446655440008), retail/cost in 2.45-2.55,
-- cost > 0, retail not locked.
--
-- Re-runnable and reversible: affected rows are copied into pricing_backup_reprice_tw_atwork
-- before the UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_reprice_tw_atwork b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_reprice_tw_atwork;
CREATE TABLE pricing_backup_reprice_tw_atwork AS
SELECT pr.sku_id, pr.cost, pr.retail_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s   ON s.id = pr.sku_id
JOIN products p ON p.id = s.product_id
WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440008'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

-- 2) Retail: 2.5x -> 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND p.vendor_id = '550e8400-e29b-41d4-a716-446655440008'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false
  AND pr.retail_price / pr.cost BETWEEN 2.45 AND 2.55;

COMMIT;
