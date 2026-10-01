// backfill-orion-sku-attributes.mjs  (idempotent)
//
// Many Orion SKUs carry colour/size/finish only in variant_name ("Black 24x24",
// "River Veil 12x24", "Polished 24x48") but NOT in sku_attributes — so storefront
// colour/size filters and the collection swatch picker don't work for them. This
// backfills the missing color/size/finish attributes by parsing variant_name:
//   trailing token  -> size   (24x48, 9.32x48, 12.5x24.5)
//   explicit finish -> finish (Polished/Satin/Matte/…)
//   leading text    -> color  (the variant label that drives the swatch picker;
//                              includes pattern labels like "Wave"/"River Veil")
// Only fills attributes a SKU is MISSING — never clobbers an existing value, so a
// re-scrape (which passes null colour for these and thus won't overwrite) is safe.
//
// Run local:  DB_PASSWORD=postgres node backend/data/backfill-orion-sku-attributes.mjs
// Run prod:   docker exec flooring-api node backend/data/backfill-orion-sku-attributes.mjs
// Re-runnable; prints a summary and does not modify already-attributed SKUs.

import pg from 'pg';
import { upsertSkuAttribute } from '../scrapers/base.js';

const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const FINISH = new Set(['matte', 'matt', 'polished', 'pul', 'glossy', 'honed',
  'satin', 'textured', 'lappato']);
const FINISH_CANON = { matt: 'Matte', pul: 'Polished' };

// Parse a variant_name into { size, finish, color } (any may be null).
function parseVariant(vn) {
  const out = { size: null, finish: null, color: null };
  if (!vn) return out;
  const m = vn.match(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)/);
  if (m) out.size = `${m[1]}x${m[2]}`;
  let rest = (m ? vn.replace(m[0], '') : vn)
    .replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  if (!rest) return out;
  const toks = rest.split(' ');
  const keep = [];
  for (const t of toks) {
    const low = t.toLowerCase();
    if (FINISH.has(low) && !out.finish) out.finish = FINISH_CANON[low] || t;
    else keep.push(t);
  }
  const color = keep.join(' ').trim();
  // Guard against slug/junk leaking in as a colour (active rows are clean Title
  // Case, but be defensive): letters/spaces/.'/- only, reasonable length.
  if (color && color.length <= 40 && /^[A-Za-z][A-Za-z .'/-]*$/.test(color)) {
    out.color = color;
  }
  return out;
}

const orion = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%orion%' ORDER BY id LIMIT 1");
if (!orion.rows.length) { console.error('No Orion vendor'); process.exit(1); }
const vendorId = orion.rows[0].id;

const rows = (await pool.query(`
  SELECT s.id, s.variant_name,
    EXISTS(SELECT 1 FROM sku_attributes sa JOIN attributes a ON sa.attribute_id=a.id AND a.slug='color'  WHERE sa.sku_id=s.id) AS has_color,
    EXISTS(SELECT 1 FROM sku_attributes sa JOIN attributes a ON sa.attribute_id=a.id AND a.slug='size'   WHERE sa.sku_id=s.id) AS has_size,
    EXISTS(SELECT 1 FROM sku_attributes sa JOIN attributes a ON sa.attribute_id=a.id AND a.slug='finish' WHERE sa.sku_id=s.id) AS has_finish
  FROM skus s JOIN products p ON s.product_id=p.id
  WHERE p.vendor_id=$1 AND s.status='active' AND s.variant_name IS NOT NULL AND s.variant_name<>''
`, [vendorId])).rows;

let setColor = 0, setSize = 0, setFinish = 0, skipped = 0;
for (const r of rows) {
  const p = parseVariant(r.variant_name);
  let touched = false;
  if (p.color && !r.has_color)   { await upsertSkuAttribute(pool, r.id, 'color', p.color);   setColor++;  touched = true; }
  if (p.size && !r.has_size)     { await upsertSkuAttribute(pool, r.id, 'size', p.size);     setSize++;   touched = true; }
  if (p.finish && !r.has_finish) { await upsertSkuAttribute(pool, r.id, 'finish', p.finish); setFinish++; touched = true; }
  if (!touched) skipped++;
}

console.log(`Orion SKU attribute backfill: scanned ${rows.length} active SKUs`);
console.log(`  color set:  ${setColor}`);
console.log(`  size set:   ${setSize}`);
console.log(`  finish set: ${setFinish}`);
console.log(`  unchanged:  ${skipped}`);
await pool.end();
