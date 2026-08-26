-- Fix Elysium Tile Color attributes: Plus One thickness/format contamination.
-- These use "cm"/"mm" thickness (+ "Paver Rectified" format) which the earlier
-- NxN/inch strip (032) and the mm edge-case pass did not catch.
--   Plus One collection has bare-shade siblings ("Ash","Chalk","Greige"), so the
--   "2cm Paver Rectified" rows collapse onto them:
--     "Ash 2cm Paver Rectified"    -> "Ash"
--     "Chalk 2cm Paver Rectified"  -> "Chalk"
--     "Greige 2cm Paver Rectified" -> "Greige"
--   The "Plus One 8mm" collection names every color "Plus One <shade> 8mm"; strip only
--   the size token, keeping the in-collection convention:
--     "Plus One Ash 8mm"    -> "Plus One Ash"     (also Chalk / Greige / Plumb)
--
-- Deliberately NOT touched (verified NOT size contamination — legitimate Elysium
-- naming): face/pattern numbers (HLC Alchimia 5 - Grigio, AR 5 - Gray, 389 Bone),
-- product/SKU codes (HAO260 Bianco, OB01 Beige), version-style line names (Zero.3,
-- Stones & More 2.0, Neutra 02.Polvere), and R-slip ratings (Biotech ... R9).

BEGIN;

-- 2cm Paver Rectified -> bare shade (collapses onto existing Plus One siblings)
UPDATE sku_attributes sa
SET value = TRIM(REGEXP_REPLACE(sa.value, '\s+2cm Paver Rectified$', '', 'i'))
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND p.collection='Plus One'
  AND sa.value ~* '2cm Paver Rectified$';

-- Plus One 8mm line -> strip trailing thickness token only
UPDATE sku_attributes sa
SET value = TRIM(REGEXP_REPLACE(sa.value, '\s+8mm$', '', 'i'))
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND p.collection='Plus One 8mm'
  AND sa.value ~* '\s8mm$';

COMMIT;
