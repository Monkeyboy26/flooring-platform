#!/usr/bin/env node
/**
 * Emser — Fix borrowed/wrong-color images (2026-08-30)
 *
 * Root causes (emser-catalog.js):
 *   1. matchImagesByName/matchImagesBySeries fallbacks attached OTHER products'
 *      images as product-level primaries (564 assets; 398 active products showed
 *      a different product's photo — e.g. Catalyst Pl Sa showing Catalyst Ox Hy
 *      Hydrogen; Artwork flat showing the Minihexagon image).
 *   2. Emser's own API sometimes serves a different color's per-SKU asset
 *      (filename embeds the source SKU code — the code doesn't lie).
 *
 * Detection: every Emser CDN filename embeds the source vendor_sku
 * (e.g. catch_taupe_f14catcFA0410m = Fawn scan). Resolve that code against our
 * own EMS skus (prefix-stripped stem match) and compare owner product/color.
 *
 * Actions:
 *   A. Product-level primary/alternate borrowed from ANOTHER product:
 *      keep only finish-twins (names equal after stripping finish words AND the
 *      borrowed color exists in the target product); delete the rest.
 *   B. SKU-level primaries whose embedded code resolves to a DIFFERENT color:
 *      repoint to a self-coded asset if one exists anywhere in our media,
 *      else copy a same-color sibling primary, else delete.
 *   C. SKU-level non-primaries embedding a different color's code: move to the
 *      owning SKU if it lacks that URL (shaw-ef treatment), else delete.
 *
 * Skips (false positives): near-identical color spellings (Havana/Havanna),
 * filenames that also contain the SKU's own code (dual-named files).
 *
 * Usage:
 *   node backend/scripts/fix-emser-borrowed-images.mjs --dry-run
 *   node backend/scripts/fix-emser-borrowed-images.mjs
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const CODE_RE = /(?:^|_)([a-z]\d{2}[a-z]{4,}[0-9][a-z0-9]*)(?:_|-|\.)/;

const fname = url => (url.split('/').pop() || '').toLowerCase();
const embeddedCode = url => {
  const m = fname(url).match(CODE_RE);
  return m ? m[1].replace(/v[23]$/, '') : null;
};
const stemOf = code => code ? code.slice(3) : null; // drop 3-char prefix (F84 vs F22 drift)

// ALL embedded codes in a filename (dual-coded files like tatsu_blanco_..._gris_...)
const CODE_RE_G = /(?:^|_)([a-z]\d{2}[a-z]{4,}[0-9][a-z0-9]*)(?=_|-|\.)/g;
const allStems = url => [...fname(url).matchAll(CODE_RE_G)].map(m => stemOf(m[1].replace(/v[23]$/, '')));
// Bounded check — 'artwwh1235hx' must NOT count as containing stem 'artwwh1235'
const containsOwnCode = (url, selfStem) => allStems(url).includes(selfStem);

// Names equal after stripping finish/size qualifiers → finish-twin products
const stripName = n => (n || '').toLowerCase()
  .replace(/\b(matte|polished|polish|satin|honed|glossy|gloss|textured|lappato|brushed|rectified)\b/g, '')
  .replace(/\b\d+([./]\d+)?\s*(mm|cm|mil)\b/g, '')
  .replace(/\b\d+x\d+\b/g, '')
  .replace(/\b(catx|dcs)\b/g, '')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ').trim();

const editDist = (a, b) => {
  if (a === b) return 0;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const sameColorish = (a, b) => {
  a = (a || '').toLowerCase(); b = (b || '').toLowerCase();
  if (!a || !b) return false;
  return a === b || editDist(a, b) <= 2;
};

async function main() {
  console.log(`=== Emser borrowed-image fix ===${DRY_RUN ? ' [DRY RUN]' : ''}\n`);
  const { rows: [vendor] } = await pool.query("SELECT id FROM vendors WHERE code = 'EMS'");
  if (!vendor) throw new Error('EMS vendor not found');

  // All EMS skus: stem → {sku_id, product_id, color, pname, vsku}
  const { rows: skuRows } = await pool.query(`
    SELECT s.id sku_id, s.product_id, lower(s.vendor_sku) vsku, p.name pname, sa.value color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
      AND sa.attribute_id = (SELECT id FROM attributes WHERE slug = 'color')
    WHERE p.vendor_id = $1
  `, [vendor.id]);

  const byStem = new Map();
  const colorsByProduct = new Map(); // product_id → Set(lower colors)
  const skuById = new Map();
  for (const r of skuRows) {
    const stem = r.vsku.replace(/v[23]$/, '').slice(3);
    if (!byStem.has(stem)) byStem.set(stem, r);
    if (!colorsByProduct.has(r.product_id)) colorsByProduct.set(r.product_id, new Set());
    if (r.color) colorsByProduct.get(r.product_id).add(r.color.toLowerCase());
    skuById.set(r.sku_id, r);
  }

  // All EMS cloudfront media
  const { rows: media } = await pool.query(`
    SELECT ma.id, ma.product_id, ma.sku_id, ma.asset_type, ma.url, p.name pname
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.url LIKE '%cloudfront%'
      AND ma.asset_type IN ('primary', 'alternate', 'lifestyle')
  `, [vendor.id]);

  // Index: does any media row embed a given stem? (for Phase B recovery)
  const mediaByEmbeddedStem = new Map();
  for (const m of media) {
    const stem = stemOf(embeddedCode(m.url));
    if (!stem) continue;
    if (!mediaByEmbeddedStem.has(stem)) mediaByEmbeddedStem.set(stem, []);
    mediaByEmbeddedStem.get(stem).push(m);
  }
  const urlSetBySku = new Map();
  for (const m of media.filter(m => m.sku_id)) {
    if (!urlSetBySku.has(m.sku_id)) urlSetBySku.set(m.sku_id, new Set());
    urlSetBySku.get(m.sku_id).add(m.url);
  }

  const stats = { A_kept_twin: 0, A_deleted: 0, B_repointed: 0, B_sibling: 0, B_deleted: 0, B_skipped_fp: 0, C_moved: 0, C_deleted: 0 };
  const deletes = [], updates = [], moves = [];

  // ── Phase A: product-level borrows ──
  for (const m of media.filter(m => !m.sku_id && m.asset_type !== 'lifestyle')) {
    const stem = stemOf(embeddedCode(m.url));
    if (!stem) continue;
    const owner = byStem.get(stem);
    if (!owner || owner.product_id === m.product_id) continue;

    const twin = stripName(m.pname) === stripName(owner.pname);
    const colorOk = owner.color && (colorsByProduct.get(m.product_id) || new Set()).has(owner.color.toLowerCase());
    if (twin && colorOk) { stats.A_kept_twin++; continue; }

    deletes.push(m.id);
    stats.A_deleted++;
    if (stats.A_deleted <= 15) console.log(`A DELETE [${m.asset_type}] "${m.pname}" ← ${fname(m.url)} (belongs to "${owner.pname}")`);
  }

  // ── Phase B: sku-level wrong-color primaries ──
  for (const m of media.filter(m => m.sku_id && m.asset_type === 'primary')) {
    const self = skuById.get(m.sku_id);
    if (!self) continue;
    const selfStem = self.vsku.replace(/v[23]$/, '').slice(3);
    const code = embeddedCode(m.url);
    const stem = stemOf(code);
    if (!stem || stem === selfStem) continue;
    const owner = byStem.get(stem);
    if (!owner) continue;
    if (sameColorish(owner.color, self.color)) continue;            // same/near color share — fine
    if (containsOwnCode(m.url, selfStem)) { stats.B_skipped_fp++; continue; } // dual-coded file

    // Recovery 1: any media row embedding our own stem
    const selfCoded = (mediaByEmbeddedStem.get(selfStem) || []).find(x => x.id !== m.id);
    if (selfCoded) {
      updates.push({ id: m.id, url: selfCoded.url });
      stats.B_repointed++;
      console.log(`B REPOINT "${self.pname}" ${self.vsku} [${self.color}] → ${fname(selfCoded.url)}`);
      continue;
    }
    // Recovery 2: same-product same-color sibling primary with a self-coded image
    const sib = skuRows.find(r => r.product_id === self.product_id && r.sku_id !== self.sku_id
      && sameColorish(r.color, self.color));
    const sibPrimary = sib && media.find(x => x.sku_id === sib.sku_id && x.asset_type === 'primary'
      && stemOf(embeddedCode(x.url)) && byStem.get(stemOf(embeddedCode(x.url)))
      && sameColorish(byStem.get(stemOf(embeddedCode(x.url))).color, self.color));
    if (sibPrimary) {
      updates.push({ id: m.id, url: sibPrimary.url });
      stats.B_sibling++;
      console.log(`B SIBLING "${self.pname}" ${self.vsku} [${self.color}] → ${fname(sibPrimary.url)}`);
      continue;
    }
    deletes.push(m.id);
    stats.B_deleted++;
    console.log(`B DELETE  "${self.pname}" ${self.vsku} [${self.color}] ← ${fname(m.url)} (image is "${owner.color}")`);
  }

  // ── Phase B2: sku-level primaries showing a DIFFERENT PRODUCT's image (even
  // same-color, e.g. flat tile showing the hexagon sibling) when the SKU's own
  // self-coded image exists — repoint to it. Prefer product shots over room scenes.
  const shotRank = u => /roomscene|room scene|_rs\d|vignette|expanse/i.test(u) ? 1 : 0;
  const updatedIds = new Set(updates.map(u => u.id));
  for (const m of media.filter(m => m.sku_id && m.asset_type === 'primary')) {
    if (updatedIds.has(m.id) || deletes.includes(m.id)) continue;
    const self = skuById.get(m.sku_id);
    if (!self) continue;
    const selfStem = self.vsku.replace(/v[23]$/, '').slice(3);
    const stem = stemOf(embeddedCode(m.url));
    if (!stem || stem === selfStem || containsOwnCode(m.url, selfStem)) continue;
    const owner = byStem.get(stem);
    if (!owner || owner.product_id === self.product_id) continue; // size-sibling share within product is Emser-normal

    const selfCoded = (mediaByEmbeddedStem.get(selfStem) || [])
      .filter(x => x.id !== m.id)
      .sort((a, b) => shotRank(a.url) - shotRank(b.url))[0];
    if (!selfCoded || selfCoded.url === m.url) continue;
    updates.push({ id: m.id, url: selfCoded.url });
    stats.B2_repointed = (stats.B2_repointed || 0) + 1;
    if (stats.B2_repointed <= 15) console.log(`B2 REPOINT "${self.pname}" ${self.vsku} (was "${owner.pname}" image) → ${fname(selfCoded.url)}`);
  }

  // ── Phase C: sku-level non-primaries embedding a different color ──
  for (const m of media.filter(m => m.sku_id && m.asset_type !== 'primary')) {
    const self = skuById.get(m.sku_id);
    if (!self) continue;
    const selfStem = self.vsku.replace(/v[23]$/, '').slice(3);
    const stem = stemOf(embeddedCode(m.url));
    if (!stem || stem === selfStem) continue;
    const owner = byStem.get(stem);
    if (!owner) continue;
    if (sameColorish(owner.color, self.color)) continue;
    if (containsOwnCode(m.url, selfStem)) continue;

    const ownerHas = (urlSetBySku.get(owner.sku_id) || new Set()).has(m.url);
    if (!ownerHas) {
      moves.push({ id: m.id, sku_id: owner.sku_id, product_id: owner.product_id });
      stats.C_moved++;
    } else {
      deletes.push(m.id);
      stats.C_deleted++;
    }
  }

  console.log(`\nPlan: ${deletes.length} deletes, ${updates.length} URL repoints, ${moves.length} moves`);
  console.log(JSON.stringify(stats, null, 2));

  if (!DRY_RUN) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const u of updates) {
        await client.query('UPDATE media_assets SET url = $2, original_url = $2 WHERE id = $1', [u.id, u.url]);
      }
      for (const mv of moves) {
        // unique index (product_id, sku_id, asset_type, sort_order) — bump sort past owner's existing rows
        await client.query(`
          UPDATE media_assets SET sku_id = $2, product_id = $3,
            sort_order = COALESCE((SELECT MAX(sort_order) FROM media_assets
              WHERE sku_id = $2 AND asset_type = media_assets.asset_type), -1) + 1
          WHERE id = $1
        `, [mv.id, mv.sku_id, mv.product_id]);
      }
      if (deletes.length) {
        await client.query('DELETE FROM media_assets WHERE id = ANY($1)', [deletes]);
      }
      await client.query('COMMIT');
      console.log('\nApplied.');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Impact report
  const { rows: [after] } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE NOT EXISTS (
      SELECT 1 FROM media_assets m2 JOIN skus s2 ON s2.id = m2.sku_id WHERE s2.product_id = p.id
    ) AND NOT EXISTS (
      SELECT 1 FROM media_assets m3 WHERE m3.product_id = p.id AND m3.sku_id IS NULL AND m3.asset_type = 'primary'
    )) AS imageless_products, COUNT(*) AS active_products
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vendor.id]);
  console.log(`\nActive products with no primary anywhere: ${after.imageless_products}/${after.active_products}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
