-- Grace corner sku displayed as "24" x 24" Square" — the vendor sku/desc say
-- "Square CORNER" (custom border-frame corner block, pairs with the ML-81
-- Grace borders). "Square" alone promised a square MEDALLION no photo could
-- honor. Name the product truthfully; the installed-border photo then shows
-- exactly what the piece is. Idempotent.
BEGIN;
UPDATE skus s SET variant_name = '24" x 24" Border Corner (Custom)', updated_at = CURRENT_TIMESTAMP
FROM products p, vendors v
WHERE s.vendor_sku = 'MM-18-Grace-24"SQ Corner'
  AND p.id = s.product_id AND v.id = p.vendor_id AND v.code = 'STPR'
  AND s.variant_name IS DISTINCT FROM '24" x 24" Border Corner (Custom)';
COMMIT;
SELECT s.vendor_sku, s.variant_name FROM skus s WHERE s.vendor_sku = 'MM-18-Grace-24"SQ Corner';
