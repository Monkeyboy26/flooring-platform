-- Fix Johnson Hardwood Color attributes: moulding accessories had the moulding
-- type + length stored as the color instead of the wood color, e.g.
--   "T Mold 78\"" / "T Mold 94\""  ->  the wood color of the parent product.
-- Johnson field SKUs use the bare color word (e.g. "Bark"), while the product name
-- carries a "Johnson Hardwood " prefix ("Johnson Hardwood Bark"), so we derive the
-- clean color by stripping that prefix from products.name.
-- Affects 143 moulding accessory SKUs.

BEGIN;

UPDATE sku_attributes sa
SET value = REGEXP_REPLACE(p.name, '^Johnson Hardwood ', '')
FROM skus s
JOIN products p ON p.id = s.product_id
JOIN vendors v ON v.id = p.vendor_id
WHERE sa.sku_id = s.id
  AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
  AND v.name = 'Johnson Hardwood'
  AND sa.value ~ '^T Mold '
  AND p.name LIKE 'Johnson Hardwood %';

COMMIT;
