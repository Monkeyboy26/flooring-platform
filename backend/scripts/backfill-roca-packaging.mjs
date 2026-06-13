/**
 * Backfill Roca packaging gaps + compute sqft_per_pallet.
 *
 * 1. Reads the XLSX price book and parses packaging data per vendor_sku.
 * 2. Finds ROCA SKUs missing packaging records and inserts them.
 * 3. Computes sqft_per_pallet for ALL existing ROCA packaging records.
 *
 * Usage: node backend/scripts/backfill-roca-packaging.mjs [--dry-run]
 */
import pg from 'pg';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DRY_RUN = process.argv.includes('--dry-run');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

// ── Parse packaging from XLSX ──
function parsePackaging(ws, sheetType) {
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const pkgMap = new Map(); // vendor_sku (uppercase) → { pcsBox, sfBox, bxsPallet }

  let currentPcsBox = null, currentSfBox = null, currentBxsPallet = null;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    if (sheetType === 'main') {
      const col2 = String(row[2] || '').trim();

      // Collection header → reset sticky packaging values
      if (col2.includes(' - ') && col2 !== 'SKU' && !col2.startsWith('*')) {
        currentPcsBox = null; currentSfBox = null; currentBxsPallet = null;
        continue;
      }
      if (col2 === 'SKU') continue;

      const sku = col2.replace(/\*+$/, '').trim();
      const desc = String(row[4] || '').trim();
      if (!sku || !desc || sku.length < 4) continue;

      if (row[7] !== '' && row[7] != null) currentPcsBox = parseFloat(row[7]);
      if (row[8] !== '' && row[8] != null) currentSfBox = parseFloat(row[8]);
      if (row[10] !== '' && row[10] != null) currentBxsPallet = parseFloat(row[10]);

      if (currentSfBox || currentPcsBox) {
        pkgMap.set(sku.toUpperCase(), {
          pcsBox: currentPcsBox, sfBox: currentSfBox, bxsPallet: currentBxsPallet,
        });
      }
    } else {
      const col1 = String(row[1] || '').trim();

      if (col1.includes(' - ') && col1 !== 'SKU') {
        currentPcsBox = null; currentSfBox = null; currentBxsPallet = null;
        continue;
      }
      if (col1 === 'SKU') continue;

      const sku = col1.replace(/\*+$/, '').trim();
      const desc = String(row[3] || '').trim();
      if (!sku || !desc || sku.length < 4 || sku.startsWith('(')) continue;

      if (row[6] !== '' && row[6] != null) currentPcsBox = parseFloat(row[6]);
      if (row[7] !== '' && row[7] != null) currentSfBox = parseFloat(row[7]);
      if (row[9] !== '' && row[9] != null) currentBxsPallet = parseFloat(row[9]);

      if (currentSfBox || currentPcsBox) {
        pkgMap.set(sku.toUpperCase(), {
          pcsBox: currentPcsBox, sfBox: currentSfBox, bxsPallet: currentBxsPallet,
        });
      }
    }
  }
  return pkgMap;
}

async function run() {
  const xlsxPath = join(__dirname, '..', 'data', 'roca-2026-pricebook.xlsx');
  const wb = XLSX.readFile(xlsxPath);

  const mainPkg = parsePackaging(wb.Sheets['2026 PRICING'], 'main');
  const soPkg = parsePackaging(wb.Sheets['2026 SPECIAL ORDER PRICING'], 'so');
  // Merge — SO overrides main for duplicate SKUs
  const allPkg = new Map([...mainPkg, ...soPkg]);
  console.log(`Parsed packaging for ${allPkg.size} vendor SKUs from XLSX\n`);

  const client = await pool.connect();
  try {
    // ── Step 1: Find ROCA SKUs missing packaging ──
    const missing = await client.query(`
      SELECT s.id as sku_id, s.vendor_sku
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN packaging pkg ON pkg.sku_id = s.id
      WHERE v.code = 'ROCA' AND pkg.sku_id IS NULL
    `);
    console.log(`SKUs missing packaging: ${missing.rowCount}`);

    if (!DRY_RUN) await client.query('BEGIN');

    let inserted = 0, notFound = 0;
    for (const row of missing.rows) {
      const key = (row.vendor_sku || '').toUpperCase();
      const pkg = allPkg.get(key);
      if (!pkg) {
        console.log(`  NOT IN XLSX: ${row.vendor_sku}`);
        notFound++;
        continue;
      }
      const sfBox = pkg.sfBox || null;
      const bxPallet = pkg.bxsPallet || null;
      const sfPallet = (sfBox && bxPallet) ? +(sfBox * bxPallet).toFixed(2) : null;

      if (!DRY_RUN) {
        await client.query(`
          INSERT INTO packaging (sku_id, sqft_per_box, pieces_per_box, boxes_per_pallet, sqft_per_pallet)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (sku_id) DO NOTHING
        `, [row.sku_id, sfBox, pkg.pcsBox || null, bxPallet, sfPallet]);
      }
      inserted++;
    }
    console.log(`Packaging inserted: ${inserted}`);
    if (notFound > 0) console.log(`Not found in XLSX: ${notFound}`);

    // ── Step 2: Compute sqft_per_pallet for ALL existing ROCA packaging ──
    let updated;
    if (!DRY_RUN) {
      const res = await client.query(`
        UPDATE packaging SET sqft_per_pallet = round((sqft_per_box * boxes_per_pallet)::numeric, 2)
        WHERE sqft_per_box IS NOT NULL AND boxes_per_pallet IS NOT NULL
          AND sqft_per_pallet IS NULL
          AND sku_id IN (
            SELECT s.id FROM skus s
            JOIN products p ON p.id = s.product_id
            JOIN vendors v ON v.id = p.vendor_id
            WHERE v.code = 'ROCA'
          )
      `);
      updated = res.rowCount;
    } else {
      const res = await client.query(`
        SELECT count(*) as cnt FROM packaging
        WHERE sqft_per_box IS NOT NULL AND boxes_per_pallet IS NOT NULL
          AND sqft_per_pallet IS NULL
          AND sku_id IN (
            SELECT s.id FROM skus s
            JOIN products p ON p.id = s.product_id
            JOIN vendors v ON v.id = p.vendor_id
            WHERE v.code = 'ROCA'
          )
      `);
      updated = parseInt(res.rows[0].cnt);
    }
    console.log(`sqft_per_pallet computed: ${updated}`);

    if (!DRY_RUN) {
      await client.query('COMMIT');
      console.log('\nCommitted.');
    } else {
      console.log('\n(DRY RUN — no changes written)');
    }

    // ── Summary ──
    const finalRes = await client.query(`
      SELECT count(*) as total,
             count(pkg.sku_id) as has_pkg,
             count(pkg.sqft_per_pallet) as has_sqft_pallet
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN packaging pkg ON pkg.sku_id = s.id
      WHERE v.code = 'ROCA'
    `);
    const r = finalRes.rows[0];
    console.log(`\nFinal: ${r.has_pkg}/${r.total} SKUs have packaging, ${r.has_sqft_pallet} have sqft_per_pallet`);

  } catch (err) {
    if (!DRY_RUN) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
