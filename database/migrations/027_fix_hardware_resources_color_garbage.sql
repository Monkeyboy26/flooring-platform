-- Fix Hardware Resources Color attributes: strip garbage model-code + note suffix.
-- 4 sash-pull SKUs had the Color set to a concatenation of finish + item number +
-- sales note, e.g. "Chrome6x3400 B Screws Sold Separately" / "Nickel6x3401 B Screws
-- Sold Separately". The real color is just the finish word before the first digit.
--   "Chrome6x3400 B Screws Sold Separately" -> "Chrome"
--   "Nickel6x3401 B Screws Sold Separately" -> "Nickel"

BEGIN;

UPDATE sku_attributes sa
SET value = TRIM(REGEXP_REPLACE(sa.value, '\d.*$', ''))
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'Hardware Resources'
  AND sa.value ~ 'Screws Sold Separately';

COMMIT;
