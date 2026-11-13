# MSI Jan-2026 pricelist onboarding (2026-11-12)

One-time onboarding of the 495 items present in the MSI Jan-2026 dealer
pricelist (`backend/data/msi-pricelist-jan26.xlsb`) but absent from our active
catalog. Data-only (no `server.js` changes). Ran on **prod**; local was not
onboarded (Docker was down).

Result: reactivated 336 SKUs / 47 products, created 90 products / 124 SKUs with
235 scraped images. Active MSI SKUs 3,169 → 3,664.

## Pipeline (order of operations)

Analysis / manifest build (run locally against the xlsb + prod CSV exports):

1. `extract-msi-pricelist-items.cjs` → `msi-pricelist-items.json` — unique active ITEM NUMBERs.
2. `extract-missing-full.cjs` → `msi-pricelist-full.json` — full rows (all columns + Web Link).
3. `diff-msi.cjs` — diff vs active MSI SKUs (vendor_sku ↔ ITEM NUMBER); scopes the drop/keep analysis.
4. `candidates-msi.cjs` / `classify-missing.cjs` → `msi-reactivate.json` + `msi-create.json`
   — split "missing" items into reactivate (exists-but-inactive) vs create (absent).
5. `probe-links.cjs` → `link-probe-results.json` — verify each product URL is live (310/311).
6. `fetch-create-images.cjs` → `create-images.json` — scrape primary/alt image URLs per create page.

Apply (run **inside the flooring-api container** so base.js + pg resolve):

7. `onboard.mjs` — reactivate + create (products/SKUs/pricing/packaging/attributes). `--dry` to preview.
8. `fixup-images.mjs` — attach images + write backup (see landmine #1; run with `-u 0`).
9. `fix-retail.mjs` — backfill retail on the created SKUs (see landmine #2).

## Landmines (all hit during this run)

1. **File writes need root.** `docker exec` runs as `appuser` (uid 1001) which has
   NO write access to the bind-mounted `/app/uploads` and `/app/data`. Every image
   download and the backup write failed with `EACCES`. Any script that writes files
   must use `docker exec -u 0 …`. DB-only scripts are fine as appuser.
2. **`upsertPricing` never invents retail from cost.** Passing cost-only lands
   `retail_price = 0`. Always pass `retail_price` (we used `cost × 1.70`; the helper's
   charm/margin-floor rules then adjust). This is why `fix-retail.mjs` exists.
3. **`cdn.msisurfaces.com` is case-sensitive.** Product-page HTML sometimes references
   Capitalized image filenames that only exist lowercase (Capitalized → 404). The
   downloader retries with a lowercased filename.

## Notes

- Match key: pricelist ITEM NUMBER ↔ `skus.vendor_sku` (UPPER).
- Category mapping: sinks → kitchen/bathroom-sinks, faucets → kitchen/bathroom-faucets,
  thresholds/sills/shelves/seats → trim-accessories. All `sell_by=unit`, `per_unit`.
  Threshold sizes are grouped (by URL first-segment) as variants of one product.
- 28 "REFER TO WWW.EVERLIFELVT.COM" placeholder rows dropped (not real SKUs).
- 6 created products are imageless (no Web Link / no source image exists):
  3 porcelain sinks, sink strainer, 2 stone sills/shelves.
- Backup of prior state: `onboard-backup-reconstructed.json` (written on prod).
- See the `msi-catalog-management` memory for full context.
