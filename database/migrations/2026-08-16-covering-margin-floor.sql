-- Covering retail margin floor: retail must clear at least $0.99 over cost on
-- covering products (owner rule 2026-08-16, extends the carpet $1/sqft floor).
-- See [[covering-margin-floor]]. Going-forward enforcement lives in
-- upsertPricing() (base.js); this is the one-time backfill of rows already
-- under floor. Only touches rows with a real retail AND a real cost — never
-- invents a price on a $0 (unpriced) or unknown-cost row. Nickel-rounded UP so
-- the result never sits back under the floor. Skips retail_locked rows (manually
-- set / Home-Depot-matched prices), mirroring the retail_locked guard in
-- upsertPricing's UPDATE.

-- 1) Products sold BY AREA (per_sqft / sqft): flooring, wall & field tile.
--    Floor is $0.99 per square foot — the exact per-area parallel of carpet's $9/sqyd.
UPDATE pricing SET
  retail_price = ROUND(CEIL((cost + 0.99) / 0.05) * 0.05, 2)
WHERE price_basis IN ('per_sqft', 'sqft')
  AND retail_price > 0 AND cost > 0
  AND retail_price < cost + 0.99
  AND NOT COALESCE(retail_locked, false);

-- 2) Per-sheet mosaics / stacked stone (price_basis per_unit): floored $0.99 per
--    sheet. per_unit alone is ambiguous (also holds accessories / hardware /
--    trim, which must NOT be floored), so restrict to genuine sheet coverings —
--    variant_type='mosaic', a mosaic/stacked-stone category, or a "mosaic" name —
--    and exclude trim pieces by name (mirrors isTrimPiece / TRIM_NAME_RE in base.js).
UPDATE pricing p SET
  retail_price = ROUND(CEIL((p.cost + 0.99) / 0.05) * 0.05, 2)
FROM skus s
JOIN products pr ON pr.id = s.product_id
LEFT JOIN categories c ON c.id = pr.category_id
WHERE p.sku_id = s.id
  AND p.price_basis IN ('per_unit', 'unit')
  AND p.retail_price > 0 AND p.cost > 0
  AND p.retail_price < p.cost + 0.99
  AND NOT COALESCE(p.retail_locked, false)
  AND ( s.variant_type = 'mosaic'
        OR c.slug IN ('mosaic-tile', 'stacked-stone')
        OR pr.name ~* 'mosaic'
        OR COALESCE(s.variant_name, '') ~* 'mosaic' )
  AND NOT ( (pr.name || ' ' || COALESCE(s.variant_name, '')) ~*
            'bullnose|pencil|liner|listell|cove ?base|quarter ?round|chair ?rail|jolly|v-?cap|moulding|molding|stair|trim|\mrail\M' );
