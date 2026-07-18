-- Migration: Prepend collection name to generic product names
-- Fixes products with generic names (e.g., "White") by prepending the collection
-- (e.g., "White" in collection "Anthea" → "Anthea White")
--
-- Affects: Arizona Tile, Bedrosians Tile, Elysium Tile, Bosphorus Imports
-- Safe: skips products that already start with collection name, or where name = collection

BEGIN;

UPDATE products
SET name = collection || ' ' || name,
    updated_at = CURRENT_TIMESTAMP
WHERE vendor_id IN (
  SELECT id FROM vendors WHERE name IN (
    'Arizona Tile', 'Bedrosians Tile', 'Elysium Tile', 'Bosphorus Imports'
  )
)
AND collection IS NOT NULL AND collection <> ''
AND NOT name ILIKE collection || ' %'
AND name <> collection;

COMMIT;

-- After committing, refresh search vectors for renamed products:
-- SELECT refresh_search_vectors(id) FROM products
-- WHERE vendor_id IN (SELECT id FROM vendors WHERE name IN (
--   'Arizona Tile', 'Bedrosians Tile', 'Elysium Tile', 'Bosphorus Imports'
-- ))
-- AND updated_at > NOW() - INTERVAL '5 minutes';
