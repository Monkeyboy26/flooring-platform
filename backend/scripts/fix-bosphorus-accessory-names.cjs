#!/usr/bin/env node
/**
 * Backfill accessory_label on Bosphorus accessory SKUs.
 *
 * Problem: group-bosphorus-colors.cjs merges every size/finish product into a
 * single collection-named product ("Arenite"). Accessory SKUs then have an
 * empty accessory_label, so the storefront PDP falls back to the product name
 * and renders EVERY trim piece (bullnose, mosaic, liner, quarter round...) as
 * just the collection name — indistinguishable and deduped down to one card.
 *
 * Fix: derive a descriptive label ("Bullnose 3x24", "Pencil Liner 1/2x8",
 * "Mosaic 2x2") from the SKU's size attribute (which carries the vendor's trim
 * keyword) plus dimension heuristics. Mirrors buildAccessoryLabel() in
 * backend/scrapers/bosphorus.js so re-scrapes and this backfill agree.
 *
 * Usage:
 *   node backend/scripts/fix-bosphorus-accessory-names.cjs --dry-run
 *   node backend/scripts/fix-bosphorus-accessory-names.cjs
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const dryRun = process.argv.includes('--dry-run');

// Parse a dimension token ("3", "1/2", "2 1/2", "0.5") to a number.
function parseDimension(s) {
  const t = (s || '').trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/); // "2 1/2"
  if (mixed) return parseInt(mixed[1], 10) + parseInt(mixed[2], 10) / parseInt(mixed[3], 10);
  const frac = t.match(/^(\d+)\/(\d+)$/); // "1/2"
  if (frac) return parseInt(frac[1], 10) / parseInt(frac[2], 10);
  const n = parseFloat(t);
  return isNaN(n) ? NaN : n;
}

// Classify a bare "AxB" dimension into a trim type (no vendor keyword present).
function inferType(dim) {
  const parts = (dim || '').split(/x/i);
  if (parts.length !== 2) return null;
  const d1 = parseDimension(parts[0]);
  const d2 = parseDimension(parts[1]);
  if (isNaN(d1) || isNaN(d2)) return null;
  const min = Math.min(d1, d2);
  const max = Math.max(d1, d2);
  if (min < 1 && max <= 6) return 'Quarter Round';
  if (min <= 1 && max > 6) return 'Pencil Liner';
  if (min <= 2.5 && max <= 5) return 'Mosaic';
  if (min > 1 && min < 2.5 && max >= 8) return 'Trim Liner';
  if (min >= 2.5 && min <= 3 && max >= 8) return 'Bullnose';
  return null;
}

// Mirror of buildAccessoryLabel() in backend/scrapers/bosphorus.js.
function buildAccessoryLabel(sizeNorm, finish) {
  const raw = (sizeNorm || '').trim();
  const m = raw.match(/^\s*((?:\d+\s+)?\d+(?:\.\d+)?(?:\/\d+)?\s*x\s*\d+(?:\.\d+)?(?:\/\d+)?)\s*(.*)$/i);
  const dim = m ? m[1].replace(/\s*x\s*/i, 'x').trim() : raw;
  const keyword = m ? m[2].trim() : '';

  const hay = `${keyword} ${finish || ''}`.toLowerCase();
  let type;
  if (/bullnose/.test(hay)) type = 'Bullnose';
  else if (/jolly/.test(hay)) type = 'Jolly Liner';
  else if (/chair\s*rail/.test(hay)) type = 'Chair Rail';
  else if (/quarter\s*round/.test(hay)) type = 'Quarter Round';
  else if (/pencil/.test(hay)) type = 'Pencil Liner';
  else if (/mosaic/.test(hay)) type = 'Mosaic';
  else type = inferType(dim) || 'Trim';

  return dim && /x/i.test(dim) ? `${type} ${dim}` : type;
}

async function main() {
  console.log(`\n=== Fix Bosphorus Accessory Names ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);

  const { rows: [vendor] } = await pool.query(
    `SELECT id, name FROM vendors WHERE name ILIKE '%bosphorus%' LIMIT 1`
  );
  if (!vendor) { console.error('No Bosphorus vendor found'); process.exit(1); }
  console.log(`Vendor: ${vendor.name} (${vendor.id})\n`);

  const { rows } = await pool.query(`
    SELECT s.id, s.variant_name, s.accessory_label,
           sz.value AS size, fn.value AS finish
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN sku_attributes sz ON sz.sku_id = s.id
      AND sz.attribute_id = (SELECT id FROM attributes WHERE slug = 'size')
    LEFT JOIN sku_attributes fn ON fn.sku_id = s.id
      AND fn.attribute_id = (SELECT id FROM attributes WHERE slug = 'finish')
    WHERE p.vendor_id = $1 AND s.variant_type = 'accessory'
  `, [vendor.id]);

  console.log(`Found ${rows.length} accessory SKUs\n`);

  const counts = {};
  let updated = 0, unchanged = 0;
  for (const r of rows) {
    const label = buildAccessoryLabel(r.size, r.finish);
    counts[label] = (counts[label] || 0) + 1;
    if (label === r.accessory_label) { unchanged++; continue; }
    updated++;
    if (!dryRun) {
      await pool.query('UPDATE skus SET accessory_label = $1 WHERE id = $2', [label, r.id]);
    }
  }

  console.log('Label distribution:');
  for (const [label, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label}: ${n}`);
  }
  console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${updated} SKUs (${unchanged} already correct)\n`);

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
