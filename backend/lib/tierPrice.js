// Trade/member tier pricing — cost-multiplier model (owner, 2026-09-22).
//
// Trade prices are derived from COST (retail = 1.70x cost; Silver 1.50x / Gold 1.40x
// / Platinum 1.32x), not as a stored "% off retail". This keeps every tier anchored
// to the one number the store controls, so a markup change never needs the tier
// percentages re-derived, and the category margin floors protect every tier.
//
// margin_tiers.cost_multiplier is the source of truth; discount_percent is kept only
// as a display/fallback value for rows that have no cost. See [[cost-multiplier-tiers]].

export const RETAIL_MIN_MARGIN = 0.99;
export const TILE_MIN_MARGIN = 1.50;
export const MOSAIC_MIN_MARGIN = 4.50;
export const HD_LOCKED_DISCOUNT_CAP = 10;

const TILE_SLUGS = new Set(['tile', 'backsplash-tile', 'ceramic-tile', 'commercial-tile',
  'fluted-tile', 'large-format-tile', 'pool-tile', 'porcelain-tile', 'talavera-tile',
  'terrazzo-tile', 'wood-look-tile']);

// Category-scoped minimum gross margin — matches backend/scrapers/base.js.
export function categoryMinMargin(categorySlug, priceBasis) {
  if (categorySlug === 'mosaic-tile' && priceBasis === 'per_unit') return MOSAIC_MIN_MARGIN;
  if (categorySlug === 'mosaic-tile') return TILE_MIN_MARGIN;
  if (TILE_SLUGS.has(categorySlug)) return TILE_MIN_MARGIN;
  return RETAIL_MIN_MARGIN;
}

const round2 = (v) => Math.round(Number(v) * 100) / 100;

// Per-basis trade price from cost via the tier's cost multiplier. cost/retail must be
// in the SAME stored basis (per_sqft/per_unit/per_sqyd); the caller converts to a
// per-piece/per-box unit afterwards exactly as it does for retail.
//   trade = min( retail, max( cost × multiplier, cost + categoryMinMargin ) )
// so it never sells above the shelf price and never below the category margin floor.
// Falls back to the legacy "% off retail" (locked prices capped at 10%) when there is
// no usable cost or multiplier — e.g. zero-cost rows. Returns a Number (2dp) or null.
export function tradeTierPrice({ cost, retail, priceBasis, categorySlug, costMultiplier,
  fallbackDiscountPct = 0, retailLocked = false }) {
  const retailN = Number(retail) || 0;
  const costN = Number(cost) || 0;
  const mult = Number(costMultiplier) || 0;

  if (!(costN > 0) || !(mult > 0)) {
    if (!(retailN > 0)) return null;
    let d = Number(fallbackDiscountPct) || 0;
    if (retailLocked) d = Math.min(d, HD_LOCKED_DISCOUNT_CAP);
    return round2(retailN * (1 - d / 100));
  }

  const minMargin = categoryMinMargin(categorySlug, priceBasis);
  const price = round2(Math.max(costN * mult, costN + minMargin));
  return retailN > 0 ? Math.min(price, retailN) : price;
}
