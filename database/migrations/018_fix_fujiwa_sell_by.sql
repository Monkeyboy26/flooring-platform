-- Fix Fujiwa pool tile sell_by and price_basis
-- Pool tiles are priced per sqft; accessories/mosaics stay as per_unit
--
-- The color-variants script inherited sell_by='unit' and price_basis='per_unit'
-- from templates that were incorrectly configured. This fixes both fields for
-- all Pool Tile collection SKUs except Pebblestone (which is genuinely per-unit).
--
-- Unchanged: Pebblestone (unit), Depth Markers (unit), Skimmer Kits (unit),
--            Trims (unit), Watermark Mosaics (unit)

BEGIN;

-- Step 1: Fix sell_by on pool tile SKUs (except Pebblestone)
UPDATE skus
SET    sell_by = 'sqft',
       updated_at = CURRENT_TIMESTAMP
WHERE  sell_by = 'unit'
  AND  id IN (
    SELECT s.id
    FROM   skus s
    JOIN   products p ON s.product_id = p.id
    JOIN   vendors v ON p.vendor_id = v.id
    WHERE  v.code = 'FUJIWA'
      AND  p.collection = 'Pool Tile'
      AND  p.name <> 'Pebblestone'
  );

-- Step 2: Fix price_basis on pool tile pricing (except Pebblestone)
UPDATE pricing
SET    price_basis = 'per_sqft'
WHERE  price_basis = 'per_unit'
  AND  sku_id IN (
    SELECT s.id
    FROM   skus s
    JOIN   products p ON s.product_id = p.id
    JOIN   vendors v ON p.vendor_id = v.id
    WHERE  v.code = 'FUJIWA'
      AND  p.collection = 'Pool Tile'
      AND  p.name <> 'Pebblestone'
  );

COMMIT;
