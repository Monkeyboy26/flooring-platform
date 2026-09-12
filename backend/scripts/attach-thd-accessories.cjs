#!/usr/bin/env node
/**
 * attach-thd-accessories.cjs
 *
 * Links Total Home Distributors (vendor code 406) trim/accessory SKUs to their
 * parent tile SKUs in the `sku_accessories` junction table, and derives an
 * `accessory_label` for each.
 *
 * THD item codes are opaque (THD####-#####) with no embedded color code, so —
 * unlike Daltile — matching is keyed on the `color` attribute within the same
 * collection: an accessory (Jolly, Quarter Round, Moldura, Peldaño stair, …) is
 * linked to every main (non-accessory) SKU that shares its collection AND color.
 * Unmatched accessories (no same-color main SKU, e.g. Kasbah "Taco" inserts, or
 * accessory-only collections like Mexican Pavers / Sanitary Cove Base /
 * Ledgestone) are intentionally left unlinked — they stay browsable as their own
 * products. The storefront PDP additionally color-filters accessories at query
 * time, so linking only same-color parents matches its behavior exactly.
 *
 * Idempotent: clears existing THD links/labels first, then rebuilds.
 *
 * Usage:
 *   docker compose exec -T api node scripts/attach-thd-accessories.cjs --dry-run
 *   docker compose exec -T api node scripts/attach-thd-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_CODE = '406';
const COLOR_ATTR = 'd50e8400-e29b-41d4-a716-446655440001';

// ─── Accessory label derivation (specific → generic) ────────────────────────
// Priority index doubles as the display sort_order so cards group by type.
const TRIM_KEYWORDS = [
  [/quarter\s*round/i, 'Quarter Round'],
  [/demi\s*bullnos[ei]|bullnos[ei]/i, 'Bullnose'],
  [/\bjolly\b/i, 'Jolly Trim'],
  [/moldura|molding/i, 'Molding'],
  [/pencil/i, 'Pencil Trim'],
  [/peldano|peldaño|stair\s*tread|step\s*nos[ei]|\bstair\b(?!\s*coping)/i, 'Stair Tread'],
  [/stair\s*coping|coping/i, 'Stair Coping'],
  [/inside\s*corner/i, 'Inside Corner'],
  [/outside\s*corner/i, 'Outside Corner'],
  [/cove\s*base|covebase/i, 'Cove Base'],
  [/\btaco\b/i, 'Insert'],
  [/liner/i, 'Liner'],
  [/trim/i, 'Trim'],
];

// Returns a specific trim label, or null when the name matches no trim keyword.
// Null is deliberate: several THD "accessory" SKUs are standalone products
// mis-flagged by UOM=EA (Mexican pavers, ledgestone panels) — a generic "Trim"
// label would misdescribe them, and they aren't linked to any parent anyway, so
// the PDP correctly falls back to their real product name.
function deriveLabel(productName, variantName) {
  const text = `${productName || ''} ${variantName || ''}`;
  for (const [re, label] of TRIM_KEYWORDS) {
    if (re.test(text)) return label;
  }
  return null;
}
function labelPriority(label) {
  const i = TRIM_KEYWORDS.findIndex(([, l]) => l === label);
  return i < 0 ? TRIM_KEYWORDS.length : i;
}

const normColor = (s) => (s || '').toString().replace(/[\s\-_]/g, '').toLowerCase();

async function main() {
  console.log(`attach-thd-accessories.cjs — ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('─'.repeat(60));

  const vres = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR_CODE]);
  if (!vres.rows.length) { console.error(`Vendor code "${VENDOR_CODE}" not found.`); process.exit(1); }
  const vendorId = vres.rows[0].id;

  if (!DRY_RUN) {
    const del = await pool.query(`
      DELETE FROM sku_accessories sa USING skus s, products p
      WHERE sa.parent_sku_id = s.id AND s.product_id = p.id AND p.vendor_id = $1
    `, [vendorId]);
    console.log(`Cleared ${del.rowCount} existing THD accessory links`);
    await pool.query(`
      UPDATE skus SET accessory_label = NULL FROM products p
      WHERE skus.product_id = p.id AND p.vendor_id = $1 AND skus.accessory_label IS NOT NULL
    `, [vendorId]);
  }

  // Collections that have BOTH accessory and main (non-accessory) active SKUs.
  const cols = (await pool.query(`
    SELECT p.collection FROM products p
    JOIN skus s ON s.product_id = p.id AND s.status = 'active'
    WHERE p.vendor_id = $1 AND COALESCE(p.collection,'') <> ''
    GROUP BY p.collection
    HAVING count(*) FILTER (WHERE s.variant_type = 'accessory') > 0
       AND count(*) FILTER (WHERE COALESCE(s.variant_type,'') <> 'accessory') > 0
  `, [vendorId])).rows.map(r => r.collection);
  console.log(`Collections with linkable accessories: ${cols.length}`);

  const linkBatch = [];   // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = [];  // [sku_id, label]  (labels for ALL accessories, matched or not)

  // Label every active accessory SKU (even accessory-only collections) so cards
  // and PDPs show a sensible type name.
  const allAcc = (await pool.query(`
    SELECT s.id, s.variant_name, p.name AS pname
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.variant_type = 'accessory' AND s.status = 'active'
  `, [vendorId])).rows;
  for (const a of allAcc) {
    const l = deriveLabel(a.pname, a.variant_name);
    if (l) labelBatch.push([a.id, l]);
  }

  let totalMatched = 0, totalSkipped = 0;
  for (const collection of cols) {
    const main = (await pool.query(`
      SELECT s.id, sa.value AS color
      FROM skus s JOIN products p ON p.id = s.product_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $3
      WHERE p.vendor_id = $1 AND p.collection = $2 AND s.status = 'active'
        AND COALESCE(s.variant_type,'') <> 'accessory'
    `, [vendorId, collection, COLOR_ATTR])).rows;

    const acc = (await pool.query(`
      SELECT s.id, s.variant_name, p.name AS pname, sa.value AS color
      FROM skus s JOIN products p ON p.id = s.product_id
      LEFT JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.attribute_id = $3
      WHERE p.vendor_id = $1 AND p.collection = $2 AND s.status = 'active'
        AND s.variant_type = 'accessory'
    `, [vendorId, collection, COLOR_ATTR])).rows;

    const mainByColor = new Map();
    for (const m of main) {
      const c = normColor(m.color); if (!c) continue;
      if (!mainByColor.has(c)) mainByColor.set(c, []);
      mainByColor.get(c).push(m);
    }

    let matched = 0;
    for (const a of acc) {
      const c = normColor(a.color);
      const mains = c && mainByColor.has(c) ? mainByColor.get(c) : [];
      if (!mains.length) { totalSkipped++; continue; }
      const sort = labelPriority(deriveLabel(a.pname, a.variant_name));
      for (const m of mains) linkBatch.push([m.id, a.id, sort]);
      matched++; totalMatched++;
    }
    console.log(`  ${collection}: ${acc.length} acc → ${matched} matched (${acc.length - matched} skipped)`);
  }

  console.log(`\nAccessories matched: ${totalMatched} | skipped (no same-color parent): ${totalSkipped}`);
  console.log(`Link rows: ${linkBatch.length} | labels: ${labelBatch.length}`);

  if (DRY_RUN) {
    console.log('\nSample links (first 15):');
    linkBatch.slice(0, 15).forEach(([pp, aa, so]) => console.log(`  ${pp} ← ${aa} (sort ${so})`));
    await pool.end(); return;
  }

  // Write labels (dedup by sku).
  const labelMap = new Map(labelBatch);
  const labels = [...labelMap.entries()];
  const B = 500;
  for (let i = 0; i < labels.length; i += B) {
    const batch = labels.slice(i, i + B);
    const cases = batch.map((_, j) => `WHEN id = $${j*2+1} THEN $${j*2+2}`).join(' ');
    const params = batch.flatMap(([id, l]) => [id, l]);
    await pool.query(
      `UPDATE skus SET accessory_label = CASE ${cases} END, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($${params.length+1})`,
      [...params, batch.map(b => b[0])]
    );
  }
  console.log(`Wrote ${labels.length} accessory_label values`);

  // Write links.
  for (let i = 0; i < linkBatch.length; i += B) {
    const batch = linkBatch.slice(i, i + B);
    const vals = batch.map((_, j) => `($${j*3+1}, $${j*3+2}, $${j*3+3})`).join(', ');
    const params = batch.flatMap(x => x);
    await pool.query(
      `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
       VALUES ${vals}
       ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
      params
    );
  }
  console.log(`Wrote ${linkBatch.length} sku_accessories links`);

  const cnt = await pool.query(`
    SELECT count(*) FROM sku_accessories sa
    JOIN skus s ON sa.parent_sku_id = s.id JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1
  `, [vendorId]);
  console.log(`\nTotal THD links: ${cnt.rows[0].count}`);
  console.log('Done!');
  await pool.end();
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
