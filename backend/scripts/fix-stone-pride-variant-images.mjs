#!/usr/bin/env node
/**
 * Stone Pride — variant image mismatch fix (2026-09-08)
 *
 * Problem: Stone Pride (STPR/714) publishes only a limited set of pattern photos.
 * ~347 SKUs matched their own photo cleanly (verified: 0 wrong-color, sizes/finishes
 * correct). But ~299 active variant SKUs have NO photo of their own pattern/size, so
 * the storefront (server.js media tier-3) falls back to the PRODUCT hero — one specific
 * pattern. Result: selecting e.g. "2x2" on "Carrara White Marble Mosaic" shows the
 * 1.5x6 Herringbone hero. "Images don't match the variant."
 *
 * We cannot fabricate the missing pattern photos. Chosen strategy (owner-approved):
 * show a pattern-NEUTRAL stone swatch (correct color/material) on unmatched variants
 * instead of another variant's specific photo. Photoless only where no swatch exists.
 *
 * What this does (idempotent — clears its own prior SKU-level attaches and re-derives):
 *   1. Builds a per-stone "neutral material" map = a real FLAT FIELD TILE (Tile-XX-NxN /
 *      CONT.CG-NxN), preferring larger, squarer tiles. NOTE: the bare-code "<stone>-<name>"
 *      files (CW-Carrara-White, AR-Arabescato-Oriental-White, CM-Crema-Marfil) look like
 *      slab swatches but are actually MOSAIC photos (3D-cube, lantern) — excluded.
 *   2. For each ACTIVE STPR SKU in a single-stone "… Marble Tile/Mosaic" product that
 *      lacks its own sku-level primary AND whose stone has a field-tile neutral, attaches
 *      it as a SKU-level primary (source='fixup-neutral-swatch'). The product hero (the
 *      nice pattern photo) is left intact so browse/grid cards stay attractive.
 *   3. Trim/baseboard product heroes on Tile products: repointed to the stone's neutral if
 *      one exists, else DELETED so the tile renders photoless (Black Absolute — only trim
 *      photos exist; no image beats a baseboard).
 *   4. Terrazzo Tile: variants fall back to a blue hex mosaic hero; attaches the real
 *      per-color Blue/Gold/Silver flat terrazzo tile and repoints the (tile) hero.
 *
 * Blends (CWBM/CWTW/…), medallions (per-shape already), glass murals, borders/liners and
 * stones with no flat field tile (CM, RA, Haisa, Emperador…) are left as-is / photoless.
 *
 * Reverse: DELETE FROM media_assets WHERE source='fixup-neutral-swatch';
 *          (product-hero repoints are logged; re-run of match script would reset them)
 *
 * Usage (inside api container):
 *   docker compose exec -T api node scripts/fix-stone-pride-variant-images.mjs --dry-run
 *   docker compose exec -T api node scripts/fix-stone-pride-variant-images.mjs
 */
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DRY = process.argv.includes('--dry-run');
const SOURCE = 'fixup-neutral-swatch';

const STONE_NAMES = new Set(['CW','CM','CG','TW','AR','BM','BA','BG','ED','EL','HO','RA','HB','AG','NB','NC','NP','TB','GW']);
const fname = u => decodeURIComponent((u || '').split('?')[0].split('/').pop() || '');
const PFX = /^(MS|Tile|FR|ML|MSL|MM)-/i;

// Normalize a raw stone token: uppercase, drop dots, ARDB->AR (DanBa is an Arabescato).
function normStone(code) {
  if (!code) return null;
  let c = code.toUpperCase().replace(/\./g, '');
  if (c === 'ARDB') c = 'AR';
  return c;
}
// Stone of a SKU from its vendor_sku (keeps CONTCG distinct from CG).
function stoneOfSku(vs) {
  const m = PFX.exec(vs);
  if (!m) return null;
  const rest = vs.slice(m[0].length);
  const mm = /^([A-Za-z().]+?)(?:-|\d)/.exec(rest);
  if (!mm) return null;
  return normStone(mm[1].replace(/\(.*$/, ''));
}
// Stone that an image filename depicts (from its embedded code).
function stoneOfImg(fn) {
  let m = /^(?:MS|Tile|FR|ML|MSL|MM)-([A-Za-z.]+?)[-\d]/i.exec(fn);
  if (m) return normStone(m[1]);
  m = /^([A-Za-z.]{2,8}?)[-_]/.exec(fn);   // bareword incl. dotted codes (CONT.CG-)
  if (m) return normStone(m[1]);
  return null;
}

// A neutral must be a plain FLAT FIELD TILE. The bare-code "<stone>-<name>" files
// (CW-Carrara-White, AR-Arabescato-Oriental-White, CM-Crema-Marfil) look like slab
// swatches by their names but are actually MOSAIC photos (3D-cube hexagon, lantern),
// so they are NOT neutral — only real Tile-/CONT. field-tile shots qualify.
const BAD = /bevel|hex|herring|brick|basket|chevron|chervon|rhomb|penny|octagon|\boct\b|liner|baseboard|\bf\d\b|\bp1[0-9]|\bp20\b|frame|border|medallion|mural|corner|vase|wave|grooved|3d|lantern|arabesque|stone-names/i;
const FIELD_TILE = /^(Tile-|CONT\.)/i;   // Tile-CW-12x24-Honed, CONT.CG-12X24-HONED-2
// scoreBySize: 1 for >=12in, 2 for >=6in, 3 otherwise
const scoreBySize = (a, b) => { const big = Math.max(+a, +b); return big >= 12 ? 1 : big >= 6 ? 2 : 3; };
// Lower score = more neutral. null = not usable as neutral.
function neutralScore(fn) {
  if (BAD.test(fn) || !FIELD_TILE.test(fn)) return null;
  const size = /(\d+)\s*[xX]\s*(\d+)/.exec(fn);
  return size ? scoreBySize(size[1], size[2]) : null;
}

async function main() {
  const { rows: vrows } = await pool.query(`SELECT id FROM vendors WHERE code='STPR'`);
  if (!vrows.length) throw new Error('STPR vendor not found');
  const vendorId = vrows[0].id;

  // Self-heal: drop prior SKU-level neutral attaches so they are re-derived cleanly on
  // every run (an earlier version mistook mosaic photos for swatches). Product-level
  // hero repoints are left in place — the hero blocks below re-evaluate them idempotently.
  if (!DRY) {
    const { rowCount } = await pool.query(`
      DELETE FROM media_assets ma USING products p
      WHERE ma.product_id = p.id AND p.vendor_id = $1
        AND ma.sku_id IS NOT NULL AND ma.source = $2
    `, [vendorId, SOURCE]);
    if (rowCount) console.log(`Cleared ${rowCount} prior SKU-level neutral attaches (re-deriving)\n`);
  }

  // ---- build per-stone neutral map from existing STPR images ----
  const { rows: imgs } = await pool.query(`
    SELECT ma.url, ma.original_url
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.asset_type IN ('primary','alternate')
  `, [vendorId]);

  const best = new Map(); // stone -> {score, minDim, aspect, url, original_url, fn}
  for (const r of imgs) {
    const fn = fname(r.original_url || r.url);
    const sc = neutralScore(fn);
    if (sc == null) continue;
    const st = stoneOfImg(fn);
    if (!st || !(STONE_NAMES.has(st) || st === 'CONTCG')) continue;  // ignore medallion "Stone-names" junk keys
    const sz = /(\d+)\s*[xX]\s*(\d+)/.exec(fn);
    const a = +sz[1], b = +sz[2], minDim = Math.min(a, b), aspect = Math.max(a, b) / Math.min(a, b);
    const cand = { score: sc, minDim, aspect, url: r.url, original_url: r.original_url, fn };
    const cur = best.get(st);
    // prefer: lower score, then larger min dimension (avoid skinny 2x12), then squarer, then shorter name
    const better = !cur || sc < cur.score
      || (sc === cur.score && minDim > cur.minDim)
      || (sc === cur.score && minDim === cur.minDim && aspect < cur.aspect)
      || (sc === cur.score && minDim === cur.minDim && aspect === cur.aspect && fn.length < cur.fn.length);
    if (better) best.set(st, cand);
  }
  console.log('Neutral swatch per stone:');
  for (const st of [...best.keys()].sort()) console.log(`  ${st.padEnd(7)} [${best.get(st).score}] ${best.get(st).fn}`);

  // ---- unmatched active SKUs in single-stone Tile/Mosaic products ----
  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.variant_name, p.name AS pname
    FROM skus s
    JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND s.status = 'active'
      AND p.name ~* 'Marble (Tile|Mosaic)$'
      AND p.name !~* ' & '                                  -- exclude 2-stone blends
      AND NOT EXISTS (
        SELECT 1 FROM media_assets m
        WHERE m.sku_id = s.id AND m.asset_type = 'primary'
      )
  `, [vendorId]);

  let attached = 0, skippedNoNeutral = 0;
  const missByStone = {};
  for (const s of skus) {
    const st = stoneOfSku(s.vendor_sku);
    const n = st && best.get(st);
    if (!n) { skippedNoNeutral++; missByStone[st || '?'] = (missByStone[st || '?'] || 0) + 1; continue; }
    if (DRY) { attached++; continue; }
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
      VALUES ($1, $2, 'primary', $3, $4, 0, $5)
      ON CONFLICT DO NOTHING
    `, [s.product_id, s.sku_id, n.url, n.original_url, SOURCE]);
    attached++;
  }

  // ---- fix TRIM/baseboard product heroes on Tile products ----
  const { rows: badHeroes } = await pool.query(`
    SELECT ma.id, ma.product_id, p.name AS pname, ma.url, ma.original_url,
           (SELECT s.vendor_sku FROM skus s WHERE s.product_id = p.id LIMIT 1) AS sample_sku
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.sku_id IS NULL AND ma.asset_type = 'primary'
      AND p.name ~* 'Marble Tile$'
      AND (ma.original_url ILIKE '%baseboard%' OR ma.original_url ~* '/(FR|ML)-')
  `, [vendorId]);

  let heroFixed = 0, heroDeleted = 0;
  for (const h of badHeroes) {
    const st = stoneOfSku(h.sample_sku || '');
    const n = st && best.get(st);
    if (n) {
      console.log(`  hero FIX: [${h.pname}] ${fname(h.original_url || h.url)} -> ${n.fn}`);
      if (!DRY) await pool.query(`UPDATE media_assets SET url=$1, original_url=$2, source=$3 WHERE id=$4`,
        [n.url, n.original_url, SOURCE, h.id]);
      heroFixed++;
    } else {
      // Borrowed trim/baseboard on a Tile product with no neutral available (e.g. Black
      // Absolute — only trim/profile photos exist). No image beats a wrong one: remove it
      // so the tile variants render photoless instead of a baseboard.
      console.log(`  hero DELETE (borrowed trim, no neutral): [${h.pname}] ${fname(h.original_url || h.url)}`);
      if (!DRY) await pool.query(`DELETE FROM media_assets WHERE id=$1`, [h.id]);
      heroDeleted++;
    }
  }

  // ---- Terrazzo Tile: per-COLOR flat-tile neutral (variants fall back to a blue hex
  // mosaic hero; real Blue/Gold/Silver terrazzo TILE photos exist, just unattached) ----
  const { rows: terrImgs } = await pool.query(`
    SELECT DISTINCT ma.url, ma.original_url
    FROM media_assets ma JOIN products p ON p.id = ma.product_id
    WHERE p.vendor_id = $1 AND ma.original_url ~* 'Terrazzo-(Blue|Gold|Silver)-[0-9]+x[0-9]+'
  `, [vendorId]);
  const terrByColor = new Map(); // color -> {url, original_url, size}
  for (const r of terrImgs) {
    const m = /Terrazzo-(Blue|Gold|Silver)-(\d+)x(\d+)/i.exec(r.original_url || r.url);
    if (!m) continue;
    const color = m[1].toLowerCase(), size = Math.max(+m[2], +m[3]);
    const cur = terrByColor.get(color);
    if (!cur || size > cur.size) terrByColor.set(color, { url: r.url, original_url: r.original_url, size });
  }
  const { rows: terrSkus } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.variant_name
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.name = 'Terrazzo Tile' AND s.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM media_assets m WHERE m.sku_id = s.id AND m.asset_type = 'primary')
  `, [vendorId]);
  let terrAttached = 0, terrSkipped = 0;
  for (const s of terrSkus) {
    const cm = /^(Blue|Gold|Silver)/i.exec((s.variant_name || '').trim());
    const n = cm && terrByColor.get(cm[1].toLowerCase());
    if (!n) { terrSkipped++; continue; }
    if (!DRY) await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
      VALUES ($1, $2, 'primary', $3, $4, 0, $5) ON CONFLICT DO NOTHING
    `, [s.product_id, s.sku_id, n.url, n.original_url, SOURCE]);
    terrAttached++;
  }
  // repoint the Terrazzo TILE hero (blue hex mosaic) to a flat blue terrazzo tile;
  // leave the identical Terrazzo MOSAIC hero alone (a hex is correct there)
  const terrHero = terrByColor.get('blue');
  const { rowCount: terrHeroFixed } = terrHero ? await pool.query(`
    UPDATE media_assets ma SET url=$1, original_url=$2, source=$3
    FROM products p
    WHERE ma.product_id = p.id AND p.vendor_id = $4 AND p.name = 'Terrazzo Tile'
      AND ma.sku_id IS NULL AND ma.asset_type = 'primary'
      AND ma.original_url ~* 'Terrazzo-6-Hex' ${DRY ? 'AND false' : ''}
  `, [terrHero.url, terrHero.original_url, SOURCE, vendorId]) : { rowCount: 0 };

  console.log(`\n${DRY ? '[DRY-RUN] would attach' : 'Attached'} neutral swatch to ${attached} unmatched variant SKUs`);
  console.log(`Skipped ${skippedNoNeutral} unmatched SKUs with no neutral available:`, missByStone);
  console.log(`Trim/baseboard heroes on Tile products: ${heroFixed} repointed, ${heroDeleted} deleted (photoless)`);
  console.log(`Terrazzo Tile: color map=${JSON.stringify([...terrByColor.keys()])}, ${terrAttached} variants ${DRY ? 'would get' : 'got'} a color tile (skipped ${terrSkipped}), hero repointed=${terrHeroFixed}`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
