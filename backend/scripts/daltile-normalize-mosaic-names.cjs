#!/usr/bin/env node
/**
 * Normalize Daltile mosaic variant names to a single canonical format:
 *
 *     "Size, Finish, Pattern Mosaic"      e.g. "2x2, Matte, Hexagon Mosaic"
 *
 * Many mosaics had garbled names — leaked EDI color-ref numbers and raw shape
 * codes ("1, Hexagon Mosaic, 2, Matte, 1, 2, HEX1") and a corrupted `size`
 * attribute ("1", "1, 2"). This REBUILDS the name from clean parts:
 *   - Pattern:  decoded from the vendor_sku shape code (patternFromVendorSku).
 *   - Finish:   the clean `finish` sku_attribute.
 *   - Size:     the clean `size` attribute (NxN); single digits -> NxN; if the
 *               attribute is garbled/missing, decoded from the vendor_sku digits.
 * It also repairs the `size` attribute and populates the `pattern` attribute.
 *
 * Trims are skipped. Backs up every change to a JSON file for a full revert.
 *
 *   node backend/scripts/daltile-normalize-mosaic-names.cjs --dry-run
 *   node backend/scripts/daltile-normalize-mosaic-names.cjs
 *   node backend/scripts/daltile-normalize-mosaic-names.cjs --revert <backup.json>
 */
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { patternFromVendorSku } = require('../scrapers/daltile-mosaic-pattern.cjs');
const { skuIsTrim } = require('../scrapers/daltile-image-rank.cjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DAL = '550e8400-e29b-41d4-a716-446655440003';
const DRY = process.argv.includes('--dry-run');
const rIdx = process.argv.indexOf('--revert');
const REVERT = rIdx !== -1 ? process.argv[rIdx + 1] : null;

// Keep a real dimension as-is (supports fractions like "1 1/4x4", "5/8x1",
// "2 1/2x2 1/2"); a single number -> square; only decode from the vendor_sku
// when the attribute is genuinely garbled (leaked ref-numbers) or missing.
function cleanSize(raw, vendorSku) {
  const s = String(raw || '').trim();
  if (/[xX]/.test(s) && !s.includes(',')) {          // already a real WxL
    return s.replace(/\s*[xX]\s*/, 'x').replace(/\s+/g, ' ').trim();
  }
  const one = s.match(/^(\d+(?:\.\d+)?|\d+\s+\d+\/\d+|\d+\/\d+)$/);  // single dim
  if (one) return `${one[1].trim()}x${one[1].trim()}`;
  return sizeFromVendorSku(vendorSku);               // garbled / null
}
function sizeFromVendorSku(vendorSku) {
  if (!vendorSku || vendorSku.length < 5) return null;
  const rest = vendorSku.slice(4).replace(/^[A-Z]+/i, '');  // strip color(4)+shape letters
  const d = rest.match(/^(\d+)/);
  if (!d) return null;
  const g = d[1];
  if (g.length === 1) return `${g}x${g}`;
  if (g.length === 2) return `${g[0]}x${g[1]}`;        // 22->2x2, 13->1x3
  if (g.length === 4) return `${g.slice(0, 2)}x${g.slice(2)}`;  // 1224->12x24
  if (g.length === 3) return `${g[0]}x${g.slice(1)}`;  // best-effort 324->3x24
  return null;
}

// Patterns that are inherently mosaic layouts (always get the " Mosaic" suffix,
// even when the product is filed under a non-mosaic category).
const MOSAIC_LAYOUTS = new Set([
  'Straight Joint', 'Stacked Joint', 'Straight Stack', 'Herringbone', 'Penny Round',
  'Brick Joint', 'Lattice Weave', 'Basketweave', 'Fish Scale', 'Octagon Dot',
  'Random Interlocking', 'Random Strip', 'Random Linear',
]);
const FINISH_WORD = /^(matte|glossy|polished|honed|satin|abrasive|glass|mixed|mix|natural|textured|unpolished|brushed|semi[- ]?polished|lappato)$/i;
const SIZEish = /^[\d\/.\s]+(x[\d\/.\s]+)?$/i;

// Fallback pattern when the vendor_sku shape code is unknown (e.g. Octagon-Dot
// color variants "Gray Dot", or literal "Pattern"): take the last descriptive
// token from the old garbled name.
function patternFromName(oldName) {
  const segs = String(oldName || '').split(',').map(s => s.trim()).filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (SIZEish.test(s) || FINISH_WORD.test(s) || /mosaic/i.test(s)) continue;
    if (/^[A-Za-z][A-Za-z /-]+$/.test(s)) return s;   // a word-ish descriptor
  }
  return null;
}

async function attrId(slug) {
  return (await pool.query(`SELECT id FROM attributes WHERE slug=$1`, [slug])).rows[0]?.id;
}
async function setAttr(id, sku, val) {
  await pool.query(
    `INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
     ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value=EXCLUDED.value`, [sku, id, val]);
}

async function revert(file) {
  const changes = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sizeId = await attrId('size'), patId = await attrId('pattern');
  for (const c of changes) {
    await pool.query(`UPDATE skus SET variant_name=$1 WHERE id=$2`, [c.old_variant_name, c.sku_id]);
    if (c.old_size === null) await pool.query(`DELETE FROM sku_attributes WHERE sku_id=$1 AND attribute_id=$2`, [c.sku_id, sizeId]);
    else await setAttr(sizeId, c.sku_id, c.old_size);
    if (c.old_pattern === null) await pool.query(`DELETE FROM sku_attributes WHERE sku_id=$1 AND attribute_id=$2`, [c.sku_id, patId]);
    else await setAttr(patId, c.sku_id, c.old_pattern);
  }
  console.log(`Reverted ${changes.length} rows.`);
  await pool.end();
}

async function main() {
  if (REVERT) return revert(REVERT);
  console.log(`\nDaltile Mosaic Name Normalization${DRY ? ' (DRY RUN)' : ''}\n`);
  const sizeId = await attrId('size'), finishId = await attrId('finish'), patId = await attrId('pattern');

  // All active Daltile mosaics: mosaic-tile category, or a mosaic name/image.
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.variant_type,
           (SELECT value FROM sku_attributes sa WHERE sa.sku_id=s.id AND sa.attribute_id=$2) AS size,
           (SELECT value FROM sku_attributes sa WHERE sa.sku_id=s.id AND sa.attribute_id=$3) AS finish,
           (SELECT value FROM sku_attributes sa WHERE sa.sku_id=s.id AND sa.attribute_id=$4) AS old_pattern,
           c.slug AS cat
    FROM skus s JOIN products p ON p.id=s.product_id
    LEFT JOIN categories c ON c.id=p.category_id
    WHERE p.vendor_id=$1 AND s.status='active'
      AND (c.slug='mosaic-tile' OR p.name ILIKE '%mosaic%' OR s.variant_name ILIKE '%mosaic%'
           OR EXISTS (SELECT 1 FROM media_assets ma WHERE ma.sku_id=s.id AND ma.url ILIKE '%\\_Msc\\_%')
           -- also catch garbled names (leaked ref-numbers) regardless of category
           OR s.variant_name ~ '(^|, )[0-9]+(,|$)')
  `, [DAL, sizeId, finishId, patId]);
  console.log(`Candidate mosaic SKUs: ${rows.length}`);

  const changes = []; const skipped = { trim: 0, noPattern: 0, unchanged: 0 };
  const patCount = {};
  for (const r of rows) {
    if (skuIsTrim(r.vendor_sku, null) || r.variant_type === 'accessory') { skipped.trim++; continue; }
    // Prefer the authoritative shape-code decode. Only fall back to reading the
    // pattern out of the name when the name is GARBLED (leaked ref-numbers) — a
    // clean but undecoded name ("Wave, Polished") is left untouched, not re-parsed.
    const garbled = /(^|, )[0-9]+(,|$)/.test(r.variant_name || '');
    const pattern = patternFromVendorSku(r.vendor_sku) || (garbled ? patternFromName(r.variant_name) : null);
    if (!pattern) { skipped.noPattern++; continue; }
    const size = cleanSize(r.size, r.vendor_sku);
    const finish = (r.finish || '').trim() || null;
    // Append " Mosaic" only for true mosaics (mosaic-tile category, a name that
    // already says mosaic, or an inherently-mosaic layout) — not for shape-named
    // field/wall tiles (a ceramic "Arabesque"/"Hexagon" isn't a mosaic).
    const isMosaic = r.cat === 'mosaic-tile' || /mosaic/i.test(r.variant_name || '')
      || MOSAIC_LAYOUTS.has(pattern);
    const label = isMosaic && !/mosaic/i.test(pattern) ? `${pattern} Mosaic` : pattern;
    const newName = [size, finish, label].filter(Boolean).join(', ');
    if (newName === (r.variant_name || '').trim()) { skipped.unchanged++; continue; }
    patCount[pattern] = (patCount[pattern] || 0) + 1;
    changes.push({ sku_id: r.sku_id, vendor_sku: r.vendor_sku,
      old_variant_name: r.variant_name, new_variant_name: newName,
      old_size: r.size ?? null, new_size: size,
      old_pattern: r.old_pattern ?? null, pattern });
  }

  console.log(`\nWill rebuild: ${changes.length}   (skipped: trim ${skipped.trim}, no-pattern ${skipped.noPattern}, already-canonical ${skipped.unchanged})`);
  console.log('\n=== patterns ===');
  for (const [p, n] of Object.entries(patCount).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${p}`);
  console.log('\n=== examples (old -> new) ===');
  for (const c of changes.slice(0, 25)) console.log(`  ${c.vendor_sku.padEnd(15)} "${c.old_variant_name || ''}"  ->  "${c.new_variant_name}"`);

  if (DRY) { console.log('\n(dry run — no writes)'); return pool.end(); }

  const backup = path.join(__dirname, '..', 'data', `daltile-mosaic-name-backup-${Date.now()}.json`);
  fs.writeFileSync(backup, JSON.stringify(changes, null, 1));
  console.log(`\nBackup: ${backup}`);
  for (const c of changes) {
    await pool.query(`UPDATE skus SET variant_name=$1, updated_at=now() WHERE id=$2`, [c.new_variant_name, c.sku_id]);
    if (c.new_size) await setAttr(sizeId, c.sku_id, c.new_size);
    await setAttr(patId, c.sku_id, c.pattern);
  }
  console.log(`Updated ${changes.length} SKUs.`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
