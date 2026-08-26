-- Fix SLCC Flooring Color attributes: moulding accessories had the moulding type +
-- length stored as the color instead of the tile's color family, e.g.
--   "End Cap 7'10\"", "Flush Nose 7'10\"", "Overlap Nose 7'10\"", "T 7'10\""
-- SLCC's color is a family label ("Gray Wood", "Brown Wood", "Tan Wood", "White Wood")
-- carried on the product's field SKU; the design name (Abeja, Alba, ...) is the
-- product name, not the color. Each product_id has exactly one field color, so each
-- accessory inherits the field color of its own product.
-- Affects 784 moulding accessory SKUs.

BEGIN;

UPDATE sku_attributes sa
SET value = fc.field_color
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
CROSS JOIN LATERAL (
  SELECT sc2.value AS field_color
  FROM skus s2
  JOIN sku_attributes sc2 ON sc2.sku_id = s2.id
   AND sc2.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  WHERE s2.product_id = p.id
    AND (s2.variant_type IS NULL OR s2.variant_type <> 'accessory')
  LIMIT 1
) fc
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'SLCC Flooring'
  AND s.variant_type = 'accessory'
  AND sa.value ~ '[0-9]';

COMMIT;
