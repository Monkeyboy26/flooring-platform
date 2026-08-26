#!/usr/bin/env node
/**
 * emser-tile-collection-caps.cjs
 *
 * Brings Emser tile products in line with how every other tile vendor is
 * structured, in two ways:
 *
 *   1. CAPITALIZATION — restores all-caps for roman-numeral version markers
 *      ("Swiss ii" → "Swiss II", the convention Shaw/EF/Daltile all use) and
 *      material acronyms (SPC/LVP/LVT), and fixes "Bb" → "BB". Applied to both
 *      product name and collection.
 *
 *   2. COLLECTION — other vendors fill products.collection with the series;
 *      Emser's 832 feed blanks it (the feed "collection" is just "EMSER TILE
 *      LLC"). Fill it: anchor to an existing known Emser collection when the
 *      name starts with one, else derive the series from the name (leading words
 *      up to the first finish/shape/size token). Non-tile strays are skipped.
 *
 * Both the caps fix and the series derivation mirror emser-832.js (keep in sync).
 * Respects the products (vendor_id, collection, name) unique index. Dry-run by default.
 *
 * Usage:
 *   node backend/scripts/emser-tile-collection-caps.cjs            # dry run
 *   node backend/scripts/emser-tile-collection-caps.cjs --apply
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');

const TILE_CATS = [
  'porcelain-tile', 'ceramic-tile', 'mosaic-tile', 'natural-stone', 'tile',
  'stacked-stone', 'porcelain-slabs', 'wood-look-tile', 'large-format-tile',
];

// --- caps fix (mirror of emser-832.js fixEmserCaps) ---
function fixEmserCaps(name) {
  if (!name) return name;
  return name
    .replace(/(^|\s)(i{1,3}|iv|vi{0,3}|ix)(?=\s|$)/gi, (m, pre, r) => pre + r.toUpperCase())
    .replace(/(^|\s)(spc|lvp|lvt)(?=\s|$)/gi, (m, pre, a) => pre + a.toUpperCase())
    .replace(/\/([a-z])/g, (m, ch) => '/' + ch.toUpperCase())
    .replace(/\bBb\b/g, 'BB');
}

// --- series derivation (mirror of emser-832.js deriveEmserSeries) ---
const SERIES_STOP = /^(matte|satin|polished|gloss|glossy|honed|flamed|tumbled|lappato|rectified|semigloss|mirror|unpolished|leathered|brushed|mosaic|hex|hexagon|chevron|herringbone|arabesque|penny|lantern|picket|pinwheel|basketweave|offset|linear|brick|subway|pebble|cigaro|convex|beveled|bevel|wave|slim|deco|decor|insert|dot|leaf|star|geometric|circle|form|pattern|single|corner|blend|grip|trapezoid|diamond|glass|metal|engineered|new|original|pure|frame)$/i;
function deriveSeries(name) {
  const out = [];
  for (const t of String(name || '').split(/\s+/)) {
    if (SERIES_STOP.test(t)) break;
    if (/^\d/.test(t) || /\d(?:mm|cm)$/i.test(t) || /^\d+x\d+/i.test(t) || /^\d+in$/i.test(t)) break;
    if (t.includes('/')) break;
    out.push(t);
  }
  const s = out.join(' ');
  return s && !SERIES_STOP.test(s) ? s : '';
}

// Non-tile finishing pieces — never given a tile collection.
const STRAY = /\b(threshold|shelf|crn|bullnose|sbn|cove|edge\s*protector|quarter\s*circle|reducer|pencil|liner|v-?cap|sill)\b/i;

async function main() {
  console.log(`\n=== Emser Tile — Collection + Capitalization ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code='EMS'")).rows[0].id;

  // Known (already-populated) Emser collections, longest-first for prefix anchoring.
  const known = (await pool.query(
    "SELECT DISTINCT collection FROM products WHERE vendor_id=$1 AND collection IS NOT NULL AND collection<>''",
    [vendorId]
  )).rows.map(r => r.collection).sort((a, b) => b.length - a.length);
  const anchor = (name) => {
    const lc = name.toLowerCase();
    return known.find(k => { const kl = k.toLowerCase(); return lc === kl || lc.startsWith(kl + ' '); }) || null;
  };

  const rows = (await pool.query(
    `SELECT p.id, p.name, COALESCE(p.collection,'') AS collection, c.slug AS cat
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.status = 'active' AND c.slug = ANY($2)`,
    [vendorId, TILE_CATS]
  )).rows;

  // Compute each row's target (collection, name).
  const plan = rows.map(r => {
    const name = fixEmserCaps(r.name);
    let collection = r.collection ? fixEmserCaps(r.collection) : '';
    if (!collection && !STRAY.test(name)) {
      const a = anchor(name);
      collection = a ? fixEmserCaps(a) : deriveSeries(name);
    }
    return { id: r.id, oldName: r.name, oldColl: r.collection, name, collection, cat: r.cat };
  });

  // Cluster every active Emser product by its FUTURE (collection, name): tile rows
  // use the planned pair, others keep current. Filling collection can reveal that a
  // blank EDI row and a catalog-matched twin are the same product (same series+name)
  // — a cluster >1 is that duplicate, to fold together rather than skip.
  const allActive = (await pool.query(
    `SELECT p.id, COALESCE(p.collection,'') AS collection, p.name, (c.slug = ANY($2)) AS is_tile,
            (SELECT count(*) FROM skus s WHERE s.product_id = p.id) AS sku_ct,
            (SELECT count(*) FROM media_assets m WHERE m.product_id = p.id) AS img_ct
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.status = 'active'`,
    [vendorId, TILE_CATS]
  )).rows.map(r => ({ ...r, sku_ct: +r.sku_ct, img_ct: +r.img_ct }));
  const planById = new Map(plan.map(p => [p.id, p]));
  const targetOf = f => { const pl = f.is_tile ? planById.get(f.id) : null;
    return pl ? { collection: pl.collection, name: pl.name } : { collection: f.collection, name: f.name }; };

  const clusters = new Map();
  for (const f of allActive) {
    const t = targetOf(f); const k = `${t.collection}|||${t.name}`;
    if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(f);
  }

  const key = s => (s || '').trim().toUpperCase();
  const variantKeys = async id => new Set((await pool.query(
    'SELECT DISTINCT variant_name FROM skus WHERE product_id=$1 AND variant_name IS NOT NULL', [id]
  )).rows.map(r => key(r.variant_name)));
  const hasRefs = async id => {
    const r = (await pool.query(
      `SELECT (SELECT count(*) FROM order_items oi JOIN skus s ON s.id=oi.sku_id WHERE s.product_id=$1) o,
              (SELECT count(*) FROM cart_items ci JOIN skus s ON s.id=ci.sku_id WHERE s.product_id=$1) c`, [id]
    )).rows[0];
    return (+r.o + +r.c) > 0;
  };

  const updates = [];      // survivor rows to UPDATE name/collection
  const deactivate = [];   // duplicate rows to retire
  const repoints = [];     // {survivorId, loserName, moves:[{id,variant}]}
  let refGuard = 0;

  for (const members of clusters.values()) {
    if (members.length === 1) {
      const p = planById.get(members[0].id);
      if (p && (p.name !== p.oldName || p.collection !== p.oldColl)) updates.push(p);
      continue;
    }
    // Duplicate cluster: keeper = collection-filled first, then most images, then SKUs.
    const keeper = members.slice().sort((a, b) =>
      (b.collection ? 1 : 0) - (a.collection ? 1 : 0) || b.img_ct - a.img_ct || b.sku_ct - a.sku_ct)[0];
    let blocked = false;
    const survKeys = await variantKeys(keeper.id);
    for (const m of members) {
      if (m.id === keeper.id) continue;
      if (await hasRefs(m.id)) { refGuard++; blocked = true; continue; }
      const skus = (await pool.query('SELECT id, variant_name FROM skus WHERE product_id=$1', [m.id])).rows;
      const moves = [];
      for (const s of skus) { const vk = key(s.variant_name); if (vk && !survKeys.has(vk)) { survKeys.add(vk); moves.push({ id: s.id, variant: s.variant_name }); } }
      if (moves.length) repoints.push({ survivorId: keeper.id, loserName: m.name, moves });
      deactivate.push({ id: m.id, name: m.name, coll: m.collection });
    }
    // Apply the keeper's planned caps/collection only once its cluster is clear.
    if (!blocked) { const p = planById.get(keeper.id); if (p && (p.name !== p.oldName || p.collection !== p.oldColl)) updates.push(p); }
  }

  const caps = updates.filter(p => p.name !== p.oldName).length;
  const collSet = updates.filter(p => p.collection !== p.oldColl).length;
  const fromBlank = updates.filter(p => p.collection !== p.oldColl && !p.oldColl).length;
  console.log(`── CAPITALIZATION: ${caps} names ──`);
  updates.filter(p => p.name !== p.oldName).slice(0, 20).forEach(p => console.log(`   "${p.oldName}"  →  "${p.name}"`));
  console.log(`\n── COLLECTION: ${collSet} set (${fromBlank} filled from blank) ──`);
  updates.filter(p => p.collection !== p.oldColl && !p.oldColl).slice(0, 20).forEach(p => console.log(`   [${p.cat}] "${p.name}"  →  "${p.collection}"`));
  console.log(`\n── DEDUPE (folded blank/catalog twins): ${deactivate.length} rows retired, ${repoints.reduce((n, r) => n + r.moves.length, 0)} unique-color SKUs merged ──`);
  deactivate.slice(0, 15).forEach(d => console.log(`   retire "${d.name}" (coll "${d.coll}")`));
  const stillBlank = plan.filter(p => !p.collection && !STRAY.test(p.name)).length;
  console.log(`\n(collection still blank: ${stillBlank} non-stray; ${refGuard} dup rows kept active due to order/cart refs)`);

  if (!APPLY) {
    console.log(`\n(DRY RUN — no changes written. Re-run with --apply.)\n`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of repoints) for (const m of r.moves) {
      await client.query('UPDATE skus SET product_id=$1 WHERE id=$2', [r.survivorId, m.id]);
      await client.query('UPDATE media_assets SET product_id=$1 WHERE sku_id=$2', [r.survivorId, m.id]);
    }
    for (const d of deactivate) await client.query("UPDATE products SET status='inactive' WHERE id=$1", [d.id]);
    for (const p of updates) await client.query('UPDATE products SET name=$1, collection=$2 WHERE id=$3',
      [p.name, p.collection || null, p.id]);
    await client.query('COMMIT');
    console.log(`\nApplied: ${caps} caps + ${collSet} collections + ${deactivate.length} dupes retired.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
