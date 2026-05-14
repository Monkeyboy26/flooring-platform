-- Migration 011: Add missing images for Bellezza mosaic SKUs
--
-- The scraper missed images for Penny Fosco (R242) and Penny Grafito (R243).
-- Images still exist on the vendor CDN but the products were delisted from
-- their website catalog. Found by URL pattern matching against the existing
-- Penny Calacatta Gold (R241) images.
--
-- Penny Fosco images found:
--   PENNY-Fosco-1.jpg (800x739) — close-up detail of penny rounds
--   PENNY-Fosco.jpg   (400x384) — full mosaic sheet flat-lay
--
-- Penny Grafito images found:
--   PENNY-Grafito-1.jpg (800x690) — close-up detail of penny rounds
--   PENNY-Grafito-s.jpg (400x401) — full mosaic sheet flat-lay
--
-- Still missing (no vendor images exist):
--   Chateau Mosaic (R295), LN520 Stacked Linear (R263),
--   Metallic Dark Grey Mosaic (R426), Milano Mosaic Gold (R237-GOLD),
--   Milano Mosaic Silver (R237-SILV)
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < database/migrations/011_add_missing_bellezza_mosaic_images.sql

BEGIN;

-- =============================================================================
-- Penny Fosco (R242) — product_id: 199e59af, sku_id: e03a1402
-- =============================================================================

INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order, source)
VALUES (
  '199e59af-6035-42fa-b000-7e4fb1ec497c',
  'e03a1402-eddb-43dd-9ce5-1b9ea84f797f',
  'primary',
  'https://bellezzaceramica.com/wp-content/uploads/2022/02/PENNY-Fosco-1.jpg',
  0,
  'manual'
);

INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order, source)
VALUES (
  '199e59af-6035-42fa-b000-7e4fb1ec497c',
  'e03a1402-eddb-43dd-9ce5-1b9ea84f797f',
  'alternate',
  'https://bellezzaceramica.com/wp-content/uploads/2022/02/PENNY-Fosco.jpg',
  1,
  'manual'
);

-- =============================================================================
-- Penny Grafito (R243) — product_id: b75ab88d, sku_id: 38e06c0e
-- =============================================================================

INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order, source)
VALUES (
  'b75ab88d-bea5-4367-9ae7-0be6615c7c44',
  '38e06c0e-28cf-4a3d-af3f-6599d55c00a1',
  'primary',
  'https://bellezzaceramica.com/wp-content/uploads/2022/02/PENNY-Grafito-1.jpg',
  0,
  'manual'
);

INSERT INTO media_assets (product_id, sku_id, asset_type, url, sort_order, source)
VALUES (
  'b75ab88d-bea5-4367-9ae7-0be6615c7c44',
  '38e06c0e-28cf-4a3d-af3f-6599d55c00a1',
  'alternate',
  'https://bellezzaceramica.com/wp-content/uploads/2022/02/PENNY-Grafito-s.jpg',
  1,
  'manual'
);

COMMIT;
