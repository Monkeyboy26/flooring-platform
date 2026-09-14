/**
 * Fix MSI mosaic products that borrow their coordinating FIELD-TILE / slab image
 * (so a 2x2 mosaic PDP "shows a field tile"). For each affected mosaic SKU we
 * probe MSI's CDN for the real mosaic shot and, if found, replace the borrowed
 * images with it. Products with no mosaic image on the CDN are left as-is and
 * reported (they need a vendor photo).
 *
 * Signature of the bug: a mosaic-tile SKU whose primary image is ALSO used by a
 * NON-mosaic MSI product, and whose filename lacks a mosaic/shape token.
 *
 * Usage:
 *   DB_PASSWORD=postgres node scripts/fix-msi-mosaic-field-images.mjs          # DRY/PROBE
 *   DB_PASSWORD=postgres node scripts/fix-msi-mosaic-field-images.mjs --apply
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = '550e8400-e29b-41d4-a716-446655440001';
const CDN = 'https://cdn.msisurfaces.com/images';
const APPLY = process.argv.includes('--apply');
// A filename already showing a mosaic/shape token is presumed correct.
const MOSAIC_TOKEN = /2x2|1x1|hex|mosaic|penny|basketweave|herringbone|chevron|dotty|subway|floret|hatchwork|kaya|linea|sazi|arabesque|picket|pinwheel/i;

function headOk(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Derive candidate mosaic image URLs for a mosaic product.
function candidates(name, variantName, borrowedUrl) {
  const cands = new Set();
  // Shape-specific only — never fall back to a square 2x2 for a shaped mosaic
  // (a square image on a hex/chevron product is a wrong image).
  const shape = (() => {
    const v = `${name} ${variantName || ''}`.toLowerCase();
    if (/hex/.test(v)) return ['2x2-hex', 'hex'];
    if (/chevron/.test(v)) return ['chevron'];
    if (/basketweave/.test(v)) return ['basketweave'];
    if (/penny/.test(v)) return ['penny-round'];
    if (/dotty/.test(v)) return ['dotty'];
    if (/subway/.test(v)) return ['2x4'];
    return ['2x2'];
  })();

  // Base from product name: drop the trailing shape/mosaic words.
  const nameBase = slug(name.replace(/\b(2x2|1x1|12x15|matte|polished|mosaic|hexagon|chevron|basketweave|penny\s*round|dotty|subway|3d|lappatpo)\b/gi, ' ').replace(/\s+/g, ' ').trim());
  // Base from the borrowed URL filename: strip dir/ext, size, finish. Keep TWO
  // variants — one that also strips the material word and one that retains it,
  // since MSI mosaics use both forms (silver-trav-porcelain-2x2.jpg keeps
  // "-porcelain"; savoy-azula-2x2.jpg has none).
  const fn = (borrowedUrl || '').split('?')[0].split('/').pop().replace(/\.(jpg|jpeg|png|webp)$/i, '');
  const urlBaseMat = fn.replace(/-\d+x\d+/g, '').replace(/-(polished|matte|honed|glossy|satin|brushed)/gi, '').replace(/-+$/, '');
  const urlBase = urlBaseMat.replace(/-(porcelain|ceramic|marble|granite|travertine|essentials|slab)/gi, '').replace(/-+$/, '');

  // Color-only base: MSI mosaics often drop the collection word
  // ("Pietra Carrara 2x2 Mosaic" → carrara-2x2.jpg). Take the name minus its
  // leading collection word and the shape words.
  const words = name.replace(/\b(2x2|1x1|12x15|matte|polished|mosaic|hexagon|chevron|basketweave|penny\s*round|dotty|subway|3d|lappatpo)\b/gi, ' ').replace(/\s+/g, ' ').trim().split(' ');
  const colorOnly = words.length > 1 ? slug(words.slice(1).join('-')) : '';

  const bases = [urlBaseMat, urlBase, nameBase, colorOnly].filter(Boolean);
  const dirs = ['porcelainceramic', 'mosaics'];
  for (const b of bases) for (const d of dirs) for (const sh of shape) {
    cands.add(`${CDN}/${d}/${b}-${sh}.jpg`);
    cands.add(`${CDN}/${d}/${b}-${sh}-mosaic.jpg`);
  }
  return [...cands];
}

async function main() {
  const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres' });
  const { rows } = await pool.query(`
    WITH mos AS (
      SELECT s.id sid, s.product_id pid, s.vendor_sku, s.variant_name, p.name, ma.url
      FROM products p JOIN categories c ON c.id=p.category_id
      JOIN skus s ON s.product_id=p.id
      JOIN media_assets ma ON ma.sku_id=s.id AND ma.asset_type='primary'
      WHERE p.vendor_id=$1 AND c.slug='mosaic-tile' AND s.status='active'
    )
    SELECT * FROM mos WHERE EXISTS (
      SELECT 1 FROM media_assets ma2 JOIN skus s2 ON s2.id=ma2.sku_id JOIN products p2 ON p2.id=s2.product_id
      JOIN categories c2 ON c2.id=p2.category_id
      WHERE ma2.url=mos.url AND p2.vendor_id=$1 AND c2.slug<>'mosaic-tile')`, [VENDOR]);

  // keep only the true bugs: borrowed URL filename lacks a mosaic token
  const buggy = rows.filter(r => !MOSAIC_TOKEN.test((r.url.split('/').pop() || '')));
  console.log(`MSI mosaic borrowed-field-image fix — ${APPLY ? 'APPLY' : 'DRY/PROBE'}`);
  console.log(`  Candidate buggy mosaics: ${buggy.length} (of ${rows.length} sharing an image)`);
  console.log('');

  const fixed = [], missed = [];
  for (const r of buggy) {
    let hit = null;
    for (const u of candidates(r.name, r.variant_name, r.url)) {
      if (await headOk(u)) { hit = u; break; }
    }
    if (hit) { fixed.push({ ...r, hit }); console.log(`  ✔ ${r.name}  (${r.vendor_sku})\n      → ${hit.replace(CDN,'')}`); }
    else { missed.push(r); console.log(`  x ${r.name}  (${r.vendor_sku})  — no CDN mosaic image`); }
  }

  if (APPLY && fixed.length) {
    const client = await pool.connect();
    const backup = [];
    try {
      await client.query('BEGIN');
      for (const f of fixed) {
        const { rows: old } = await client.query('SELECT * FROM media_assets WHERE sku_id=$1', [f.sid]);
        backup.push(...old);
        await client.query('DELETE FROM media_assets WHERE sku_id=$1', [f.sid]);
        await client.query(`INSERT INTO media_assets (product_id, sku_id, asset_type, url, source, sort_order)
          VALUES ($1,$2,'primary',$3,'manual-fix',0)`, [f.pid, f.sid, f.hit]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    const bpath = path.join(__dirname, `../data/msi-mosaic-image-fix-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    fs.writeFileSync(bpath, JSON.stringify(backup, null, 2));
    console.log(`\n  Applied: ${fixed.length} mosaics re-imaged, ${missed.length} still need a vendor photo. Backup → ${bpath}`);
  } else {
    console.log(`\n  ${fixed.length} fixable via CDN, ${missed.length} need a vendor photo. ${APPLY?'':'Re-run with --apply.'}`);
  }
  await pool.end();
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
