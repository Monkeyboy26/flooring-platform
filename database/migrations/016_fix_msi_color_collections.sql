-- Migration 016: Fix MSI color-word collection groupings
-- ~98 products have color words as collection names (White, Black, Gray, etc.)
-- caused by the scraper's H1 heuristic taking only the first word of the product name.
-- Additionally, 12 LVP products have collection='Wayne' instead of 'Parc'/'Parc Res.'
--
-- Products remaining in the original color-word collection after these updates
-- are genuinely generic solid-color tiles (e.g. "White Glossy 2x2") where
-- grouping by color is correct.

BEGIN;

-- ============================================================
-- Wayne → Parc / Parc Res.
-- ============================================================
UPDATE products SET collection = 'Parc'
  WHERE collection = 'Wayne' AND name LIKE 'Parc -%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Parc Res.'
  WHERE collection = 'Wayne' AND name LIKE 'Parc Res.-%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- ============================================================
-- White sub-groups (27 products move out, 20 stay as "White")
-- ============================================================
UPDATE products SET collection = 'White Oak'
  WHERE collection = 'White' AND name LIKE 'White Oak%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'White Quarry'
  WHERE collection = 'White' AND name LIKE 'White Quarry%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'White Vena'
  WHERE collection = 'White' AND name LIKE 'White Vena%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'White Wave'
  WHERE collection = 'White' AND name LIKE 'White Wave%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'White And Black'
  WHERE collection = 'White' AND name LIKE 'White And Black%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'White And Gray'
  WHERE collection = 'White' AND name LIKE 'White And Gray%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- Remaining "White Glossy/Matte/Polished/Pebbles/2x*" stay as collection='White'

-- ============================================================
-- Black sub-groups (5 products move out, 12 stay as "Black")
-- ============================================================
UPDATE products SET collection = 'Black Oak'
  WHERE collection = 'Black' AND name LIKE 'Black Oak%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Black With Vein'
  WHERE collection = 'Black' AND name LIKE 'Black With Vein%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Black And White'
  WHERE collection = 'Black' AND name LIKE 'Black And White%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Black Galaxy'
  WHERE collection = 'Black' AND name LIKE 'Black Galaxy%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- Remaining "Black (Prem)/Glossy/Matte/Pebbles/2x*" stay as collection='Black'

-- ============================================================
-- Blue sub-groups (all 5 move out)
-- ============================================================
UPDATE products SET collection = 'Blue Shimmer'
  WHERE collection = 'Blue' AND name LIKE 'Blue Shimmer%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Blue Pearl'
  WHERE collection = 'Blue' AND name LIKE 'Blue Pearl%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- ============================================================
-- Gold sub-groups (all 4 move out)
-- ============================================================
UPDATE products SET collection = 'Gold Rush'
  WHERE collection = 'Gold' AND name LIKE 'Gold Rush%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Gold Green'
  WHERE collection = 'Gold' AND name LIKE 'Gold Green%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- ============================================================
-- Gray sub-groups (3 products move out, 8 stay as "Gray")
-- ============================================================
UPDATE products SET collection = 'Gray Oak'
  WHERE collection = 'Gray' AND name LIKE 'Gray Oak%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Gray Cliff'
  WHERE collection = 'Gray' AND name LIKE 'Gray Cliff%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- Remaining "Gray Glossy/Matte/Scallop" stay as collection='Gray'

-- ============================================================
-- Silver sub-groups (7 products move out, 3 stay as "Silver")
-- ============================================================
UPDATE products SET collection = 'Silver Travertine'
  WHERE collection = 'Silver' AND name LIKE 'Silver Travertine%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Silver Canyon'
  WHERE collection = 'Silver' AND name LIKE 'Silver Canyon%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Silver Canvas'
  WHERE collection = 'Silver' AND name LIKE 'Silver Canvas%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Silver Shadow'
  WHERE collection = 'Silver' AND name = 'Silver Shadow'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Silver Tip'
  WHERE collection = 'Silver' AND name = 'Silver Tip'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Silver Aluminum'
  WHERE collection = 'Silver' AND name LIKE 'Silver Aluminum%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- Remaining "Silver 2x4/Herringbone/Splitface" stay as collection='Silver'

-- ============================================================
-- Ivory sub-groups (all 3 move out)
-- ============================================================
UPDATE products SET collection = 'Ivory Amber'
  WHERE collection = 'Ivory' AND name LIKE 'Ivory Amber%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Ivory Iridescent'
  WHERE collection = 'Ivory' AND name = 'Ivory Iridescent'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

UPDATE products SET collection = 'Ivory White'
  WHERE collection = 'Ivory' AND name LIKE 'Ivory White%'
  AND vendor_id = '550e8400-e29b-41d4-a716-446655440001';

-- ============================================================
-- Almond: both "Almond Glossy *" stay as collection='Almond'
-- (same material in different shapes — correct grouping)
-- ============================================================

COMMIT;
