-- Reprice 2x-markup items to 1.6x cost + move trade tiers to cost-based discounts.
--
-- Context: the store's keystone markup is retail = 2x cost. This lowers every
-- item currently at ~2x to retail = 1.6x cost (rounded to the nearest $0.05),
-- and moves the trade tiers to Silver 12.5% / Gold 18.75% / Platinum 21.875%
-- off retail (= 1.4x / 1.3x / 1.25x cost against a 1.6x retail). Items priced
-- off MSRP/MAP (no cost, or a non-2x ratio) keep their retail and just get the
-- new tier discount rates.
--
-- "2x" is identified by ratio because pricing has no multiplier column — retail
-- is a stored value. Band 1.95–2.05 captures the 2.0x cluster only; 2.2x, 2.5x,
-- 1.7x, MSRP/MAP, and the ~17x oddballs are left untouched.
--
-- Re-runnable and reversible: the affected rows are copied into
-- pricing_backup_reprice_2x before any UPDATE. To roll back:
--   UPDATE pricing p SET retail_price = b.retail_price, cut_price = b.cut_price,
--     roll_price = b.roll_price
--   FROM pricing_backup_reprice_2x b WHERE b.sku_id = p.sku_id;

BEGIN;

-- 1) Backup the rows any of the three reprices will touch (nickel-rounded band).
DROP TABLE IF EXISTS pricing_backup_reprice_2x;
CREATE TABLE pricing_backup_reprice_2x AS
SELECT sku_id, cost, retail_price, cut_cost, cut_price, roll_cost, roll_price, NOW() AS backed_up_at
FROM pricing
WHERE (cost      > 0 AND retail_price / cost      BETWEEN 1.95 AND 2.05)
   OR (cut_cost  > 0 AND cut_price    / cut_cost  BETWEEN 1.95 AND 2.05)
   OR (roll_cost > 0 AND roll_price   / roll_cost BETWEEN 1.95 AND 2.05);

-- 2) Retail: 2.0x -> 1.6x cost, rounded to the nearest $0.05.
UPDATE pricing
SET retail_price = ROUND(cost * 1.6 / 0.05) * 0.05
WHERE cost > 0 AND retail_price / cost BETWEEN 1.95 AND 2.05;

-- 3) Carpet cut & roll lines: same band, each against its own cost.
UPDATE pricing
SET cut_price = ROUND(cut_cost * 1.6 / 0.05) * 0.05
WHERE cut_cost > 0 AND cut_price / cut_cost BETWEEN 1.95 AND 2.05;

UPDATE pricing
SET roll_price = ROUND(roll_cost * 1.6 / 0.05) * 0.05
WHERE roll_cost > 0 AND roll_price / roll_cost BETWEEN 1.95 AND 2.05;

-- 4) Trade tiers become cost-based discounts. Widen the column first so 21.875
--    stores exactly (DECIMAL(5,2) would round it to 21.88).
ALTER TABLE margin_tiers ALTER COLUMN discount_percent TYPE DECIMAL(6,3);
UPDATE margin_tiers SET discount_percent = 12.500 WHERE name = 'Silver';
UPDATE margin_tiers SET discount_percent = 18.750 WHERE name = 'Gold';
UPDATE margin_tiers SET discount_percent = 21.875 WHERE name = 'Platinum';

COMMIT;
