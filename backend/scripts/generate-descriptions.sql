-- ================================================================
-- Generate descriptions for Bedrosians (791 products)
-- and James Martin Vanities (400 products)
-- ================================================================

BEGIN;

-- ================================================================
-- BEDROSIANS: Porcelain Tile
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection = 'Magnifica Slabs' THEN
      'Large-format porcelain slab from the Magnifica collection by Bedrosians. Ideal for seamless countertops, feature walls, and statement flooring with minimal grout lines.'
    WHEN collection = 'Magnifica' THEN
      'Premium porcelain tile from the Magnifica collection by Bedrosians, offering the beauty of natural stone with the durability and low maintenance of porcelain.'
    WHEN collection IN ('Farmhouse Living', 'Cotto Nature') THEN
      'Rustic-inspired porcelain tile from the ' || collection || ' collection by Bedrosians. Captures the warmth of natural materials in a durable, low-maintenance porcelain format.'
    WHEN collection IN ('360', '90') THEN
      'Versatile porcelain tile from the ' || collection || ' collection by Bedrosians. A modern, minimalist tile suitable for floors, walls, and wet areas.'
    WHEN collection IN ('Sahara', 'Gemma', 'Strata', 'Poetry Stone', 'Ikonite', 'Bluerun', 'Thaddeus') THEN
      'Stone-inspired porcelain tile from the ' || collection || ' collection by Bedrosians. Delivers the elegance of natural stone with superior durability and easy maintenance.'
    WHEN collection IN ('Celine', 'Chroma', 'Allora') THEN
      'Decorative porcelain tile from the ' || collection || ' collection by Bedrosians. Features distinctive patterns and colorways for creating bold, design-forward spaces.'
    WHEN collection = 'Marin' THEN
      'Coastal-inspired porcelain tile from the Marin collection by Bedrosians. Soft, ocean-influenced tones ideal for bathrooms, kitchens, and living spaces.'
    ELSE
      'Porcelain tile from the ' || COALESCE(collection, 'Bedrosians') || ' collection by Bedrosians. Durable, versatile, and suitable for floors, walls, and wet areas in residential and commercial settings.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name = 'Porcelain Tile' AND p.description_short IS NULL
);

-- ================================================================
-- BEDROSIANS: Ceramic Tile
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection IN ('Casablanca', 'Zagora') THEN
      'Hand-painted style ceramic tile from the ' || collection || ' collection by Bedrosians. Intricate patterns inspired by traditional Mediterranean and Moroccan design.'
    WHEN collection = 'Cloe' THEN
      'Artisan ceramic tile from the Cloe collection by Bedrosians. Handmade character with subtle color variation, perfect for kitchen backsplashes and accent walls.'
    WHEN collection = 'Makoto' THEN
      'Japanese-inspired ceramic tile from the Makoto collection by Bedrosians. Organic forms and earthy glazes create a serene, handcrafted aesthetic.'
    WHEN collection = 'Reine' THEN
      'Elegant ceramic tile from the Reine collection by Bedrosians. Classic shapes with refined glazes for sophisticated wall applications.'
    WHEN collection IN ('Hedron', 'Triangolo') THEN
      'Geometric ceramic tile from the ' || collection || ' collection by Bedrosians. Bold dimensional shapes for creating eye-catching accent walls and backsplashes.'
    WHEN collection = 'Marin' THEN
      'Coastal-inspired ceramic tile from the Marin collection by Bedrosians. Soft, ocean-influenced tones ideal for bathrooms, kitchens, and living spaces.'
    ELSE
      'Ceramic tile from the ' || COALESCE(collection, 'Bedrosians') || ' collection by Bedrosians. Beautiful glazed finish for walls, backsplashes, and decorative accents.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name = 'Ceramic Tile' AND p.description_short IS NULL
);

-- ================================================================
-- BEDROSIANS: Natural Stone
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection = 'Jumbo Basketweave' THEN
      'Natural stone basketweave mosaic from the Jumbo Basketweave collection by Bedrosians. Classic pattern in an oversized format for floors, walls, and shower surrounds.'
    WHEN collection = 'Tumbled Ledgers' THEN
      'Tumbled natural stone ledger panel by Bedrosians. Stacked stone texture adds depth and character to accent walls, fireplaces, and exterior facades.'
    WHEN collection = 'Celeste' THEN
      'Natural stone tile from the Celeste collection by Bedrosians. Luminous tones and refined veining for elegant floors and wall applications.'
    WHEN collection = 'Atrium' THEN
      'Natural stone tile from the Atrium collection by Bedrosians. Classic beauty with unique veining patterns, ideal for grand entries and feature walls.'
    WHEN collection = 'Solis' THEN
      'Natural stone tile from the Solis collection by Bedrosians. Warm, sun-kissed tones with natural variation for inviting interior spaces.'
    WHEN collection IN ('Blomma', 'Monet', 'Matisse', 'Giotto') THEN
      'Artisan natural stone mosaic from the ' || collection || ' collection by Bedrosians. Intricate waterjet-cut patterns for decorative floors, walls, and accent installations.'
    WHEN collection = 'Ferrara' THEN
      'Premium natural stone from the Ferrara collection by Bedrosians. Italian-inspired elegance with distinctive veining for countertops, floors, and walls.'
    WHEN collection = 'Manhattan' THEN
      'Natural stone mosaic from the Manhattan collection by Bedrosians. Sophisticated geometric patterns for modern and transitional interiors.'
    WHEN collection = 'Modni' THEN
      'Modern natural stone mosaic from the Modni collection by Bedrosians. Clean lines and contemporary patterns for stylish accent installations.'
    WHEN collection = 'SLABQTE' OR name ILIKE '%slab%' THEN
      'Premium natural stone slab by Bedrosians. Sourced from the finest quarries worldwide, ideal for countertops, feature walls, and luxury flooring installations.'
    ELSE
      'Premium natural stone from Bedrosians. Each piece features unique natural veining and coloration, ideal for countertops, floors, walls, and accent installations.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name = 'Natural Stone' AND p.description_short IS NULL
);

-- ================================================================
-- BEDROSIANS: Mosaic Tile
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection = 'Manhattan' THEN
      'Mosaic tile from the Manhattan collection by Bedrosians. Sophisticated blends of natural stone and glass in refined geometric patterns.'
    WHEN collection = 'Kaikos' THEN
      'Mosaic tile from the Kaikos collection by Bedrosians. Oceanic-inspired glass and stone mosaics with flowing, organic compositions.'
    WHEN collection = 'Verve' THEN
      'Glass mosaic tile from the Verve collection by Bedrosians. Vibrant, high-gloss glass pieces for sparkling backsplashes and accent walls.'
    WHEN collection = 'Hamptons' THEN
      'Mosaic tile from the Hamptons collection by Bedrosians. Coastal elegance with refined patterns for sophisticated bathroom and kitchen designs.'
    WHEN collection = 'Man About You' THEN
      'Mosaic tile from the Man About You collection by Bedrosians. Contemporary mixed-material mosaics with distinctive texture and dimension.'
    ELSE
      'Mosaic tile from the ' || COALESCE(collection, 'Bedrosians') || ' collection by Bedrosians. Artful combinations of materials and patterns for backsplashes, accent walls, and decorative installations.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name = 'Mosaic Tile' AND p.description_short IS NULL
);

-- ================================================================
-- BEDROSIANS: Engineered Hardwood
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection IN ('Newport', 'Laguna', 'Bordeaux', 'Newport/Laguna/Bordeaux') THEN
      'Engineered hardwood flooring from the ' || collection || ' collection by Bedrosians. European-inspired wide planks with rich, natural wood character and exceptional dimensional stability.'
    WHEN collection = 'La Jolla' THEN
      'Engineered hardwood flooring from the La Jolla collection by Bedrosians. Coastal California style with warm tones and a naturally weathered finish.'
    WHEN collection = 'Solana' THEN
      'Engineered hardwood flooring from the Solana collection by Bedrosians. Sun-drenched tones and authentic wood grain for bright, inviting interiors.'
    WHEN collection = 'Maison' THEN
      'Engineered hardwood flooring from the Maison collection by Bedrosians. French-inspired elegance with premium wood species and artisan finishes.'
    ELSE
      'Engineered hardwood flooring from the ' || COALESCE(collection, 'Bedrosians') || ' collection by Bedrosians. Real wood beauty with engineered stability, perfect for living spaces, bedrooms, and dining areas.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name = 'Engineered Hardwood' AND p.description_short IS NULL
);

-- ================================================================
-- BEDROSIANS: LVP (Plank)
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection = 'Shorewood' THEN
      'Waterproof luxury vinyl plank from the Shorewood collection by Bedrosians. Realistic wood-look visuals with a durable, waterproof core for kitchens, bathrooms, and high-traffic areas.'
    WHEN collection = 'Woodland' THEN
      'Waterproof luxury vinyl plank from the Woodland collection by Bedrosians. Nature-inspired wood tones with superior scratch and water resistance for everyday living.'
    ELSE
      'Waterproof luxury vinyl plank from the ' || COALESCE(collection, 'Bedrosians') || ' collection by Bedrosians. Realistic wood-look design with waterproof performance for any room in the home.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name = 'LVP (Plank)' AND p.description_short IS NULL
);

-- ================================================================
-- BEDROSIANS: NULL category products
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN collection = 'Avondale' THEN
      'Brick-look tile from the Avondale collection by Bedrosians. Authentic thin brick character for industrial-chic accent walls, fireplaces, and exterior facades.'
    WHEN collection = 'Hemisphere' THEN
      'Natural pebble mosaic from the Hemisphere collection by Bedrosians. Smooth, river-tumbled stones for shower floors, outdoor spaces, and organic accent walls.'
    WHEN collection = 'Jumbo Ledgers' THEN
      'Natural stone ledger panel by Bedrosians. Large-format stacked stone for dramatic accent walls, fireplaces, and architectural facades.'
    WHEN collection = 'Nouvel' THEN
      'Mineral surface slab from the Nouvel collection by Bedrosians. Engineered for consistent color and pattern, ideal for countertops, vanities, and wall cladding.'
    WHEN collection IN ('Arabescado Dolce', 'Tahoe White') THEN
      'Engineered quartz surface by Bedrosians. Consistent pattern and exceptional durability for countertops, vanity tops, and wall applications.'
    WHEN collection IN ('Metropolitan', 'MANUFACTURER TEMPORARY OUT OF STOCK, ETA Q4 2023') THEN
      'Quarry tile from Bedrosians. Dense, unglazed tile with natural earth tones, ideal for commercial floors, kitchens, and high-traffic areas.'
    WHEN collection = 'Remy' THEN
      'Cement tile from Bedrosians. Artisan-crafted with an organic matte finish for distinctive floors, walls, and accent installations.'
    WHEN collection = 'Solana / La Jolla' THEN
      'Engineered hardwood flooring from the Solana / La Jolla collection by Bedrosians. Coastal California style with warm wood tones and authentic grain character.'
    WHEN collection = 'Waterbrook' THEN
      'Glass tile from the Waterbrook collection by Bedrosians. Luminous, handmade-style glass for stunning backsplashes, shower walls, and pool installations.'
    ELSE
      'Premium tile from the ' || COALESCE(collection, name) || ' collection by Bedrosians. Versatile and durable for residential and commercial applications.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'BEDRO' AND p.status = 'active'
    AND c.name IS NULL AND p.description_short IS NULL
);

-- ================================================================
-- JAMES MARTIN VANITIES: Vanity Tops (269 missing)
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN name ILIKE '%composite countertop%' THEN
      'Mineral composite vanity top by James Martin. Integrated basin with a smooth, non-porous surface that resists stains and is easy to clean.'
    WHEN name ILIKE '%makeup countertop%' THEN
      'Vanity makeup countertop by James Martin. Pairs with select vanity cabinets to create a dedicated grooming station with elegant stone or quartz surfaces.'
    WHEN name ILIKE '%silestone%' AND name ILIKE '%sink%' THEN
      'Silestone quartz vanity top by James Martin. Premium engineered quartz surface with integrated porcelain sink basin.'
    WHEN name ILIKE '%silestone%' THEN
      'Silestone quartz vanity top by James Martin. Premium engineered quartz surface with a polished finish, ready for your choice of sink.'
    WHEN name ILIKE '%carrara%' AND name ILIKE '%sink%' THEN
      'Carrara White marble vanity top by James Martin. Timeless Italian marble with soft grey veining, complete with integrated sink basin.'
    WHEN name ILIKE '%carrara%' THEN
      'Carrara White marble vanity top by James Martin. Timeless Italian marble with soft grey veining, ready for your choice of sink.'
    WHEN name ILIKE '%arctic fall%' AND name ILIKE '%sink%' THEN
      'Arctic Fall solid surface vanity top by James Martin. Clean white surface with subtle patterning, complete with integrated sink basin.'
    WHEN name ILIKE '%arctic fall%' THEN
      'Arctic Fall solid surface vanity top by James Martin. Clean white surface with subtle patterning, ready for your choice of sink.'
    WHEN name ILIKE '%charcoal%' OR name ILIKE '%soapstone%' THEN
      'Charcoal soapstone vanity top by James Martin. Rich, dark surface with a matte finish for a bold, contemporary bathroom statement.'
    WHEN name ILIKE '%eclos%' AND name ILIKE '%sink%' THEN
      'Eclos engineered vanity top by James Martin. Premium surface with organic veining, complete with integrated sink basin.'
    WHEN name ILIKE '%eclos%' THEN
      'Eclos engineered vanity top by James Martin. Premium surface with organic veining, ready for your choice of sink.'
    WHEN name ILIKE '%freepower%' OR name ILIKE '%wireless%' THEN
      'Vanity top with built-in FreePower wireless charging by James Martin. Seamlessly charge devices on your countertop surface.'
    WHEN name ILIKE '%linen top%' THEN
      'Compact vanity top by James Martin, designed for the Linen cabinet series. Premium surface material for powder rooms and small bathrooms.'
    WHEN name ILIKE '%double top%' THEN
      'Double-sink vanity top by James Martin. Designed for dual-basin configurations, available in premium stone and quartz materials.'
    WHEN name ILIKE '%single top%' AND name ILIKE '%sink%' THEN
      'Single vanity top by James Martin. Premium countertop surface with integrated sink basin, designed for select vanity cabinets.'
    WHEN name ILIKE '%single top%' THEN
      'Single vanity top by James Martin. Premium countertop surface designed to pair with select James Martin vanity cabinets.'
    WHEN name ILIKE '%single sink%' THEN
      'Vanity sink top by James Martin. Precision-cut surface with integrated basin for a clean, seamless bathroom design.'
    ELSE
      'Vanity top by James Martin. Premium countertop surface designed to complement James Martin vanity cabinetry with a refined, designer finish.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'JMV' AND p.status = 'active'
    AND c.name = 'Vanity Tops' AND p.description_short IS NULL
);

-- ================================================================
-- JAMES MARTIN VANITIES: Bath Accessories (128 missing)
-- ================================================================
UPDATE products SET description_short = 
  CASE
    WHEN name ILIKE '%shelves%' OR name ILIKE '%shelf%' THEN
      'Replacement shelves by James Martin. Custom-fit for select vanity and storage cabinet collections, adding organized interior storage.'
    WHEN name ILIKE '%cabinet base%' OR name ILIKE '%base for%' THEN
      'Cabinet base by James Martin. Metal support frame designed to elevate vanity cabinets for a modern, open-leg aesthetic.'
    WHEN name ILIKE '%console sink base%' THEN
      'Console sink base by James Martin. Metal frame support for wall-mount or open console vanity configurations with a sleek, modern profile.'
    WHEN name ILIKE '%console sink%' THEN
      'Console sink by James Martin. Elegant ceramic basin designed for open console vanity installations.'
    WHEN name ILIKE '%drawer unit%' OR name ILIKE '%drawer%' THEN
      'Drawer unit by James Martin. Additional pull-out storage designed to complement select vanity collections.'
    WHEN name ILIKE '%mirror%' THEN
      'Vanity mirror by James Martin. Framed to match select vanity collections for a cohesive, designer bathroom look.'
    WHEN name ILIKE '%wood sample%' OR name ILIKE '%stone sample%' OR name ILIKE '%sample%' THEN
      'Finish sample by James Martin. Order before purchasing to see the exact color, tone, and texture in your space.'
    WHEN name ILIKE '%rectangular sink%' OR name ILIKE '%oval sink%' OR (name ILIKE '%sink%' AND name NOT ILIKE '%console%') THEN
      'Sink by James Martin. Designed to pair with select James Martin vanity tops and countertops for a complete bathroom solution.'
    WHEN name ILIKE '%hutch%' OR name ILIKE '%tower%' THEN
      'Storage tower by James Martin. Vertical storage unit designed to coordinate with select vanity collections.'
    WHEN name ILIKE '%screw%' OR name ILIKE '%hardware%' THEN
      'Hardware kit by James Martin. Replacement or additional mounting hardware for select vanity collections.'
    WHEN name ILIKE '%leg%' OR name ILIKE '%feet%' OR name ILIKE '%foot%' THEN
      'Furniture legs by James Martin. Decorative support legs to elevate select vanity collections with a refined, furniture-style look.'
    WHEN name ILIKE '%knob%' OR name ILIKE '%pull%' OR name ILIKE '%handle%' THEN
      'Cabinet hardware by James Martin. Decorative knobs or pulls to personalize and accent your vanity cabinetry.'
    ELSE
      'Bath accessory by James Martin. Designed to complement James Martin vanity collections with coordinated style and premium quality.'
  END
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'JMV' AND p.status = 'active'
    AND c.name = 'Bath Accessories' AND p.description_short IS NULL
);

-- ================================================================
-- JAMES MARTIN VANITIES: Storage Cabinets (3 missing)
-- ================================================================
UPDATE products SET description_short = 
  'Storage cabinet by James Martin. Premium bathroom storage with coordinated finishes, soft-close doors, and adjustable shelving for organized, elegant interiors.'
WHERE id IN (
  SELECT p.id FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  JOIN categories c ON c.id = p.category_id
  WHERE v.code = 'JMV' AND p.status = 'active'
    AND c.name = 'Storage Cabinets' AND p.description_short IS NULL
);

COMMIT;
