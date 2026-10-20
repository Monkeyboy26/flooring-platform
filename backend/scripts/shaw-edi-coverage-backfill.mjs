/**
 * shaw-edi-coverage-backfill.mjs — fill carton coverage for the SHAW SKUs flagged
 * missing-box-packaging / wood-vinyl-not-box. The Shaw Data API (GetProducts)
 * carries areaPerCarton/piecesPerCarton per style; our DB SKUs key by
 * "<style> <color>" (LVP) or the product name (carpet), so we match by style
 * number. READ-ONLY against the API; writes ONLY the flagged SKUs' packaging
 * (+ price_basis=per_sqft for box LVP that lacks it). Backup before --apply.
 *
 *   docker exec -e DB_HOST=db flooring-api node scripts/shaw-edi-coverage-backfill.mjs [--apply]
 */
import pg from 'pg';
import { upsertPackaging } from '../scrapers/base.js';

const APPLY = process.argv.includes('--apply');
const DEFAULT_API_URL = 'https://DigitalServiceAPI.shawinc.com/ProductAPI/api/v1/Retailer/GetProducts';
const { Pool } = pg;
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flooring_pim',
});

const SHAW = '4da72c7d-2f82-458b-aec5-5ec0ba8a554c';
const safeNum = v => { if (v == null) return null; const n = typeof v === 'object' ? (v.originalValue ?? v.value ?? null) : v; const p = parseFloat(n); return isNaN(p) ? null : p; };
const imperialValue = m => { if (!m) return null; const imp = m.imperial || m; return safeNum(imp?.originalValue ?? imp?.value ?? null); };
const styleOf = (vsku, name) => {
  if (/\s/.test(vsku)) return vsku.split(/\s+/)[0].toUpperCase();
  const m = (name || '').match(/([0-9]{3,6}[A-Z]?)\s*$/i);
  return (m ? m[1] : vsku).toUpperCase();
};

// API credentials from the data-api vendor source config
const { rows: srcRows } = await pool.query(
  `SELECT config FROM vendor_sources WHERE vendor_id=$1 AND config ? 'gateway_key' LIMIT 1`, [SHAW]);
const cfg = srcRows[0]?.config || {};
const headers = {
  'ocp-apim-subscription-key': cfg.gateway_key,
  'api-Key': cfg.dealer_key,
  'Accept-Encoding': 'gzip, deflate, br',
  'Content-Type': 'application/json',
};

// Targets: exactly the SKUs the conformance audit flagged as missing coverage.
const { rows: targets } = await pool.query(`
  SELECT DISTINCT s.id AS sku_id, s.vendor_sku, p.name, s.variant_name, pr.price_basis
  FROM quality_violations qv
  JOIN skus s ON s.id=qv.sku_id
  JOIN products p ON p.id=s.product_id
  JOIN vendors v ON v.id=p.vendor_id AND v.code='SHAW'
  LEFT JOIN pricing pr ON pr.sku_id=s.id
  WHERE qv.status='open' AND qv.rule_key IN ('missing-box-packaging','wood-vinyl-not-box')
  ORDER BY p.name`);
console.log(`targets: ${targets.length}`);
const wantStyles = new Set(targets.map(t => styleOf(t.vendor_sku, t.name)));
console.log(`styles needed: ${[...wantStyles].join(', ')}`);

// one page with retry on transient "terminated"/timeout/429 (big payloads drop mid-stream)
async function fetchPage(pagingId) {
  const waits = [3, 8, 20, 40];
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await fetch(DEFAULT_API_URL, { method: 'POST', headers,
        body: JSON.stringify({ ProductType: 'All', PagingId: pagingId || '' }),
        signal: AbortSignal.timeout(120000) });
      if (resp.status === 429) throw new Error('429');
      if (!resp.ok) { const b = await resp.text().catch(()=>''); throw new Error(`API ${resp.status}: ${b.slice(0,200)}`); }
      return await resp.json();
    } catch (e) {
      const transient = /terminated|socket|econnreset|etimedout|timeout|aborted|429|other side closed|fetch failed/i.test(e.message);
      if (transient && attempt < waits.length) { await new Promise(r=>setTimeout(r, waits[attempt]*1000)); continue; }
      throw e;
    }
  }
}

// Fetch catalog (read-only), build style -> coverage
const styleCov = new Map();
let pagingId = '', page = 0;
while (page < 25) {
  page++;
  const data = await fetchPage(pagingId);
  for (const st of (data.retailerStylesDetail || [])) {
    const key = (st.sellingStyleNumber || '').trim().toUpperCase();
    if (!key) continue;
    const area = imperialValue(st.areaPerCarton);
    if (area && !styleCov.has(key)) styleCov.set(key, { area, pieces: safeNum(st.piecesPerCarton) });
  }
  process.stderr.write(`page ${page}: styles so far w/ coverage ${styleCov.size}\r`);
  pagingId = data.pagingId || null;
  if (!pagingId) break;
}
console.error(`\nfetched; ${styleCov.size} styles have areaPerCarton`);

let applied = 0; const miss = [];
for (const t of targets) {
  const style = styleOf(t.vendor_sku, t.name);
  const cov = styleCov.get(style);
  if (!cov) { miss.push(`${t.vendor_sku} (${t.name}) style=${style}`); continue; }
  console.log(`✓ ${t.vendor_sku}  ${t.name} — ${t.variant_name||''}  style=${style} → sqft/box=${cov.area} pcs=${cov.pieces}`);
  if (APPLY) {
    await upsertPackaging(pool, t.sku_id, { sqft_per_box: cov.area, pieces_per_box: cov.pieces });
    if (!t.price_basis) await pool.query(`UPDATE pricing SET price_basis='per_sqft' WHERE sku_id=$1`, [t.sku_id]);
    applied++;
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}: matched ${targets.length - miss.length}/${targets.length} (applied ${applied}).`);
if (miss.length) { console.log('unmatched (not in API catalog):'); miss.forEach(m => console.log('   · ' + m)); }
await pool.end();
