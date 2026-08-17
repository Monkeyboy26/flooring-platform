-- Apply the $0.99-over-cost covering floor to Home-Depot-matched (retail_locked)
-- products (owner, 2026-08-16). The covering-floor and 9-ending backfills both
-- SKIPPED retail_locked rows to preserve the exact HD match; the owner has since
-- decided margin protection wins — a locked price may never sit under cost+$0.99.
-- Raise each under-floor locked covering row to the smallest 9-ending value that
-- clears the floor (so it still ends in a 9). Only RAISES; never lowers a locked
-- price that already clears the floor. See [[covering-margin-floor]] / [[nine-ending-prices]].
--
-- All 107 under-floor locked rows are MSI per_sqft LVP; the guard is scoped to
-- covering bases (per_sqft/sqft + per_unit mosaics) to match the floor's scope.
-- Going-forward enforcement lives in upsertPricing() (GREATEST guard on the
-- retail_locked branch).

-- Area coverings (per_sqft / sqft).
UPDATE pricing SET
  retail_price = (CEIL((ROUND((cost + 0.99) * 100) - 9) / 10.0) * 10 + 9) / 100.0
WHERE COALESCE(retail_locked, false)
  AND price_basis IN ('per_sqft', 'sqft')
  AND retail_price > 0 AND cost > 0
  AND retail_price < cost + 0.99;

-- Per-sheet mosaics / stacked stone (per_unit coverings only; excludes trim/accessories).
UPDATE pricing p SET
  retail_price = (CEIL((ROUND((p.cost + 0.99) * 100) - 9) / 10.0) * 10 + 9) / 100.0
FROM skus s
JOIN products pr ON pr.id = s.product_id
LEFT JOIN categories c ON c.id = pr.category_id
WHERE p.sku_id = s.id
  AND COALESCE(p.retail_locked, false)
  AND p.price_basis IN ('per_unit', 'unit')
  AND p.retail_price > 0 AND p.cost > 0
  AND p.retail_price < p.cost + 0.99
  AND ( s.variant_type = 'mosaic'
        OR c.slug IN ('mosaic-tile', 'stacked-stone')
        OR pr.name ~* 'mosaic'
        OR COALESCE(s.variant_name, '') ~* 'mosaic' )
  AND NOT ( (pr.name || ' ' || COALESCE(s.variant_name, '')) ~*
            'bullnose|pencil|liner|listell|cove ?base|quarter ?round|chair ?rail|jolly|v-?cap|moulding|molding|stair|trim|\mrail\M' );
