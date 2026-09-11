/**
 * Attach WPT coordinating accessories to their parent field tiles.
 *
 * A few WPT collections ship the plain field tile plus coordinating decorative
 * pieces modeled as their own products — Bloom "<color> Deco", Drop "<color>
 * Pencil"/"<color> Relief", Retro/Urban "Deco N". These are sold alongside the
 * field tile, so they should appear as accessories on the field-tile PDP
 * (sku_accessories junction: parent field SKU → accessory SKU).
 *
 * Matching (verified by review before --apply):
 *   - Strip the accessory keyword to get the base ("Bloom Azahar Deco" → "Bloom
 *     Azahar"). If a field tile's base matches ("Bloom Azahar Base" → "Bloom
 *     Azahar"), attach to it (color match). Otherwise attach to every field tile
 *     in the same collection (collection-level deco, e.g. Retro/Urban).
 *
 * Standalone mosaics are NOT accessories (no collection shares a mosaic with a
 * field tile) and are excluded. Idempotent (INSERT ON CONFLICT DO NOTHING).
 *   node backend/scripts/attach-wpt-accessories.mjs [--apply]
 */
import pg from 'pg';
const APPLY = process.argv.includes('--apply');
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const ACC_RE = /\s*\b(deco|pencil|relief|liner|trim|bullnose|listello|chair\s*rail)\b.*$/i;
const stripFieldSuffix = (s) => s.replace(/\s*\b(base|field|wall|floor)\b\s*$/i, '').trim();

async function main() {
  const vendor = (await pool.query(
    `SELECT id FROM vendors WHERE LOWER(name) LIKE '%western pacific%' OR code='807' LIMIT 1`)).rows[0];
  if (!vendor) throw new Error('WPT vendor not found');

  // One SKU per WPT product; skip standalone mosaics.
  const { rows } = await pool.query(
    `SELECT p.id AS product_id, p.name, p.collection, s.id AS sku_id, s.variant_type
       FROM products p JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1 AND COALESCE(p.collection,'') <> '' AND s.variant_type <> 'mosaic'
      ORDER BY p.collection, p.name`, [vendor.id]);

  const accessories = rows.filter(r => ACC_RE.test(r.name));
  const fields = rows.filter(r => !ACC_RE.test(r.name));
  const byCollection = new Map();
  for (const f of fields) {
    if (!byCollection.has(f.collection)) byCollection.set(f.collection, []);
    byCollection.get(f.collection).push(f);
  }

  const pairs = []; // {parent, accessory, how}
  const unmatched = [];
  for (const acc of accessories) {
    const base = acc.name.replace(ACC_RE, '').trim().toLowerCase();
    const fieldsInColl = byCollection.get(acc.collection) || [];
    const colorMatch = fieldsInColl.filter(f => stripFieldSuffix(f.name).toLowerCase() === base);
    const targets = colorMatch.length ? colorMatch : fieldsInColl;
    if (!targets.length) { unmatched.push(acc); continue; }
    for (const t of targets) pairs.push({ parent: t, accessory: acc, how: colorMatch.length ? 'color' : 'collection' });
  }

  console.log(`\nWPT accessories: ${accessories.length} accessory products, ${fields.length} field tiles`);
  console.log(`Proposed ${pairs.length} parent→accessory links:\n`);
  let curColl = null;
  for (const { parent, accessory, how } of pairs) {
    if (parent.collection !== curColl) { curColl = parent.collection; console.log(`  [${curColl}]`); }
    console.log(`    ${parent.name}  ←  ${accessory.name}   (${how})`);
  }
  if (unmatched.length) {
    console.log(`\n  ⚠ ${unmatched.length} accessory with no field parent in its collection:`);
    unmatched.forEach(a => console.log(`    ${a.collection} / ${a.name}`));
  }

  if (!APPLY) { console.log('\nDry run — pass --apply to commit.'); await pool.end(); return; }

  let n = 0;
  for (const { parent, accessory } of pairs) {
    const r = await pool.query(
      `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
       VALUES ($1,$2,0) ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING`,
      [parent.sku_id, accessory.sku_id]);
    n += r.rowCount;
  }
  console.log(`\n✓ Inserted ${n} new accessory links (${pairs.length - n} already existed).`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
