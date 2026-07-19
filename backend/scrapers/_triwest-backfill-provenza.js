/**
 * Backfill vendor_sku for the active Provenza SKUs that were imported without
 * portal item numbers (blank vendor_sku, internal_sku like
 * TW-PROV-<collection>-<color>). Matches against the raw DNav row dump
 * (data/triwest-instock.json, PRO rows) by collection + color name.
 *
 *   node scrapers/_triwest-backfill-provenza.js          # dry run — print proposals
 *   node scrapers/_triwest-backfill-provenza.js --apply  # write vendor_sku
 */
import fs from 'fs';
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const norm = (v) => String(v ?? '').toUpperCase().replace(/\(.*?\)/g, '').replace(/[^A-Z0-9]/g, '');

// Portal pattern cell → collection key: strip COLL/COLLECTION and size tails
// ("VITALI ELITE COLL 10.24"" → VITALIELITE, "MODESSA COLL. 9.4"" → MODESSA)
function collectionKey(pattern) {
  return norm(String(pattern ?? '')
    .replace(/\bCOLL(ECTION)?\b\.?/gi, ' ')
    .replace(/[\d.]+["']?(\s*[xX]\s*[\d.]+["']?)?/g, ' '));
}

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const rows = JSON.parse(fs.readFileSync('/app/data/triwest-instock.json'));
  const pro = rows.filter(r => r.mfgr === 'PRO' && r.itemNumber);

  // Index portal rows by collectionKey + color
  const byKey = new Map();
  for (const r of pro) {
    const ck = collectionKey(r.pattern);
    const colors = new Set([norm(r.color), norm(r.productName)]);
    for (const c of colors) {
      if (!ck || !c) continue;
      const key = ck + '|' + c;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
  }

  const blanks = await pool.query(`
    SELECT s.id, s.internal_sku, s.status, p.name AS product_name
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440008'
      AND s.vendor_sku IS NOT NULL AND length(trim(s.vendor_sku)) < 4
  `);
  console.log(`blank vendor_sku rows: ${blanks.rows.length}`);

  // Existing vendor_skus — never backfill an item number some SKU already has
  const taken = new Set((await pool.query(`
    SELECT upper(vendor_sku) AS v FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = '550e8400-e29b-41d4-a716-446655440008'
  `)).rows.map(r => r.v));

  let matched = 0, ambiguous = 0, unmatchedCt = 0, applied = 0;
  const proposals = [];
  for (const s of blanks.rows) {
    const m = (s.internal_sku || '').match(/^TW-PROV-(.+)$/i);
    if (!m) { unmatchedCt++; continue; }
    const slug = m[1]; // "<collection>-<color>", both kebab-case
    const productKey = norm(s.product_name);           // e.g. VITALIELITE
    const slugNorm = norm(slug.replace(/-/g, ' '));    // e.g. VITALIELITECARRARA
    // color = slug minus the product-name prefix
    const colorKey = slugNorm.startsWith(productKey) ? slugNorm.slice(productKey.length) : null;
    if (!colorKey) { unmatchedCt++; console.log(`  ? slug/product mismatch: ${s.internal_sku} (product "${s.product_name}")`); continue; }

    const cands = (byKey.get(productKey + '|' + colorKey) || [])
      .filter(r => !taken.has(r.itemNumber.toUpperCase()));
    const uniqueItems = [...new Set(cands.map(r => r.itemNumber.toUpperCase()))];
    if (uniqueItems.length === 1) {
      matched++;
      proposals.push({ id: s.id, internal_sku: s.internal_sku, itemNumber: uniqueItems[0], qty: cands[0].quantity + ' ' + cands[0].unit });
    } else if (uniqueItems.length > 1) {
      ambiguous++;
      console.log(`  ~ AMBIGUOUS ${s.internal_sku} → ${uniqueItems.join(', ')}`);
    } else {
      unmatchedCt++;
    }
  }

  console.log(`\nmatched: ${matched}, ambiguous: ${ambiguous}, no portal row: ${unmatchedCt}\n`);
  for (const p of proposals) console.log(`  ${p.itemNumber}  ←  ${p.internal_sku}  (stock: ${p.qty})`);

  if (APPLY) {
    for (const p of proposals) {
      await pool.query(`UPDATE skus SET vendor_sku = $1 WHERE id = $2`, [p.itemNumber, p.id]);
      applied++;
    }
    console.log(`\nAPPLIED ${applied} vendor_sku backfills`);
  } else {
    console.log('\nDry run — re-run with --apply to write');
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
