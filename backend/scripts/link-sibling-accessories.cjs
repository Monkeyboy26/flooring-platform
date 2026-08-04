#!/usr/bin/env node
/**
 * link-sibling-accessories.cjs
 *
 * SAFE, insert-only accessory linker. Links each accessory SKU to the flooring
 * (main) SKU(s) *in the same product* whose color matches, via sku_accessories.
 *
 * This is a catch-all safety net for the "sibling" accessory pattern — where a
 * product contains both flooring SKUs (variant_type IS NULL) and accessory SKUs
 * (variant_type='accessory') — e.g. Hallmark, and Tri-West sub-brands that have
 * no bespoke attach-*-accessories.cjs script (Foster, RCGlobal, …).
 *
 * Safety guarantees (contrast with build-sku-accessories.cjs, which does a
 * global DELETE + rebuild and only reproduces same-product links — running that
 * live would destroy ~91k cross-product links from the curated per-vendor
 * scripts):
 *   - NEVER deletes. Insert-only, ON CONFLICT DO NOTHING → idempotent.
 *   - NEVER reclassifies SKUs (won't set variant_type / sell_by).
 *   - Only links to ACTIVE planks, so nothing points at a draft/discontinued
 *     product. Accessories are linked only when active — UNLESS --activate is
 *     passed, in which case an inactive accessory that (a) color-matches an
 *     active plank in its product and (b) has a real price is activated and
 *     linked (this is how an accessory set that imported inactive gets
 *     surfaced; the storefront only serves status='active' accessories).
 *   - Matches strictly within the same product, so there is no cross-product
 *     mismatch risk.
 *
 * Designed to run as the final step of a vendor pipeline (after any bespoke
 * attach script). Additive: it only fills gaps the bespoke scripts left.
 *
 * Usage:
 *   node backend/scripts/link-sibling-accessories.cjs --dry-run
 *   node backend/scripts/link-sibling-accessories.cjs --vendor "Tri-West"
 *   node backend/scripts/link-sibling-accessories.cjs --vendor "Big D Supply" --activate
 *   node backend/scripts/link-sibling-accessories.cjs           # all vendors, link-only
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const ACTIVATE = process.argv.includes('--activate');
const vIdx = process.argv.indexOf('--vendor');
const VENDOR = vIdx >= 0 ? process.argv[vIdx + 1] : null;

// Accessory type keywords → canonical label (most specific first). Used both to
// strip the type out of an accessory name (to isolate its color) and to assign
// a stable sort_order. Mirrors build-sku-accessories.cjs's taxonomy.
const TYPE_KEYWORDS = [
  [/flush\s*stair\s*nos[ei]/i, 'Flush Stair Nose'],
  [/overlap(?:ping)?\s*stair\s*nos[ei]/i, 'Overlap Stair Nose'],
  [/overlap\s*nosing/i, 'Overlap Stair Nose'],
  [/stair\s*nos[ei]/i, 'Stair Nose'],
  [/step\s*nos[ei]/i, 'Stair Nose'],
  [/nosing/i, 'Stair Nose'],
  [/stair\s*tread/i, 'Stair Tread'],
  [/reducer/i, 'Reducer'],
  [/multi[-\s]?purpose/i, 'Multi-Purpose'],
  [/t[-\s]?mold(?:ing)?/i, 'T-Mold'],
  [/threshold/i, 'Threshold'],
  [/end\s*cap/i, 'End Cap'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/square\s*nose/i, 'Square Nose'],
  [/wall\s*base/i, 'Wall Base'],
  [/baby\s*threshold/i, 'Threshold'],
];

// Canonical display/sort order for accessory types.
const SORT_ORDER = [
  'Reducer', 'Stair Nose', 'Overlap Stair Nose', 'Flush Stair Nose', 'Square Nose',
  'Stair Tread', 'T-Mold', 'Threshold', 'Quarter Round', 'Multi-Purpose', 'End Cap', 'Wall Base',
];
function sortOrderFor(label) {
  const i = SORT_ORDER.indexOf(label);
  return i >= 0 ? i + 1 : 99;
}

/** Normalize a color name for comparison: lowercase, strip non-alphanumerics,
 *  drop common species words, collapse whitespace. */
function normColor(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(white\s*oak|red\s*oak|hickory|maple|walnut|birch|ash|cherry|acacia|teak|bamboo|oak)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Derive the accessory type label + isolate its color from the variant_name /
 *  accessory_label. Handles both "Balboa Reducer" (Hallmark) and "Balboa" +
 *  accessory_label="Reducer" (Tri-West). */
function labelAndColor(acc) {
  const vn = acc.variant_name || '';
  // Type label: prefer an explicit accessory_label, else infer from the name.
  let label = null;
  const labelSrc = acc.accessory_label || vn;
  for (const [re, lbl] of TYPE_KEYWORDS) {
    if (re.test(labelSrc)) { label = lbl; break; }
  }
  // Color: strip any type keywords out of the variant_name, then normalize.
  let color = vn;
  for (const [re] of TYPE_KEYWORDS) color = color.replace(re, ' ');
  color = normColor(color);
  return { label: label || 'Accessory', color };
}

async function main() {
  console.log(`link-sibling-accessories — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${VENDOR ? ` — vendor="${VENDOR}"` : ' — all vendors'}${ACTIVATE ? ' — --activate' : ''}`);
  const client = await pool.connect();
  try {
    // Load SKUs for products that contain BOTH an active flooring SKU and an
    // accessory SKU (the sibling pattern), optionally scoped to one vendor.
    // Planks are restricted to active below; accessories are loaded regardless
    // of status (an inactive one may be activatable via --activate). has_price
    // gates activation so we never surface a $0/priceless accessory.
    const { rows } = await client.query(`
      SELECT s.id, s.product_id, s.variant_name, s.variant_type, s.accessory_label,
             s.status, v.name AS vendor_name,
             EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id AND pr.retail_price > 0) AS has_price
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE s.is_sample = false AND p.status = 'active'
        AND (s.status = 'active' OR s.variant_type = 'accessory')
        AND ($1::text IS NULL OR v.name = $1)
        AND s.product_id IN (
          SELECT product_id FROM skus
          GROUP BY product_id
          HAVING bool_or(variant_type = 'accessory')
             AND bool_or(status = 'active' AND COALESCE(variant_type, '') <> 'accessory')
        )
      ORDER BY s.product_id
    `, [VENDOR]);

    // Group by product.
    const byProduct = new Map();
    for (const s of rows) {
      if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, []);
      byProduct.get(s.product_id).push(s);
    }

    // Build match records by same-product color match. Only active planks are
    // eligible parents. An accessory is eligible if it's active, or (inactive
    // and --activate and priced).
    const pairs = [];          // [parentId, accId, sortOrder]
    const toActivate = new Set(); // accessory sku ids to flip active
    let productsTouched = 0;
    const vendorsSeen = new Set();
    for (const [, skus] of byProduct) {
      const planks = skus.filter(s => (s.variant_type || '') !== 'accessory' && s.status === 'active');
      const accs = skus.filter(s => (s.variant_type || '') === 'accessory');
      if (!planks.length || !accs.length) continue;

      // color → active plank sku ids (a color can have >1 plank, e.g. size variants)
      const plankByColor = new Map();
      for (const p of planks) {
        const c = normColor(p.variant_name);
        if (!c) continue;
        if (!plankByColor.has(c)) plankByColor.set(c, []);
        plankByColor.get(c).push(p.id);
      }

      let matchedHere = false;
      for (const acc of accs) {
        const { label, color } = labelAndColor(acc);
        const parents = color ? plankByColor.get(color) : null;
        if (!parents) continue;
        const isActive = acc.status === 'active';
        const canActivate = ACTIVATE && acc.has_price;
        if (!isActive && !canActivate) continue; // inactive + can't activate → skip
        if (!isActive) toActivate.add(acc.id);
        for (const parentId of parents) {
          pairs.push([parentId, acc.id, sortOrderFor(label)]);
          matchedHere = true;
        }
      }
      if (matchedHere) { productsTouched++; vendorsSeen.add(skus[0].vendor_name); }
    }

    // Activate matched inactive accessories first (so the storefront serves them).
    let activated = 0;
    if (toActivate.size) {
      if (!DRY_RUN) {
        const r = await client.query(
          `UPDATE skus SET status = 'active' WHERE id = ANY($1) AND status <> 'active'`,
          [[...toActivate]]
        );
        activated = r.rowCount;
      } else {
        activated = toActivate.size;
      }
    }

    // Insert links (idempotent). Count only rows that did not already exist.
    let inserted = 0;
    if (!DRY_RUN) {
      for (const [parent, acc, so] of pairs) {
        const r = await client.query(
          `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [parent, acc, so]
        );
        inserted += r.rowCount;
      }
    } else {
      for (const [parent, acc] of pairs) {
        const r = await client.query(
          `SELECT 1 FROM sku_accessories WHERE parent_sku_id=$1 AND accessory_sku_id=$2`,
          [parent, acc]
        );
        if (r.rowCount === 0) inserted++;
      }
    }

    console.log(`\n--- Summary ${DRY_RUN ? '(DRY RUN)' : ''} ---`);
    console.log(`Candidate plank↔accessory pairs : ${pairs.length}`);
    console.log(`New links ${DRY_RUN ? 'that would be' : ''} created : ${inserted}`);
    console.log(`Accessories ${DRY_RUN ? 'that would be' : ''} activated : ${activated}${ACTIVATE ? '' : ' (pass --activate to enable)'}`);
    console.log(`Products with matched siblings   : ${productsTouched}`);
    console.log(`Vendors touched                  : ${[...vendorsSeen].sort().join(', ') || '(none)'}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
