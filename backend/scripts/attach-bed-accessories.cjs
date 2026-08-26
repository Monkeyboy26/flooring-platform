#!/usr/bin/env node
/**
 * attach-bed-accessories.cjs
 *
 * Links Bedrosians trim / molding SKUs to their parent tile / floor SKUs in the
 * `sku_accessories` junction table. BED accessories are SEPARATE products (not
 * variant_type='accessory' siblings), so the generic build-sku-accessories.cjs
 * skips them — they are matched here by collection + color.
 *
 * Strategy:
 *   1. Accessories = products in trim-accessories / transitions-moldings categories.
 *   2. Mains = non-accessory tile/floor/slab/stone products in the SAME collection
 *      (collection normalized: strip trailing "Mosaics"/"Mosaic"/"Slabs").
 *   3. Match each accessory to mains whose NAME contains the accessory's color
 *      (the parent `color` attribute is unreliable here — wall tiles store "Wall").
 *   4. Fallback: a color-less accessory (e.g. a T-Molding / collection-wide trim)
 *      links to ALL mains in the collection.
 *   5. Insert into sku_accessories (skip existing) + set accessory_label.
 *
 * Usage:
 *   node backend/scripts/attach-bed-accessories.cjs --dry-run
 *   node backend/scripts/attach-bed-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || process.env.PGHOST || 'localhost',
  port: process.env.DB_PORT || process.env.PGPORT || 5432,
  database: process.env.DB_NAME || process.env.PGDATABASE || 'flooring_pim',
  user: process.env.DB_USER || process.env.PGUSER || 'postgres',
  password: process.env.DB_PASS || process.env.PGPASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const ACCESSORY_CATS = ['trim-accessories', 'transitions-moldings'];

// Derive a short display label from the accessory name.
const LABEL_RULES = [
  [/t[-\s]?mold/i, 'T-Mold'],
  [/reducer/i, 'Reducer'],
  [/stair\s*nos[ei]|nosing/i, 'Stairnose'],
  [/threshold/i, 'Threshold'],
  [/quarter\s*round/i, 'Quarter Round'],
  [/bullnos[ei]/i, 'Bullnose'],
  [/v[-\s]?cap/i, 'V-Cap'],
  [/cove\s*base/i, 'Cove Base'],
  [/chair\s*rail/i, 'Chair Rail'],
  [/jolly/i, 'Jolly Trim'],
  [/pencil/i, 'Pencil Liner'],
  [/\bliner\b/i, 'Liner'],
  [/listello/i, 'Listello'],
  [/\bmolding\b/i, 'Molding'],
];
function deriveLabel(name) {
  const n = name || '';
  for (const [re, label] of LABEL_RULES) if (re.test(n)) return label;
  return 'Trim';
}

// Normalize a collection so accessory + main lines align.
function normColl(c) {
  return (c || '').toLowerCase().replace(/\s*(mosaics?|slabs?)\s*$/i, '').trim();
}

const esc = s => (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Accessory color, or null if the piece is color-less (a collection-wide trim/molding).
// Derived from the NAME first — the color attribute is unreliable here (it often holds the
// finish, e.g. "Gloss", or garbage). Take the token after " in ", else the name minus collection,
// size, finish and type words. The attribute is only a last-resort fallback.
const FINISH = /\b(gloss(?:y)?|matte|honed|polished|satin|glazed|natural|brushed|tumbled|chiseled)\b/ig;
const TYPEWORDS = /\b(ceramic|porcelain|marble|glass|stone|tile|trim|bullnose|jolly|liner|pencil|molding|chair ?rail|v-?cap|cove ?base|listello|edge|deco|pattern|wall|floor|cane|round|corner)\b/ig;
function accColor(row) {
  const inMatch = (row.name || '').match(/\bin\s+([A-Za-z][A-Za-z0-9 &/'-]+?)\s*$/);
  let c = '';
  if (inMatch) c = inMatch[1];
  else c = (row.name || '')
    .replace(new RegExp('^' + esc(row.collection), 'i'), '')
    .replace(/\d[\d.]*\s*["”]?\s*[xX]\s*[\d.]+\s*["”]?/g, '')
    .replace(FINISH, '')
    .replace(TYPEWORDS, '');
  if (!c || c.replace(/[^a-z]/ig, '').length < 3) {
    const a = (row.color || '').replace(FINISH, '').trim();
    if (!/^(wall|floor|decorative|n\/?a)?$/i.test(a)) c = a;
  }
  c = c.replace(FINISH, '').replace(/[-–].*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return c.replace(/[^a-z]/ig, '').length >= 3 ? c : null;
}

async function main() {
  const v = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%bedrosian%' LIMIT 1");
  if (!v.rows.length) { console.error('Bedrosians vendor not found'); process.exit(1); }
  const vendorId = v.rows[0].id;

  // Load accessory SKUs (with color attr)
  const accRes = await pool.query(`
    SELECT s.id, s.vendor_sku, p.name, p.collection,
      (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id
        WHERE sa.sku_id=s.id AND a.slug='color' LIMIT 1) AS color
    FROM skus s JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id
    WHERE p.vendor_id=$1 AND c.slug = ANY($2) AND s.status IN ('active','draft') AND s.is_sample=false
      AND p.collection <> ''
  `, [vendorId, ACCESSORY_CATS]);

  // Load main SKUs (non-accessory categories)
  const mainRes = await pool.query(`
    SELECT s.id, s.vendor_sku, p.name, p.collection
    FROM skus s JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id
    WHERE p.vendor_id=$1 AND NOT (c.slug = ANY($2)) AND s.status IN ('active','draft') AND s.is_sample=false
      AND p.collection <> ''
  `, [vendorId, ACCESSORY_CATS]);

  // Index mains by normalized collection
  const mainsByColl = new Map();
  for (const m of mainRes.rows) {
    const k = normColl(m.collection);
    if (!mainsByColl.has(k)) mainsByColl.set(k, []);
    mainsByColl.get(k).push(m);
  }

  const linkBatch = []; // [parent_sku_id, accessory_sku_id, sort_order]
  const labelBatch = []; // [sku_id, label]
  let colorMatched = 0, fallback = 0, noColl = 0, skippedColor = 0;

  for (const acc of accRes.rows) {
    labelBatch.push([acc.id, deriveLabel(acc.name)]);
    const mains = mainsByColl.get(normColl(acc.collection));
    if (!mains || !mains.length) { noColl++; continue; }

    const color = accColor(acc);
    let matched;
    if (color) {
      // Color-specific trim: link only to same-color parents. If none match, skip rather than
      // pollute every color in the collection with the wrong-color trim.
      const re = new RegExp('(^|[^a-z])' + esc(color) + '([^a-z]|$)', 'i');
      matched = mains.filter(m => re.test(m.name));
      if (matched.length) colorMatched++; else { skippedColor++; continue; }
    } else {
      matched = mains; // color-less, collection-wide accessory (e.g. T-Molding)
      fallback++;
    }

    let sort = 0;
    for (const m of matched) {
      if (m.id !== acc.id) linkBatch.push([m.id, acc.id, sort++]);
    }
  }

  console.log(`Accessories: ${accRes.rows.length} | color-matched: ${colorMatched}, collection-wide: ${fallback}, no-collection: ${noColl}, color-no-parent(skipped): ${skippedColor}`);
  console.log(`Links to write: ${linkBatch.length}`);

  if (DRY_RUN) {
    console.log('\nSample (first 25):');
    const byAcc = new Map();
    for (const [pid, aid] of linkBatch) byAcc.set(aid, (byAcc.get(aid) || 0) + 1);
    let shown = 0;
    for (const acc of accRes.rows) {
      if (shown >= 25) break;
      const n = byAcc.get(acc.id) || 0;
      console.log(`  ${acc.name}  [color="${accColor(acc)}"]  → ${n} mains`);
      shown++;
    }
    await pool.end();
    return;
  }

  // Write links
  const BATCH = 500;
  for (let i = 0; i < linkBatch.length; i += BATCH) {
    const batch = linkBatch.slice(i, i + BATCH);
    const values = [], params = [];
    batch.forEach((b, j) => { const o = j * 3; values.push(`($${o+1},$${o+2},$${o+3})`); params.push(b[0], b[1], b[2]); });
    await pool.query(`INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
      VALUES ${values.join(',')} ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING`, params);
  }
  // Write labels
  for (let i = 0; i < labelBatch.length; i += BATCH) {
    const batch = labelBatch.slice(i, i + BATCH);
    const caseLines = batch.map((b, j) => `WHEN id=$${j*2+1} THEN $${j*2+2}`).join(' ');
    const params = [];
    batch.forEach(b => params.push(b[0], b[1]));
    const ids = batch.map(b => b[0]);
    await pool.query(`UPDATE skus SET accessory_label=CASE ${caseLines} END WHERE id=ANY($${params.length+1})`, [...params, ids]);
  }

  const cnt = await pool.query(`SELECT count(*) FROM sku_accessories sa
    JOIN skus s ON s.id=sa.accessory_sku_id
    JOIN products p ON p.id=s.product_id WHERE p.vendor_id=$1`, [vendorId]);
  console.log(`\nDone. BED accessory links now: ${cnt.rows[0].count}`);
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
