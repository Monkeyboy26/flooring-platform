-- Charm pricing (owner rule 2026-08-16): every retail price ends in a 9. Round
-- retail_price to the NEAREST value whose last cent is 9 (…X.09/X.19/…/X.99, 10¢
-- apart; exact midpoints X.x4 round DOWN). Retail only — carpet cut/roll prices,
-- sale prices, cost and vendor MAP are left untouched. Going-forward enforcement
-- lives in upsertPricing() (base.js). See [[nine-ending-prices]].
--
-- Skips retail_locked rows (manually set / Home-Depot-matched prices) — forcing a
-- 9-ending would break a deliberate exact-match price; mirrors the retail_locked
-- guard in upsertPricing's UPDATE. Only touches rows with a real retail (>0),
-- never invents a price on a $0/unpriced row.

-- 1) Round every eligible retail_price to the nearest 9-ending value.
--    The 1e-7 nudge before ROUND makes exact .5 midpoints round down.
UPDATE pricing SET
  retail_price = ROUND( GREATEST(9, ROUND( ((ROUND(retail_price*100) - 9) / 10.0) - 0.0000001 ) * 10 + 9) / 100.0, 2)
WHERE retail_price > 0
  AND NOT COALESCE(retail_locked, false);

-- 2) Covering-floor guard: rounding to the NEAREST 9 can drop an area covering
--    (per_sqft/sqft) a few cents under the $0.99-over-cost floor. Bump those to
--    the next 9-ending up (+$0.10 keeps the trailing 9). See [[covering-margin-floor]].
UPDATE pricing SET
  retail_price = ROUND(retail_price + 0.10, 2)
WHERE price_basis IN ('per_sqft', 'sqft')
  AND retail_price > 0 AND cost > 0
  AND retail_price < cost + 0.99
  AND NOT COALESCE(retail_locked, false);

-- 3) Same guard for per-sheet mosaics / stacked stone (per_unit coverings only —
--    accessories/hardware/trim in per_unit are excluded, mirroring base.js).
UPDATE pricing p SET
  retail_price = ROUND(p.retail_price + 0.10, 2)
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
