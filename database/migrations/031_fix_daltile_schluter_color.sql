-- Fix Daltile Color attributes: Schluter trim profiles had the profile part-number
-- (model + height/length code) appended to the finish, e.g.
--   "Black TVL42GS110/100"        -> "Black"
--   "Aluminum TAB10/150"          -> "Aluminum"
--   "Brass T9/14M"                -> "Brass"
--   "Brushed Antique Bronze EV/QF8/50ABGB" -> "Brushed Antique Bronze"
-- Schluter finishes are always pure words, so we strip from the first whitespace-
-- delimited token that contains a digit onward. Yields 21 clean finishes.
-- Also covers one Color Fast Industries trim row ("No Color EZ-BASE-1/2" -> "No Color")
-- which shares the same code-appended shape.
-- NOTE: one Marazzi Middleton row ("S44c9 12\" Side") is left untouched — no
-- recoverable color there (leading token is itself a code); handle manually.

BEGIN;

UPDATE sku_attributes sa
SET value = TRIM(REGEXP_REPLACE(sa.value, '\s+\S*[0-9]\S*.*$', ''))
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'Daltile'
  AND (p.name ILIKE 'Schluter%' OR sa.value = 'No Color EZ-BASE-1/2')
  AND sa.value ~* '(\d\s*mm\b)|(\d\s*")|(\d\s*[xX]\s*\d)|(\d+/\d+)'
  -- guard: only rewrite when a non-empty alphabetic finish remains
  AND TRIM(REGEXP_REPLACE(sa.value, '\s+\S*[0-9]\S*.*$', '')) ~ '[A-Za-z]';

COMMIT;
