// Vendors whose prices must not be shown on customer-facing surfaces (vendor
// pricing policy — e.g. Arizona Tile). Their catalog stays fully browsable and
// the storefront/crawler pages render "Call for Price" instead; the underlying
// pricing rows are untouched, so admin, rep, trade quoting, and order tooling
// keep the real numbers (and vendor re-scrapes can't undo this).
export const HIDDEN_PRICE_VENDOR_CODES = new Set(['AZT']);

// Every price-bearing field a storefront/SEO row can carry.
const PRICE_FIELDS = [
  'retail_price', 'sale_price', 'sale_ends_at', 'cost',
  'cut_price', 'roll_price', 'cut_cost', 'roll_cost',
  'trade_price', 'discount_pct',
];

// WHERE fragment for queries where matching by price would reveal the hidden
// number (price_min/price_max filters, price-range facet bounds). Assumes the
// query aliases vendors as `v`.
export const HIDDEN_PRICE_VENDOR_SQL =
  `v.code NOT IN (${[...HIDDEN_PRICE_VENDOR_CODES].map(c => `'${c}'`).join(', ')})`;

// Null out price fields on any row belonging to a hidden-price vendor.
// A row carrying its own vendor_code decides for itself; anonymous nested rows
// (same-product siblings etc.) inherit the nearest identified ancestor's
// verdict. Mutates in place and returns the node — idempotent, so re-running
// on a cached response body is safe.
export function stripHiddenVendorPrices(node, inheritedHidden = false) {
  if (!node || typeof node !== 'object' || node instanceof Date) return node;
  if (Array.isArray(node)) {
    for (const el of node) stripHiddenVendorPrices(el, inheritedHidden);
    return node;
  }
  const hidden = node.vendor_code !== undefined
    ? HIDDEN_PRICE_VENDOR_CODES.has(node.vendor_code)
    : inheritedHidden;
  if (hidden) {
    for (const f of PRICE_FIELDS) if (f in node) node[f] = null;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === 'object') stripHiddenVendorPrices(val, hidden);
  }
  return node;
}
