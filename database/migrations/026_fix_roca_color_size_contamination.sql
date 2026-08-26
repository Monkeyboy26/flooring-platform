-- Fix Roca Color attributes: strip embedded size/trim info grouped into color names.
-- Roca accessory/trim SKUs (bullnose, pencil, cove base, quarter round, etc.) had the
-- dimension + trim descriptor concatenated into the Color attribute value, e.g.
--   "White Ice 4 1/4x6 Lc"  -> should just be "White Ice"
--   "Aqua 1/2 X10"          -> "Aqua"
--   "T.gray 1/2 X10"        -> "Tender Gray"
-- The dimension already lives in the Size attribute, so the color is duplicated + polluted.
--
-- The product name IS the clean, already-expanded color for every affected row (the
-- accessory belongs to a color-named product), so we simply reset the Color attribute
-- to products.name. This also corrects abbreviations still present in the Color value
-- (At. Blue -> Atoll Blue, P. Green -> Peacock Green, Wh Ice -> White Ice, etc.).
--
-- Guard `value <> p.name` leaves legitimate digit-bearing colors untouched
-- (Palace 2/3/4 slabs, "20mm Crosscut Bone" pavers, 24" Towel Bar Sets), where the
-- color legitimately equals the product name.
--
-- No re-contamination risk: roca.js scraper only writes images, never Color attributes.
-- Search vectors auto-refresh via trg_sku_attributes_search_vector on value UPDATE.
-- Affects 52 SKUs (49 distinct color values) across the accessory/trim collections.

BEGIN;

UPDATE sku_attributes sa
SET value = p.name
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.code = 'ROCA'
  AND sa.value ~ '[0-9]'
  AND sa.value <> p.name;

COMMIT;
