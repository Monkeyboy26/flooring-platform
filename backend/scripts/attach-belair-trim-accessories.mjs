// Bel Air (BAW): give the trim accessory SKUs their profile images and attach
// them to every Bel Air plank PDP via sku_accessories.
//
// Images come from Discount Hardwood Floors & Moldings (discounthwf.com) — Bel
// Air's sister company at the same 5505 S Alameda St address — which publishes
// the trim profile drawings the Bel Air price list uses. Hotlinked, then
// self-hosted by the mirror pass.
//
// Attachment: engineered-hardwood planks get the engineered trim set
// (BAW-TRM-*, special order); laminate + lvp-plank planks get the
// laminate/vinyl set (BAW-LTR-*). The PDP per-SKU accessory query color-gates
// accessories, but these trims carry no color attribute so they show on every
// color (matched to order color at quote time by the rep).
//
// Idempotent: media replaced per trim SKU; sku_accessories upserts on PK.
//
//   node scripts/attach-belair-trim-accessories.mjs [--dry-run] [--no-mirror]

import { pool } from '../db.js';
import { mirrorMediaRow } from '../lib/imageMirror.js';

const DRY_RUN = process.argv.includes('--dry-run');
const NO_MIRROR = process.argv.includes('--no-mirror');

const DHWF = 'https://discounthwf.com/wp-content/uploads/2017/11';

// internal_sku → profile drawing
const TRIM_IMAGES = {
  // engineered set
  'BAW-TRM-QTR-ROUND': `${DHWF}/quarter-round.png`,
  'BAW-TRM-END-CAP': `${DHWF}/end-cap.png`,
  'BAW-TRM-REDUCER': `${DHWF}/reducer.png`,
  'BAW-TRM-TMOLD': `${DHWF}/t-molding.png`,
  'BAW-TRM-FLUSH-SN': `${DHWF}/flush-stairnose.png`,
  // laminate/vinyl set
  'BAW-LTR-QTR-ROUND': `${DHWF}/quarter-round.png`,
  'BAW-LTR-END-CAP': `${DHWF}/end-cap.png`,
  'BAW-LTR-REDUCER': `${DHWF}/reducer.png`,
  'BAW-LTR-TMOLD': `${DHWF}/t-molding.png`,
  'BAW-LTR-STAIR-NOSE': `${DHWF}/stairnose-3.png`,   // overlap stair nose
  'BAW-LTR-SQFLUSH-SN': `${DHWF}/stairnose-1.png`,   // square flush stair nose
};

// Attachment order on the PDP (sort_order)
const TRIM_ORDER = ['QTR-ROUND', 'END-CAP', 'REDUCER', 'TMOLD', 'STAIR-NOSE', 'SQFLUSH-SN', 'FLUSH-SN'];
const orderOf = (internalSku) => {
  const code = internalSku.replace(/^BAW-(TRM|LTR)-/, '');
  const i = TRIM_ORDER.indexOf(code);
  return i === -1 ? 99 : i;
};

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');

  const v = await pool.query("SELECT id FROM vendors WHERE code = 'BAW'");
  if (!v.rows.length) throw new Error('BAW vendor not found');
  const vendorId = v.rows[0].id;

  // Trim SKUs (with their product ids for the media rows)
  const trims = await pool.query(`
    SELECT s.id, s.internal_sku, s.product_id
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.internal_sku LIKE 'BAW-%'
      AND (s.internal_sku LIKE 'BAW-TRM-%' OR s.internal_sku LIKE 'BAW-LTR-%')`, [vendorId]);
  const bySku = new Map(trims.rows.map(r => [r.internal_sku, r]));
  for (const key of Object.keys(TRIM_IMAGES)) {
    if (!bySku.has(key)) throw new Error(`trim sku missing: ${key} — run the import scripts first`);
  }

  // ---- media on the trim SKUs ----
  const mediaRowsToMirror = [];
  for (const [internalSku, url] of Object.entries(TRIM_IMAGES)) {
    const t = bySku.get(internalSku);
    if (DRY_RUN) { console.log(`  media ${internalSku} ← ${url.split('/').pop()}`); continue; }
    await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [t.id]);
    const m = await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1,$2,'primary',$3,$3,0) RETURNING id, url, original_url`,
      [t.product_id, t.id, url]);
    mediaRowsToMirror.push(m.rows[0]);
    console.log(`  ✓ media ${internalSku} ← ${url.split('/').pop()}`);
  }

  // ---- attach to planks ----
  // Engineered planks (incl. unfinished) → TRM set; laminate/SPC/WPC → LTR set.
  const planks = await pool.query(`
    SELECT s.id, s.internal_sku, c.slug AS cat
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE p.vendor_id = $1 AND s.variant_type IS DISTINCT FROM 'accessory'
      AND s.status = 'active'`, [vendorId]);

  const trmSet = trims.rows.filter(r => r.internal_sku.startsWith('BAW-TRM-'));
  const ltrSet = trims.rows.filter(r => r.internal_sku.startsWith('BAW-LTR-'));

  let nLinks = 0;
  for (const plank of planks.rows) {
    const set = plank.cat === 'engineered-hardwood' ? trmSet : ltrSet;
    for (const trim of set) {
      if (DRY_RUN) { nLinks++; continue; }
      await pool.query(`
        INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
        VALUES ($1,$2,$3)
        ON CONFLICT (parent_sku_id, accessory_sku_id) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
        [plank.id, trim.id, orderOf(trim.internal_sku)]);
      nLinks++;
    }
  }
  console.log(`\n${DRY_RUN ? 'Would link' : 'Linked'} ${nLinks} plank→trim rows across ${planks.rows.length} plank SKUs`);

  if (!DRY_RUN && !NO_MIRROR && mediaRowsToMirror.length) {
    console.log(`\nMirroring ${mediaRowsToMirror.length} trim images…`);
    let ok = 0, skip = 0;
    for (const row of mediaRowsToMirror) {
      try { (await mirrorMediaRow(pool, row)) ? ok++ : skip++; }
      catch { skip++; }
    }
    console.log(`  mirrored ${ok}, kept vendor url ${skip}`);
  }

  console.log('\n=== Bel Air trim accessories attached ===');
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
