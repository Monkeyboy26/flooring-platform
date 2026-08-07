// Vendor pipeline definitions
// Each pipeline is an ordered list of steps that execute sequentially.
// Steps can be:
//   - { type: 'scraper', sourceKey: '...', label: '...' }  — runs via existing runScraper()
//   - { type: 'script',  path: '...', label: '...', args?: [] } — spawned as child process

const PIPELINES = {
  metroflor: {
    label: 'Metroflor',
    description: 'Import Tri-West 832 feed, enrich from Metroflor website, group products, attach accessories',
    steps: [
      { type: 'scraper', sourceKey: 'triwest-catalog', label: 'Tri-West DNav Catalog' },
      { type: 'scraper', sourceKey: 'triwest-metroflor', label: 'Metroflor Website Enrichment' },
      { type: 'script',  path: 'scripts/group-metroflor-products.cjs', label: 'Group Metroflor Products' },
      { type: 'script',  path: 'scripts/attach-metroflor-accessories.cjs', label: 'Attach Metroflor Accessories' },
      // Catch-all safety net: link (and surface) any same-product sibling
      // accessories the bespoke attach steps above didn't cover — e.g. Tri-West
      // sub-brands with no dedicated script (Foster, RCGlobal). Insert-only +
      // idempotent; never deletes. --activate turns on priced accessories that
      // color-match an active plank in their product.
      { type: 'script',  path: 'scripts/link-sibling-accessories.cjs', args: ['--vendor', 'Tri-West', '--activate'], label: 'Link Sibling Accessories (catch-all)' },
    ]
  },

  hartco: {
    label: 'Hartco',
    description: 'Import Tri-West 832 feed, enrich from Hartco website, reorganize products, attach accessories, backfill images',
    steps: [
      { type: 'scraper', sourceKey: 'triwest-catalog', label: 'Tri-West DNav Catalog' },
      { type: 'scraper', sourceKey: 'triwest-hartco', label: 'Hartco Website Enrichment' },
      { type: 'script',  path: 'scripts/reorganize-hartco.cjs', label: 'Reorganize Hartco Products' },
      { type: 'script',  path: 'scripts/attach-hartco-accessories.cjs', label: 'Attach Hartco Accessories' },
      { type: 'script',  path: 'scripts/backfill-hartco-images.cjs', label: 'Backfill Hartco Images' },
      // Catch-all safety net (see metroflor pipeline) — links/surfaces any
      // same-product sibling accessories left over from Tri-West sub-brands
      // without a bespoke attach script. Insert-only, idempotent.
      { type: 'script',  path: 'scripts/link-sibling-accessories.cjs', args: ['--vendor', 'Tri-West', '--activate'], label: 'Link Sibling Accessories (catch-all)' },
    ]
  },

  // Bosphorus is a small catalog (~270 products), so a single daily run of the
  // authenticated catalog scraper is cheap (~4 min) and refreshes pricing +
  // inventory as a byproduct of the crawl (variant_groups JS). No price list.
  bosphorus: {
    label: 'Bosphorus',
    schedule: '0 17 * * *',
    description: 'Daily: crawl the Bosphorus catalog (products, images, specs) with dealer pricing + inventory, then group colors into attributes',
    steps: [
      { type: 'scraper', sourceKey: 'bosphorus', label: 'Bosphorus Catalog + Price + Inventory' },
      { type: 'script',  path: 'scripts/group-bosphorus-colors.cjs', label: 'Group Bosphorus Colors' },
    ]
  },

  daltile: {
    label: 'Daltile',
    description: 'Build Coveo product map, run unified import (Coveo + EDI 832), attach accessories, reconcile images',
    steps: [
      { type: 'script',  path: 'scripts/build-daltile-product-map.cjs', label: 'Build Daltile Product Map (Coveo)' },
      { type: 'scraper', sourceKey: 'daltile-unified', label: 'Daltile Unified Import (Coveo + EDI)' },
      { type: 'script',  path: 'scripts/attach-daltile-accessories.cjs', label: 'Attach Daltile Accessories' },
      { type: 'script',  path: 'scripts/daltile-reconcile-images.cjs', label: 'Reconcile SKU Images vs Map' },
      // Must run AFTER the reconcile: solid-color field tiles prefer a clean
      // swatch over a wrong-size/bevel render, which the reconcile would upgrade.
      { type: 'script',  path: 'scripts/daltile-fix-colorwheel-images.cjs', label: 'Fix Color Wheel Solid-Color Images' },
      // Repair any primary image that doesn't resolve on Scene7 (the map lists
      // unpublished URLs the importer writes blind). Liveness-validated.
      { type: 'script',  path: 'scripts/daltile-fix-broken-images.cjs', label: 'Repair Dead Primary Images (catalog-wide)' },
    ]
  },

  msi: {
    label: 'MSI',
    schedule: '0 1 * * 0',
    description: 'Weekly: scrape MSI product pages, import pricing, group products, link accessories (inventory also refreshes daily via the standalone msi-inventory source)',
    steps: [
      { type: 'scraper', sourceKey: 'msi', label: 'MSI Product Scrape' },
      { type: 'scraper', sourceKey: 'msi-inventory', label: 'MSI Inventory Update' },
      { type: 'script',  path: 'scripts/group-msi-products.cjs', label: 'Group MSI Products' },
      { type: 'script',  path: 'scripts/msi-link-accessories.cjs', label: 'Link MSI Accessories' },
      // Runs after names are finalized: link each look's field tile / versailles /
      // ledger panel / mosaic products so the storefront shows them as format pills.
      { type: 'script',  path: 'scripts/group-msi-formats.cjs', label: 'Group MSI Formats' },
    ]
  },

  engfloors: {
    label: 'Engineered Floors',
    schedule: '0 2 * * *',
    notify: true,
    description: 'Import EDI 832 catalog (products, pricing, packaging), poll web services for dealer cost and inventory, gap-fill images from a multi-source fallback chain, then auto-activate/retire products per lifecycle rules',
    steps: [
      { type: 'scraper', sourceKey: 'engfloors-832',          label: 'EF EDI 832 Catalog Import' },
      { type: 'scraper', sourceKey: 'engfloors-webservices',   label: 'EF Web Services (Cost + Inventory)' },
      { type: 'script',  path: 'pipelines/ef-images.js',      label: 'EF Images (Cloudinary → API → Website)' },
      { type: 'script',  path: 'pipelines/ef-lifecycle.js',    label: 'EF Lifecycle (activate / retire)' },
    ]
  },

  shaw: {
    label: 'Shaw Floors',
    schedule: '0 3 * * *',
    description: 'Import EDI 832 catalog (products, pricing, packaging), then enrich with Shaw Data API (images, specs, descriptions)',
    steps: [
      { type: 'scraper', sourceKey: 'shaw-832',       label: 'Shaw EDI 832 Catalog Import' },
      { type: 'scraper', sourceKey: 'shaw-data-api',  label: 'Shaw Data API Enrichment' },
    ]
  },

  emser: {
    label: 'Emser Tile',
    schedule: '0 5 * * *',
    description: 'Import EDI 832 pricing/packaging, then enrich with catalog images, descriptions, and spec PDFs',
    steps: [
      { type: 'scraper', sourceKey: 'emser-832',     label: 'Emser EDI 832 Import' },
      { type: 'scraper', sourceKey: 'emser-catalog',  label: 'Emser Catalog Enrichment' },
    ]
  },
};

function getAvailablePipelines() {
  return Object.entries(PIPELINES).map(([code, config]) => ({
    vendorCode: code,
    label: config.label,
    description: config.description,
    schedule: config.schedule || null,
    stepCount: config.steps.length,
    steps: config.steps.map((s, i) => ({ index: i, type: s.type, label: s.label })),
  }));
}

function getPipelineConfig(vendorCode) {
  return PIPELINES[vendorCode] || null;
}

export { PIPELINES, getAvailablePipelines, getPipelineConfig };
