-- Fix Elysium Tile Color attributes: conservative safe-subset.
-- Elysium imported the full product descriptor into Color, with the mosaic chip /
-- tile dimension appended, e.g. "Basalt 2 x 2", "Calacatta White Soft 2 x 2 Hexagon".
-- The dimension already lives in the Size attribute, so we strip the trailing
-- "N x N" (optionally followed by a Hexagon/Square shape token).
--
-- SAFE-SUBSET GUARD: only rewrite when the stripped result is a clean, letters-only
-- color that is not a bare finish word. This deliberately SKIPS the unrecoverable
-- edge cases, which are left untouched for manual handling:
--   - model codes / grade notes:  "HLC Alchimia 5 - Grigio (2 PC) 24 x 48",
--                                  "Ivory Grip R11 24 x 48 - 2ND CHOICE (...)"
--   - packaging counts:            "Light (1 PC) 30 x 60"
--   - non-colors:                  "Item - Porcelain Tile 24 x 48"
--   - truncated (lost the color):  "Matte 2 x 2", "Matte 3 x 3 Hexagon"
--   - leading-dot fractions:       "... Pencil .75 x 12"  (dimension not stripped)
-- Fixes ~91 distinct color values.

BEGIN;

UPDATE sku_attributes sa
SET value = TRIM(REGEXP_REPLACE(sa.value, '\s+\d+(\.\d+)?\s*x\s*\d+(\s+(Hexagon|Square))?\s*$', '', 'i'))
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'Elysium Tile'
  AND sa.value ~* '\d\s*[xX]\s*\d'
  AND TRIM(REGEXP_REPLACE(sa.value, '\s+\d+(\.\d+)?\s*x\s*\d+(\s+(Hexagon|Square))?\s*$', '', 'i'))
        ~ '^[A-Za-z][A-Za-z ]*[A-Za-z]$'
  AND lower(TRIM(REGEXP_REPLACE(sa.value, '\s+\d+(\.\d+)?\s*x\s*\d+(\s+(Hexagon|Square))?\s*$', '', 'i')))
        NOT IN ('matte','honed','polished','glossy','soft','naturale','satin','item');

COMMIT;
