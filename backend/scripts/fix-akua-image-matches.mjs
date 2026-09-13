/**
 * Akua image match sweep (2026-09-12).
 *
 * The Akua catalog build (akua-catalog.json) fuzzy-matched price-list names onto
 * akuamosaics.com data.js slugs and got ~35 SKUs wrong three ways:
 *   1. WRONG-COLOR borrows — e.g. "Elegance Black & White" got elegance-white-mix,
 *      "Pebble Stone White Round" got pebble-stone-black-round, all Extant
 *      Beige/Blue/Blue Mix got the emerald photos (Sky is a separate SKU with its
 *      own photos, so Blue ≠ Sky). No correct photo exists → DELETE media
 *      (photoless beats wrong).
 *   2. WRONG-FORMAT dups — Marmo "…Hex" SKUs (vendor_sku says MINIHEX) got the
 *      2x2 image though marmo-mini-hex-<color> exists; Sea "Mini Hex" (AUK-SEAHEX*)
 *      got the regular hex though sea-seahex-* exists → REPOINT.
 *   3. MISSED exact matches — 13 SKUs left photoless though the site has their
 *      image under a trivially different spelling (Onix/onyx, Riverstone/
 *      river-stone, B&w/black-and-white, Whitewood/white-wood) → ATTACH.
 *
 * For every attach/repoint: primary = sharp-processed local swatch (same
 * trim+center pipeline as fix-akua-swatch-images.mjs), lifestyle = rooms/<slug>,
 * alternate = labels/<slug>.
 *
 * Writes a backup of every touched media row to data/akua-image-matches-backup-<ts>.json.
 * MUST run inside the api container (sharp + uploads volume). Idempotent.
 *   docker compose exec -T api node scripts/fix-akua-image-matches.mjs
 */
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const UPLOADS = process.env.UPLOADS_PATH || path.resolve('uploads');
const OUTDIR = path.join(UPLOADS, 'akua');

// vendor_sku → correct site slug, or null = borrowed image, no real one exists.
const FIXES = {
  // 1. wrong-color borrows → photoless
  'CAY-ELBW': null,       // Elegance Black & White (had elegance-white-mix)
  'CAY-COWH': null,       // Core White (had core-white-wood)
  'CAY-EXBG1X2': null, 'CAY-EXBG2X2': null,               // Extant Beige (had emerald)
  'CAY-EXBL1X1': null, 'CAY-EXBL3X6': null,               // Extant Blue (had emerald; Sky is a separate SKU)
  'CAY-EXBM1X2': null, 'CAY-EXBM3X6': null,               // Extant Blue Mix (had emerald)
  'CAY-LOALSW': null, 'CAY-LOALSI': null,                 // Loft Alu SW/Silver (had grey; site "white" ambiguous)
  'CAY-NUSW': null,       // Nuur Super White (had black-and-white-mix)
  'CAY-NUSWMAR': null,    // Nuur Super White Marmara Mix (had plain marmara)
  'CAY-PSWH': null,       // Pebble Stone White Round (had black-round)
  'CAY-PSBW': null,       // Pebble Stone Super Wht/Blk Mix Sliced (had black-sliced)
  'CAY-PCGM': null,       // Pebblecycle Grey Mix (had plain grey)
  'CAY-STGM': null,       // Stickcycle Grey Mix (had avorio-mix)
  // 2. wrong-format repoints
  'CAY-ELCA': 'elegance-carrara',
  'CAY-MARMCGMINIHEX': 'marmo-mini-hex-calacatta-grey',   // had 2x2 calacatta GOLD (color+format wrong)
  'CAY-MARMCGOMINIHEX': 'marmo-mini-hex-calacatta-gold',
  'CAY-MARMCARMINIHEX': 'marmo-mini-hex-carrara',
  'CAY-MARMTHASMINIHEX': 'marmo-mini-hex-thassos',
  'AUK-SEAHEXMGR': 'sea-seahex-emerald-green',
  'AUK-SEAHEXOB': 'sea-seahex-ocean-blue',
  'AUK-SEAHEXWF': 'sea-seahex-white-foam',
  // 3. missed exact matches (were photoless)
  'CAY-NUON': 'nuur-onyx',
  'CAY-PCBW': 'pebblecycle-black-and-white',
  'CAY-PSMCSL': 'pebble-stone-multicolor-sliced',
  'CAY-PSWHSL': 'pebble-stone-white-sliced',
  'CAY-PSYESL': 'pebble-stone-yellow-sliced',
  'CAY-PSSWSL': 'pebble-stone-super-white-sliced',
  'CAY-PSMASL': 'pebble-stone-marmara-sliced',
  'CAY-PSRSCA': 'pebble-stone-river-stone-cappucino',
  'CAY-PSRSGR': 'pebble-stone-river-stone-grey',
  'CAY-PSRSSUM': 'pebble-stone-river-stone-sumatra',
  'CAY-PSRSWH': 'pebble-stone-river-stone-white',
  'CAY-PSRSWTG`': 'pebble-stone-river-stone-wtg',         // trailing backtick is real in the DB sku
  // Riverstone Black (CAY-PSRSBL) stays photoless — site has no river-stone black.
};

async function processSwatch(slug) {
  const resp = await fetch(`https://akuamosaics.com/images/swatches/${slug}.jpg`, { signal: AbortSignal.timeout(25000) });
  if (!resp.ok) throw new Error(`swatch fetch ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const out = await sharp(buf).trim({ threshold: 15 })
    .resize(600, 600, { fit: 'contain', background: '#ffffff', kernel: 'lanczos3' })
    .median(2).sharpen({ sigma: 1.2 }).jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUTDIR, `${slug}.jpg`), out);
  return `/uploads/akua/${slug}.jpg`;
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const backup = [];
  let removed = 0, attached = 0, missing = 0, failed = 0;

  for (const [vendorSku, slug] of Object.entries(FIXES)) {
    const row = (await pool.query(
      `SELECT p.id AS product_id, s.id AS sku_id, p.name FROM products p JOIN skus s ON s.product_id=p.id
       WHERE s.vendor_sku=$1`, [vendorSku])).rows[0];
    if (!row) { console.log(`! ${vendorSku}: SKU not found`); missing++; continue; }

    const old = (await pool.query(`SELECT * FROM media_assets WHERE product_id=$1`, [row.product_id])).rows;
    backup.push(...old);

    if (slug === null) {
      const del = await pool.query(`DELETE FROM media_assets WHERE product_id=$1`, [row.product_id]);
      removed += del.rowCount;
      console.log(`− ${vendorSku} ${row.name}: removed ${del.rowCount} borrowed media rows → photoless`);
      continue;
    }

    let localUrl;
    try { localUrl = await processSwatch(slug); }
    catch (e) { console.error(`! ${vendorSku} ${slug}: ${e.message}`); failed++; continue; }
    const room = `https://akuamosaics.com/images/rooms/${slug}.jpg`;
    const label = `https://akuamosaics.com/images/labels/${slug}.jpg`;
    // Wipe whatever was there (wrong-format borrow or nothing) and write the correct set.
    await pool.query(`DELETE FROM media_assets WHERE product_id=$1`, [row.product_id]);
    for (const [type, url, orig, sort] of [
      ['primary', localUrl, `https://akuamosaics.com/images/swatches/${slug}.jpg`, 0],
      ['lifestyle', room, room, 1],
      ['alternate', label, label, 2],
    ]) {
      await pool.query(
        `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`, [row.product_id, row.sku_id, type, url, orig, sort]);
    }
    attached++;
    console.log(`✓ ${vendorSku} ${row.name} → ${slug}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bpath = path.resolve('data', `akua-image-matches-backup-${ts}.json`);
  fs.writeFileSync(bpath, JSON.stringify(backup, null, 1));
  console.log(`\nDone: ${attached} attached/repointed, ${removed} media rows removed, ${missing} SKUs missing, ${failed} fetch failures`);
  console.log(`Backup of ${backup.length} prior media rows → ${bpath}`);
}

main().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
