-- Fix Ottimo Ceramics Color attributes: strip mosaic chip format grouped into color.
-- 2 Nara mosaic SKUs had the chip size + layout appended to the color:
--   "Beige Stone 4x4 Offset" -> "Beige Stone"
--   "Carrara 4x4 Offset"     -> "Carrara"
-- The sheet Size (12x12) already lives in the Size attribute.

BEGIN;

UPDATE sku_attributes sa
SET value = TRIM(REGEXP_REPLACE(sa.value, '\s*\d+\s*x\s*\d+\s+Offset$', '', 'i'))
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'Ottimo Ceramics'
  AND sa.value ~* '\d+\s*x\s*\d+\s+Offset$';

COMMIT;
