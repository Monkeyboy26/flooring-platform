-- Normalize all MSI non-vinyl retail to the 1.6x keystone.
--
-- Context: MSI retail historically came straight from the EDI feed's MSRP/list price,
-- so margins ranged ~1.3x-2.5x with no consistency. This sets retail = 1.6x cost
-- (nickel-rounded) uniformly across every MSI category EXCEPT vinyl (lvp-plank = LVP/LVT),
-- which is deliberately left untouched. Applied uniformly per user: SKUs currently below
-- 1.6x are raised, those above are lowered.
--
-- Scope: MSI vendor (550e8400-e29b-41d4-a716-446655440001), category <> 'lvp-plank',
-- cost > 0, retail not locked.
--
-- Reversible: affected rows are copied into pricing_backup_msi_keystone before the UPDATE.
-- To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price
--   FROM pricing_backup_msi_keystone b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows the reprice will touch.
DROP TABLE IF EXISTS pricing_backup_msi_keystone;
CREATE TABLE pricing_backup_msi_keystone AS
SELECT pr.sku_id, pr.cost, pr.retail_price, NOW() AS backed_up_at
FROM pricing pr
JOIN skus s      ON s.id = pr.sku_id
JOIN products p  ON p.id = s.product_id
JOIN categories c ON c.id = p.category_id
WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440001'
  AND c.slug <> 'lvp-plank'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

-- 2) Retail = 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing pr
SET retail_price = ROUND(pr.cost * 1.6 / 0.05) * 0.05
FROM skus s, products p, categories c
WHERE s.id = pr.sku_id
  AND p.id = s.product_id
  AND c.id = p.category_id
  AND p.vendor_id = '550e8400-e29b-41d4-a716-446655440001'
  AND c.slug <> 'lvp-plank'
  AND pr.cost > 0
  AND COALESCE(pr.retail_locked, false) = false;

COMMIT;
