-- Fix Elysium Tile Color attributes: the 11 edge cases skipped by migration 032.
-- These had model codes / packaging / grade notes / truncation mixed with size, so a
-- generic regex was unsafe. Each is remapped by hand to the EXISTING color convention
-- of its own collection's clean siblings (verified against the collection's other SKUs).
--   HLC Alchimia 5 - Grigio (2 PC) 24 x 48  -> "HLC Alchimia 5 - Grigio"   (sibling exists)
--   HTL Timeline 5 - Grey 24 x 48           -> "HTL Timeline 5 - Grey"     (sibling exists)
--   Item - Porcelain Tile 24 x 48           -> "Item - Porcelain Tile"     (sibling exists)
--   Ivory Grip R11 24 x 48 - 2ND CHOICE (…) -> "Ivory"                     (Arbia: Grey/Ivory/Sand)
--   Light (1 PC) 30 x 60                     -> "Light"                     (Oxyde sibling)
--   Matte 2 x 2 (Calacatta Blue)             -> "Matte"                     (Calacatta Blue sibling)
--   Matte 2 x 2 Square (Volakas Premium)     -> "Matte"                     (finish convention)
--   Matte 3 x 3 Hexagon (Volakas Premium)    -> "Matte Hexagon"            (hexagon convention)
--   Matte Hexagon Mosaic 3 x 3 - (Kraken)    -> "Matte Hexagon"            (Calacatta Blue convention)
--   Calacatta Gold Honed/Polished Pencil .75 x 12 -> drop " .75 x 12"       (Precious Stone style)
-- Grade note on the Arbia "2ND CHOICE" row is intentionally not kept in Color (it is
-- not a color); it remains in the product name / variant_name.

BEGIN;

-- helper: attribute + vendor scoped update by exact current value (+ collection where a
-- value string could otherwise be ambiguous across collections).
UPDATE sku_attributes sa SET value = 'Calacatta Gold Honed Pencil'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='Calacatta Gold Honed Pencil .75 x 12';

UPDATE sku_attributes sa SET value = 'Calacatta Gold Polished Pencil'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='Calacatta Gold Polished Pencil .75 x 12';

UPDATE sku_attributes sa SET value = 'HLC Alchimia 5 - Grigio'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='HLC Alchimia 5 - Grigio (2 PC) 24 x 48';

UPDATE sku_attributes sa SET value = 'HTL Timeline 5 - Grey'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='HTL Timeline 5 - Grey 24 x 48';

UPDATE sku_attributes sa SET value = 'Item - Porcelain Tile'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='Item - Porcelain Tile 24 x 48';

UPDATE sku_attributes sa SET value = 'Ivory'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='Ivory Grip R11 24 x 48 - 2ND CHOICE (Random Warpage/Bowing)';

UPDATE sku_attributes sa SET value = 'Light'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND sa.value='Light (1 PC) 30 x 60';

UPDATE sku_attributes sa SET value = 'Matte'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND p.collection='Calacatta Blue' AND sa.value='Matte 2 x 2';

UPDATE sku_attributes sa SET value = 'Matte'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND p.collection='Volakas Premium' AND sa.value='Matte 2 x 2 Square';

UPDATE sku_attributes sa SET value = 'Matte Hexagon'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND p.collection='Volakas Premium' AND sa.value='Matte 3 x 3 Hexagon';

UPDATE sku_attributes sa SET value = 'Matte Hexagon'
FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE sa.sku_id=s.id AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
  AND v.name='Elysium Tile' AND p.collection='Kraken' AND sa.value='Matte Hexagon Mosaic 3 x 3 -';

COMMIT;
