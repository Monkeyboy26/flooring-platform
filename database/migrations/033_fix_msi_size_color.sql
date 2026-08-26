-- Fix MSI Surfaces Color attributes: conservative safe-subset.
-- MSI imported the full product descriptor into Color, including thickness (Nmm) and
-- chip size (N"), e.g. "Stella Blanca 6mm", "Black 2\" Hexagon", "Esperanza 2\" Hexagon 6mm".
-- We strip those size tokens (thickness + inch chip size); shape/finish descriptors
-- (Hexagon, Scallop, Glossy, ...) are left as-is since they are not size info.
--
-- SAFE-SUBSET GUARD: only rewrite when the stripped result is a clean, letters-only
-- value that is not a bare finish word. (All 33 current rows pass; guard is defensive.)
--   "Stella Blanca 6mm"        -> "Stella Blanca"
--   "Citi Stax Greige 3mm"     -> "Citi Stax Greige"
--   "Black 2\" Hexagon"         -> "Black Hexagon"
--   "Esperanza 2\" Hexagon 6mm" -> "Esperanza Hexagon"

BEGIN;

UPDATE sku_attributes sa
SET value = REGEXP_REPLACE(
              TRIM(REGEXP_REPLACE(
                REGEXP_REPLACE(sa.value, '\s*[0-9]+\s*"', ' ', 'g'),
                '\s*[0-9]+\s*mm', '', 'gi')),
              '\s+', ' ', 'g')
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'MSI Surfaces'
  AND sa.value ~* '[0-9]\s*"|[0-9]\s*mm'
  AND REGEXP_REPLACE(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(sa.value, '\s*[0-9]+\s*"', ' ', 'g'), '\s*[0-9]+\s*mm', '', 'gi')), '\s+', ' ', 'g')
        ~ '^[A-Za-z][A-Za-z ]*[A-Za-z]$'
  AND lower(REGEXP_REPLACE(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(sa.value, '\s*[0-9]+\s*"', ' ', 'g'), '\s*[0-9]+\s*mm', '', 'gi')), '\s+', ' ', 'g'))
        NOT IN ('matte','honed','polished','glossy','glass','satin');

COMMIT;
