-- One-time migration: restructure the "Garrison Collection" vendor into
-- "Old Master Products" with Garrison + Allora as sub-brands, ahead of the
-- Allora catalog import (import-allora.js).
--
-- WHY: Old Master Products manufactures/distributes BOTH Garrison and Allora,
-- so it is the true vendor (the entity Roma orders from). Garrison and Allora
-- are brands on the products (products.brand_id), matching the platform's
-- vendor-sub-brand pattern (EF -> Dream Weaver/Pentz, HR -> Jeffrey Alexander).
--
-- The vendor's public-name hide currently makes Garrison show as code 423. We
-- move that hide onto the GARRISON BRAND so the vendor can go public — letting
-- the ALLORA brand display its real name while Garrison stays hidden (423). The
-- hidden-brand display still sources the code from the vendor's public_code, so
-- Garrison keeps showing 423 unchanged.
--
-- Idempotent: safe to re-run. Vendor code GAR is unchanged, so scrapers/scripts
-- that resolve the vendor by code are unaffected.

BEGIN;

-- 1) Garrison brand (hidden — preserves the current "shows 423" behavior).
INSERT INTO brands (name, code, website, hide_public_name, is_active, description)
VALUES ('Garrison', 'GARRISON', 'https://www.garrisoncollection.com', true, true,
        'Garrison Collection engineered hardwood, manufactured by Old Master Products.')
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name, website=EXCLUDED.website, hide_public_name=EXCLUDED.hide_public_name,
  is_active=EXCLUDED.is_active, description=EXCLUDED.description, updated_at=CURRENT_TIMESTAMP;

-- 2) Allora brand (public — shown to customers per owner decision).
INSERT INTO brands (name, code, website, hide_public_name, is_active, description)
VALUES ('Allora', 'ALLORA', 'https://allorafloors.com', false, true,
        'Allora — Made in Italy European Oak engineered hardwood, distributed by Old Master Products.')
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name, website=EXCLUDED.website, hide_public_name=EXCLUDED.hide_public_name,
  is_active=EXCLUDED.is_active, description=EXCLUDED.description, updated_at=CURRENT_TIMESTAMP;

-- 3) Backfill the existing (Garrison) products under this vendor with the
--    Garrison brand. Runs BEFORE the Allora import, and only touches brand-less
--    rows, so Allora products (imported with brand_id=Allora) are never caught.
UPDATE products p
SET brand_id = (SELECT id FROM brands WHERE code='GARRISON'), updated_at=CURRENT_TIMESTAMP
FROM vendors v
WHERE p.vendor_id = v.id AND v.code='GAR' AND p.brand_id IS NULL;

-- 4) Rename the vendor to Old Master Products and un-hide it (the hide now lives
--    on the Garrison brand). public_code 423 is retained — it's the code shown
--    for the still-hidden Garrison brand.
UPDATE vendors SET
  name = 'Old Master Products',
  hide_public_name = false,
  website = 'https://www.oldmasterproducts.com',
  notes = 'Old Master Products (Anaheim, CA) — manufacturer/distributor of the Garrison Collection and Allora (Made in Italy) engineered hardwood lines. Modeled as one vendor with Garrison + Allora sub-brands (products.brand_id). Dealer price = Roma COST; retail = cost x1.6 keystone (9-ending + covering floor). Garrison brand is public-name-hidden (shows code 423); Allora is shown by name.',
  updated_at = CURRENT_TIMESTAMP
WHERE code='GAR';

COMMIT;

-- Sanity output
\echo '--- brands ---'
SELECT name, code, hide_public_name FROM brands WHERE code IN ('GARRISON','ALLORA');
\echo '--- vendor ---'
SELECT name, code, public_code, hide_public_name FROM vendors WHERE code='GAR';
\echo '--- garrison products backfilled ---'
SELECT COUNT(*) AS garrison_products FROM products p JOIN brands b ON b.id=p.brand_id WHERE b.code='GARRISON';
