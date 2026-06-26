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
    ]
  },

  bosphorus: {
    label: 'Bosphorus',
    description: 'Scrape Bosphorus catalog, import pricing, group colors into attributes',
    steps: [
      { type: 'scraper', sourceKey: 'bosphorus', label: 'Bosphorus Catalog Scrape' },
      { type: 'scraper', sourceKey: 'bosphorus-pricelist', label: 'Bosphorus Price List' },
      { type: 'script',  path: 'scripts/group-bosphorus-colors.cjs', label: 'Group Bosphorus Colors' },
    ]
  },

  daltile: {
    label: 'Daltile',
    description: 'Build Coveo product map, run unified import (Coveo + EDI 832), attach accessories',
    steps: [
      { type: 'script',  path: 'scripts/build-daltile-product-map.cjs', label: 'Build Daltile Product Map (Coveo)' },
      { type: 'scraper', sourceKey: 'daltile-unified', label: 'Daltile Unified Import (Coveo + EDI)' },
      { type: 'script',  path: 'scripts/attach-daltile-accessories.cjs', label: 'Attach Daltile Accessories' },
    ]
  },

  msi: {
    label: 'MSI',
    description: 'Scrape MSI product pages, import pricing, group products, link accessories',
    steps: [
      { type: 'scraper', sourceKey: 'msi', label: 'MSI Product Scrape' },
      { type: 'scraper', sourceKey: 'msi-inventory', label: 'MSI Inventory Update' },
      { type: 'script',  path: 'scripts/group-msi-products.cjs', label: 'Group MSI Products' },
      { type: 'script',  path: 'scripts/msi-link-accessories.cjs', label: 'Link MSI Accessories' },
    ]
  },

  engfloors: {
    label: 'Engineered Floors',
    schedule: '0 2 * * *',
    description: 'Import EDI 832 catalog (products, pricing, packaging), poll web services for dealer cost and inventory, then enrich missing images from website',
    steps: [
      { type: 'scraper', sourceKey: 'engfloors-832',          label: 'EF EDI 832 Catalog Import' },
      { type: 'scraper', sourceKey: 'engfloors-webservices',   label: 'EF Web Services (Cost + Inventory)' },
      { type: 'script',  path: 'scrapers/ef-website.js',      label: 'EF Website Enrichment (Images + Specs)' },
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
