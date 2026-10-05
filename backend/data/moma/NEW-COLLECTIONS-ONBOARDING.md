# Moma — New March-2026 Collections Onboarding (QUEUED)

Nine collections in the MARCH 2026 (v45) price list are **not yet in the PIM** (Moma =
vendor code **896**). Data is captured in `new-collections-march2026.json` (net costs,
sizes, finishes, colors, packaging, attributes — extracted from `pricelist-2026-03.txt`).
This doc is the execution plan. **Not yet built/run.**

## Collections (products × colors ≈ SKUs)

| Code | Name | Category | Look | Products | Colors | In stock? |
|------|------|----------|------|----------|--------|-----------|
| OT | Oakthree | wood-look-tile | Wood | 3 field sizes | 3 | **Yes (not Q2-flagged)** |
| ML | Moonlight | porcelain-tile (+ pavers) | Marble | 3 field + 2 paver | 5 (pavers 2) | Q2 |
| CL | Clay | porcelain-tile / backsplash-wall | Concrete | 2 field + 1 wall deco | 5 + 3 deco | Q2 |
| CF | Cliff | backsplash-wall | Stone | 3 wall (incl. Ripple) | 4 | Q2 |
| ON | Onici | porcelain-tile / backsplash-wall | Marble | 1 wall + 1 field | 4 | Q2 |
| BL | Blossom | backsplash-wall | Pattern | 1 wall (×2 color sets) | 8 | Q2 |
| BI | Boiserie | backsplash-wall | Concrete | 1 wall + 1 trim | 4 | Q2 |
| MED | Mediterranean | porcelain-tile | Pattern | 3 field | 3 | Q2 |
| LE | Le Gioie | backsplash-wall | Pattern | 2 wall 8x8 (deco) | 16 | Q2 |

All category slugs above are confirmed to exist in `categories`.

## Approach (mirror the existing Moma model, but NOT import-moma.js)

Build `onboard-moma-new-collections.mjs` (additive, idempotent, dry-run/APPLY) that, for
each collection in the JSON:
1. Upserts products under vendor **896** / the Moma brand, grouping SKUs into products by
   (size + finish) exactly like the current catalog (storefront renders Color/Size/Finish
   pills). Role → category (field→category, wall→wall_category, paver→pavers).
2. Creates one SKU per color (`internal_sku = MOMA-<code>-<sizecompact>[-<finishsuffix>]`),
   `sell_by` box (tile) / unit (trim accessories).
3. **Pricing via `base.js upsertPricing`** (cost = net price, retail_price = cost×2 to trip
   the house keystone → 1.70× + tile floor + 9-ending). NOT the 1.6 keystone in import-moma.js.
4. Writes packaging (`pkg` array) + attributes (material Porcelain, look, collection, color,
   color_code, finish, size nominal, application, rectified, + the collection's spec attrs).
5. Attaches images (see Open Items). Pavers get `thickness = 20 mm`.
6. Status: **Oakthree → active**; the other 8 (Q2) → **draft** (or active + a "coming soon"
   flag) until stock + images land.

Idempotent via ON CONFLICT (internal_sku / vendor_collection_name). Run in the api
container (`docker exec -e APPLY=1 flooring-api node /app/data/moma/onboard-moma-new-collections.mjs`),
then deploy per the recipe in `[[moma-price-list-update]]` (commit → prod auto-pulls → run on prod DB; backups go to a DB table, bind mount is read-only to the container user).

## Open items (BLOCKERS before import)

1. **Images** — none on hand for any of the 9. Source per-color face shots + collection
   lifestyle from momaceramichegroup.com/losangeles (the original import used per-collection
   "Product Images" + "Room Settings HD" zips, color-named). Without images these onboard
   imageless → keep them `draft` until images are attached.
2. **Data gaps to confirm with the rep (Ulises):**
   - Mediterranean 13.4×13.4 row lists color **BDP3**, absent from the color list (VR03/CP03/CTAT).
   - Le Gioie **LBS/box unknown** in the sheet (shown `???`); Baguette has 4 colors (no Ossidiana Nera); Inserto are A+B pairs — confirm how to sell.
3. **Trims** — Boiserie has a real listello **Trim 1/5"×39" @ $13.20/ea** (per_unit). The generic
   "local courtesy" SBN/mosaic trims apply to all field collections as before (optional).
4. **Decide activation policy** — draft vs active-with-"coming soon" for the 8 Q2 series.

## Suggested sequencing

1. **Oakthree first** (likely in stock, simple 3×3 wood-look) — proves the onboarder end-to-end with a shippable collection.
2. Then the straightforward porcelain/stone (Moonlight, Clay, Onici, Mediterranean).
3. Wall-tile pattern sets last (Blossom, Boiserie, Cliff, Le Gioie) — more deco/variant modeling.
