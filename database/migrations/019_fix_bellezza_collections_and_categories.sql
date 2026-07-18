-- Migration 019: Fix Bellezza collection names and add missing categories
--
-- Three issues:
-- 1. Collection names: every product has collection = product name instead of
--    proper collection groupings (e.g. all Calacatta variants should share
--    collection 'Calacatta', Hex XL variants share 'Hex XL', etc.)
-- 2. Missing trim-accessories category: Schluter Trim + MAPEI Grout have NULL category
-- 3. Missing wall-panels category: MDF/WPC/BPC panels have NULL category
--
-- Also fixes mosaic-only products still in porcelain-tile (supplements migration 008
-- for any products it missed, e.g. Hex XL, Penny, Milano Mosaic, etc.)
--
-- Run: docker exec -i flooring-platform-db-1 psql -U postgres -d flooring_pim < database/migrations/019_fix_bellezza_collections_and_categories.sql

BEGIN;

-- =============================================================================
-- STEP 1: Create missing categories
-- =============================================================================

-- Trim & Accessories under Installation & Sundries
INSERT INTO categories (id, parent_id, name, slug, sort_order)
VALUES (
  '650e8400-e29b-41d4-a716-446655440119',
  '650e8400-e29b-41d4-a716-446655440110',  -- Installation & Sundries
  'Trim & Accessories', 'trim-accessories', 9
) ON CONFLICT (slug) DO NOTHING;

-- Wall Panels (top-level)
INSERT INTO categories (id, parent_id, name, slug, sort_order)
VALUES (
  '650e8400-e29b-41d4-a716-446655440120',
  NULL,
  'Wall Panels', 'wall-panels', 12
) ON CONFLICT (slug) DO NOTHING;

-- =============================================================================
-- STEP 2: Fix collection names for existing Bellezza products
-- =============================================================================

UPDATE products SET collection = 'Calacatta'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Calacatta Gold','Calacatta Gloss','Calacatta Hex Gloss','Calacatta Natural','Calacatta Brick Gloss');

UPDATE products SET collection = 'Austral'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Austral Blanco','Austral Essence Blanco');

UPDATE products SET collection = 'Granby'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Granby Beige','Granby Ivory');

UPDATE products SET collection = 'Hex XL'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Hex XL Coimbra','Hex XL Fosco','Hex XL Inverno Grey');

UPDATE products SET collection = 'Penny Round'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Penny Calacatta Gold','Penny Fosco','Penny Grafito');

UPDATE products SET collection = 'NatureGlass'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('NatureGlass Hex','Silver Matte Hex','Statuario Matte Hex');

UPDATE products SET collection = 'Recycled Glass'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Antwerp','Camden','Grande','Hudson','Nord','Park');

UPDATE products SET collection = 'Wall Panels'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Acoustic MDF Sound Absorption Panel','Exterior Composite Wall Panel','BPC Interior Panel');

UPDATE products SET collection = 'Metal Mosaic'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Metallic Dark Grey Mosaic','Stainless Gold Hexagon Mosaic');

-- Standalone name cleanups (strip color suffix from collection name)
UPDATE products SET collection = CASE name
  WHEN 'Anima Antracita' THEN 'Anima'
  WHEN 'Arena Chiaro' THEN 'Arena'
  WHEN 'Armani White' THEN 'Armani'
  WHEN 'Bolonia Marengo' THEN 'Bolonia'
  WHEN 'Connor Beige' THEN 'Connor'
  WHEN 'Elegance Marble Pearl' THEN 'Elegance Marble'
  WHEN 'Enigma White' THEN 'Enigma'
  WHEN 'Larin Marfil' THEN 'Larin'
  WHEN 'Laurent Black' THEN 'Laurent'
  WHEN 'MAPEI Grout Medium Grey' THEN 'MAPEI Grout'
  WHEN 'Magna White' THEN 'Magna'
  WHEN 'Markina Gold' THEN 'Markina'
  WHEN 'Marmo Marfil' THEN 'Marmo'
  WHEN 'Milano Crema' THEN 'Milano'
  WHEN 'Modern Concrete Ivory' THEN 'Modern Concrete'
  WHEN 'Montblanc Gold' THEN 'Montblanc'
  WHEN 'Naples White' THEN 'Naples'
  WHEN 'Scanda White' THEN 'Scanda'
  WHEN 'Sekos White' THEN 'Sekos'
  WHEN 'Sun Blanco' THEN 'Sun'
  WHEN 'Unique Ceppo Bone' THEN 'Unique Ceppo'
  WHEN 'Westmount Beige' THEN 'Westmount'
  WHEN 'LN520 Stacked Linear' THEN 'LN520'
  WHEN 'Insignia White' THEN 'Insignia'
  WHEN 'Kube Blanco' THEN 'Kube'
  WHEN 'Kyoto White' THEN 'Kyoto'
  WHEN 'Odissey Saphire' THEN 'Odissey'
  WHEN 'Dorset Hexagon' THEN 'Dorset'
  WHEN 'Nero Marquina Matte Hexagon' THEN 'Nero Marquina'
END
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN (
    'Anima Antracita','Arena Chiaro','Armani White','Bolonia Marengo',
    'Connor Beige','Elegance Marble Pearl','Enigma White',
    'Larin Marfil','Laurent Black','MAPEI Grout Medium Grey','Magna White',
    'Markina Gold','Marmo Marfil','Milano Crema','Modern Concrete Ivory',
    'Montblanc Gold','Naples White','Scanda White','Sekos White',
    'Sun Blanco','Unique Ceppo Bone','Westmount Beige','LN520 Stacked Linear',
    'Insignia White','Kube Blanco','Kyoto White','Odissey Saphire',
    'Dorset Hexagon','Nero Marquina Matte Hexagon'
  );

-- Undo thematic groupings from prior migration — each product should be its
-- own collection (or share a family name set above). Setting collection = name
-- for all products still in broad thematic buckets.
UPDATE products SET collection = name
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND collection IN ('Marble Look', 'Concrete & Industrial', 'Stone Look',
                     'Subway & Artisan', 'Hexagon & Mosaic', 'Wood Look');

-- WG001 is porcelain, not recycled glass
UPDATE products SET collection = 'WG001'
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name = 'WG001';

-- =============================================================================
-- STEP 3: Fix category assignments
-- =============================================================================

-- Porcelain mosaic-only products → Mosaic Tile
-- (Supplements migration 008 for products it didn't cover)
UPDATE products SET category_id = '650e8400-e29b-41d4-a716-446655440014'  -- Mosaic Tile
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN (
    'Milano Mosaic','Hex XL Coimbra','Hex XL Fosco','Hex XL Inverno Grey',
    'Penny Calacatta Gold','Penny Fosco','Penny Grafito',
    'Black Marble Mosaic','Chateau Mosaic',
    'NatureGlass Hex','Silver Matte Hex','Statuario Matte Hex',
    'LN520 Stacked Linear',
    'Dorset Hexagon','Nero Marquina Matte Hexagon',
    'Metallic Dark Grey Mosaic','Stainless Gold Hexagon Mosaic'
  );

-- Trim products → Trim & Accessories
UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'trim-accessories')
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Schluter Trim','MAPEI Grout Medium Grey');

-- Wall panels → Wall Panels
UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'wall-panels')
WHERE vendor_id = (SELECT id FROM vendors WHERE code = 'BELLEZZA')
  AND name IN ('Acoustic MDF Sound Absorption Panel','Exterior Composite Wall Panel','BPC Interior Panel');

COMMIT;
