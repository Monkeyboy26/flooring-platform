-- Data-quality conformance cleanup — 2026-10-14
-- Reviewable record of fixes applied to the quality_violations buckets.
-- Already executed against LOCAL and PROD on 2026-10-14 (idempotent / guarded —
-- safe to re-run). Each block backs up what it touches into a *_backup_20261014
-- table before mutating. See memory: data-quality-conformance-cleanup.
--
-- NOTE: local and prod had DIVERGED — prod carried buckets local lacked
-- (carton-coverage-per-piece 370, placeholder-price 57, …). Blocks tagged
-- [PROD] were prod-only; [BOTH] ran on both DBs.
--
-- Run: docker exec -i flooring-db psql -U postgres -d flooring_pim < this.sql
--      (prod: pipe over ssh to the prod flooring-db container)

\set ON_ERROR_STOP on
BEGIN;

-- ============================================================================
-- [BOTH] variant-echoes-product: variant_name that repeats the product name
-- ("Copa Coast" / "Copa Coast" → doubled display). Exact echoes on single-SKU
-- products drop the redundant variant_name; prefix echoes trim to the suffix
-- ("Henley Pebble Tumbled" → "Tumbled"). Re-derives the echo set from data
-- (not violation-dependent), mirroring the quality rule's predicate.
-- ============================================================================
DROP TABLE IF EXISTS variant_echo_backup_20261014;
CREATE TABLE variant_echo_backup_20261014 AS
SELECT s.id AS sku_id, s.product_id, s.internal_sku, s.variant_name AS old_variant_name,
       p.name AS product_name,
       (SELECT COUNT(*) FROM skus s2
         WHERE s2.product_id = s.product_id AND s2.status='active' AND s2.is_sample IS NOT TRUE) AS sib_count
FROM skus s JOIN products p ON p.id = s.product_id
WHERE s.status='active' AND p.status='active' AND s.is_sample IS NOT TRUE AND s.variant_name IS NOT NULL
  AND (
    LOWER(TRIM(s.variant_name)) = LOWER(TRIM(p.name))
    OR LOWER(s.variant_name) LIKE LOWER(p.name) || ' %'
    OR LOWER(s.variant_name) LIKE LOWER(p.name) || ',%'
  );

-- exact echoes in single-SKU products → NULL
UPDATE skus s SET variant_name = NULL, updated_at = CURRENT_TIMESTAMP
FROM variant_echo_backup_20261014 b
WHERE s.id = b.sku_id AND b.sib_count = 1
  AND LOWER(TRIM(b.old_variant_name)) = LOWER(TRIM(b.product_name));

-- prefix echoes → keep only the distinguishing suffix
UPDATE skus s
SET variant_name = NULLIF(TRIM(REGEXP_REPLACE(TRIM(b.old_variant_name),
      '^'||REGEXP_REPLACE(b.product_name,'([.^$*+?()\[\]{}|\\])','\\\1','g')||'[ ,]*','','i')), ''),
    updated_at = CURRENT_TIMESTAMP
FROM variant_echo_backup_20261014 b
WHERE s.id = b.sku_id
  AND LOWER(TRIM(b.old_variant_name)) <> LOWER(TRIM(b.product_name));

-- ============================================================================
-- [BOTH] Confident singletons.
--   ROCA Grafito "Field 12X24"/"Field 24X48": price_basis per_unit → per_sqft
--     (every sibling SKU is per_sqft; the stored prices are per-sqft rates).
--   DAL Reservorio Lotus/Pebblestone (12x24 field tiles): mosaic-tile →
--     porcelain-tile (miscategorized; validator-endorsed).
--   AZT "Cashmere-N": unpriced + uncategorized "-N" orphan (no twin) → inactive.
-- ============================================================================
DROP TABLE IF EXISTS dq_confident_backup_20261014;
CREATE TABLE dq_confident_backup_20261014 (kind text, entity text, id uuid, field text, old_value text, new_value text);

INSERT INTO dq_confident_backup_20261014
SELECT 'pricing_basis', 'ROCA Grafito '||s.variant_name, pr.sku_id, 'price_basis', pr.price_basis, 'per_sqft'
FROM pricing pr JOIN skus s ON s.id=pr.sku_id JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE v.code='ROCA' AND p.name='Grafito' AND s.variant_name IN ('Field 12X24','Field 24X48') AND pr.price_basis='per_unit';
UPDATE pricing pr SET price_basis='per_sqft'
FROM skus s, products p, vendors v
WHERE pr.sku_id=s.id AND s.product_id=p.id AND p.vendor_id=v.id
  AND v.code='ROCA' AND p.name='Grafito' AND s.variant_name IN ('Field 12X24','Field 24X48') AND pr.price_basis='per_unit';

INSERT INTO dq_confident_backup_20261014
SELECT 'category', p.name, p.id, 'category_id', p.category_id::text, (SELECT id::text FROM categories WHERE slug='porcelain-tile')
FROM products p JOIN vendors v ON v.id=p.vendor_id JOIN categories c ON c.id=p.category_id
WHERE v.code='DAL' AND c.slug='mosaic-tile'
  AND p.name IN ('American Olean Reservorio Lotus','American Olean Reservorio Pebblestone');
UPDATE products p SET category_id=(SELECT id FROM categories WHERE slug='porcelain-tile'),
       category_source='classifier', category_needs_review=false, updated_at=CURRENT_TIMESTAMP
FROM vendors v, categories c
WHERE p.vendor_id=v.id AND p.category_id=c.id AND v.code='DAL' AND c.slug='mosaic-tile'
  AND p.name IN ('American Olean Reservorio Lotus','American Olean Reservorio Pebblestone');

INSERT INTO dq_confident_backup_20261014
SELECT 'deactivate', p.name, p.id, 'status', p.status, 'inactive'
FROM products p JOIN vendors v ON v.id=p.vendor_id
WHERE v.code='AZT' AND p.name='Cashmere-N' AND p.category_id IS NULL;
UPDATE skus s SET status='inactive', updated_at=CURRENT_TIMESTAMP
FROM products p JOIN vendors v ON v.id=p.vendor_id
WHERE s.product_id=p.id AND p.vendor_id=v.id AND v.code='AZT' AND p.name='Cashmere-N' AND p.category_id IS NULL;
UPDATE products p SET status='inactive', updated_at=CURRENT_TIMESTAMP
FROM vendors v WHERE p.vendor_id=v.id AND v.code='AZT' AND p.name='Cashmere-N' AND p.category_id IS NULL;

-- ============================================================================
-- [PROD] carton-coverage-per-piece (370 MSI, "832 per-piece leak"): sqft_per_box
-- held ONE piece's area instead of the carton total (Urbano Pure 4x12 = 0.323
-- instead of 10), a ~30× under-coverage + under-price. Applied by syncing LOCAL's
-- verified-correct sqft_per_box by internal_sku. The reproducible equivalent
-- (name-parsed piece area × pieces) is exactly what the rule stores as
-- detail->>'expected_sqft_per_box'; use that form to re-apply:
-- ----------------------------------------------------------------------------
-- DROP TABLE IF EXISTS packaging_backup_msi_carton_20261014;
-- CREATE TABLE packaging_backup_msi_carton_20261014 AS
--   SELECT pk.sku_id, s.internal_sku, pk.sqft_per_box AS old_sqft_per_box
--   FROM packaging pk JOIN skus s ON s.id=pk.sku_id JOIN quality_violations qv ON qv.sku_id=pk.sku_id
--   WHERE qv.status='open' AND qv.rule_key='carton-coverage-per-piece';
-- UPDATE packaging pk SET sqft_per_box = (qv.detail->>'expected_sqft_per_box')::numeric
--   FROM quality_violations qv
--   WHERE pk.sku_id = qv.sku_id AND qv.status='open' AND qv.rule_key='carton-coverage-per-piece';

-- ============================================================================
-- [PROD] placeholder-price (57: 47 $0/$0 + 10 $1.00-sentinel): delete the fake
-- pricing row so the item becomes call-for-pricing (NO pricing row) instead of a
-- purchasable "$0.00" / below-cost fake. Backs up the full rows first.
-- ============================================================================
DROP TABLE IF EXISTS pricing_placeholder_backup_20261014;
CREATE TABLE pricing_placeholder_backup_20261014 AS
SELECT pr.*, s.internal_sku, v.code AS vendor_code, p.name AS product_name
FROM pricing pr JOIN skus s ON s.id=pr.sku_id JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
WHERE pr.sku_id IN (
  SELECT qv.sku_id FROM quality_violations qv
  WHERE qv.status='open' AND qv.rule_key='placeholder-price' AND qv.sku_id IS NOT NULL
);
DELETE FROM pricing pr
WHERE pr.sku_id IN (
  SELECT qv.sku_id FROM quality_violations qv
  WHERE qv.status='open' AND qv.rule_key='placeholder-price' AND qv.sku_id IS NOT NULL
);

COMMIT;

-- After applying, reconcile the violation table:
--   docker exec -w /app flooring-api node run-quality-audit.mjs
