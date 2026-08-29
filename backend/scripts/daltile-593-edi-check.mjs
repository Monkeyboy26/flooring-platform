/**
 * daltile-593-edi-check.mjs  (READ-ONLY diagnostic)
 *
 * Question: do the 593 unpriced/unmapped active Daltile SKUs have a corresponding
 * priced item in the CURRENT 832 EDI feed? i.e. are they fixable by growing the
 * crosswalk (daltile_edi_map), or genuinely absent from EDI (must be gated)?
 *
 * Pulls the live (non-archive) 832 feed, indexes every PRICED EDI item, then
 * classifies each unpriced live SKU into:
 *   EXACT   - its exact vendor_sku is a priced EDI code
 *   ATTR    - matches a priced EDI item via the crosswalk's LVP/mosaic attribute key
 *   FAMILY  - a priced EDI item shares its line+color stem (line/color present in feed,
 *             size/finish/shape disambiguation needed to map)
 *   ABSENT  - no priced EDI item shares even the line+color stem (not in current EDI)
 *
 * Writes the full classification to data/daltile/edi-593-check.json. No DB writes.
 */
import fs from 'fs';
import { pool } from '../db.js';
import { createFtpConnection } from '../services/ediFtp.js';
import { __test__, findRemote832Files } from '../scrapers/daltile-832.js';
const { parse832 } = __test__;
const DAL = '550e8400-e29b-41d4-a716-446655440003';

// ── line+color stem: leading letters + first 2-3 digits (AM30, TP05, G516, D317, EX31) ──
const stem = (code) => { const m = (code || '').toUpperCase().match(/^([A-Z]{1,3}\d{2,3})/); return m ? m[1] : null; };

// ── reuse crosswalk attribute keys (LVP planks + D### mosaics) ──
function ediLvpKey(it) {
  const name = (it.product_name || '').toLowerCase();
  if (!/plank/.test(name) || (it.unit_of_measure || '').toUpperCase() !== 'SF') return null;
  const pc = (it.vendor_sku || '').match(/^([A-Z]{2})(\d\d)/); const mil = name.match(/(\d+)\s*mil/);
  return pc && mil ? `${pc[1]}|${pc[2]}|${mil[1]}` : null;
}
function liveLvpKey(sku) {
  const s = (sku || '').toUpperCase(); const pc = s.match(/^([A-Z]{2})(\d\d)/); const mil = s.match(/M(\d+)L/);
  return pc && mil ? `${pc[1]}|${pc[2]}|${mil[1]}` : null;
}
function ediMosaicKey(it) {
  const code = (it.vendor_sku || '').toUpperCase(); const name = (it.product_name || '').toLowerCase();
  if ((it.unit_of_measure || '').toUpperCase() !== 'SF') return null;
  const cc = code.match(/^D(\d{3})/); if (!cc) return null;
  const shape = /penny/.test(name) ? 'penny' : /hexagon|hex/.test(name) ? 'hex' : /straight joint/.test(name) ? 'stj' : null;
  if (!shape) return null;
  const offset = /HEXOR|ORHEX|\bOR\b/.test(code) ? 'o' : '';
  const finish = /MS1A|abrasive|\bab\b/i.test(code + ' ' + name) ? 'ab' : /TXMS|textured|\btx\b/i.test(code + ' ' + name) ? 'tx' : 'mt';
  let size = '';
  if (shape === 'stj') { const m = code.match(/^D\d{3}(\d\d)/); size = m ? m[1] : ''; }
  else if (shape === 'hex') { const m = code.match(/(\d)HEX/); size = m ? m[1] : '1'; }
  return `${cc[1]}|${shape}|${size}|${finish}|${offset}`;
}
function liveMosaicKey(sku) {
  const code = (sku || '').toUpperCase(); const cc = code.match(/^D(\d{3})/); if (!cc) return null;
  const shape = /PENNY|PNY/.test(code) ? 'penny' : /HEX/.test(code) ? 'hex' : /STJ/.test(code) ? 'stj' : null;
  if (!shape) return null;
  const offset = /OR/.test(code.replace(/^D\d{3}/, '')) ? 'o' : '';
  const finish = /AB$|AB[A-Z]/.test(code) ? 'ab' : /TX$|TX[A-Z]/.test(code) ? 'tx' : 'mt';
  let size = '';
  if (shape === 'stj') { const m = code.match(/STJ(\d\d)/); size = m ? m[1] : ''; }
  else if (shape === 'hex') { const m = code.match(/HEX(\d\d?)/); size = m ? (m[1] === '22' ? '2' : m[1] === '11' ? '1' : m[1]) : '1'; }
  return `${cc[1]}|${shape}|${size}|${finish}|${offset}`;
}

async function fetchEdiItems(ediConfig) {
  const ftp = await createFtpConnection(ediConfig);
  try {
    const files = (await findRemote832Files(ftp)).filter(f => !/archive/i.test(f.remotePath));
    const items = [];
    for (const f of files) {
      const local = '/tmp/dal593-' + f.name;
      await ftp.downloadTo(local, f.remotePath);
      try { items.push(...parse832(fs.readFileSync(local, 'utf-8')).items); } catch (e) { console.error('parse fail', f.name, e.message); }
      try { fs.unlinkSync(local); } catch {}
    }
    console.log(`feed files: ${files.length}`);
    return items;
  } finally { try { ftp.close(); } catch {} }
}

const cfg = (await pool.query(`SELECT edi_config FROM vendors WHERE id=$1`, [DAL])).rows[0].edi_config;
const items = await fetchEdiItems(cfg);
const priced = items.filter(it => it.vendor_sku && it.cost != null && it.cost > 0);
console.log(`parsed ${items.length} EDI items | ${priced.length} priced`);

const exact = new Set(priced.map(it => it.vendor_sku.toUpperCase()));
const stemSet = new Set(priced.map(it => stem(it.vendor_sku)).filter(Boolean));
const lvpIdx = new Set(priced.map(ediLvpKey).filter(Boolean));
const mosIdx = new Set(priced.map(ediMosaicKey).filter(Boolean));

const live = (await pool.query(`
  SELECT s.id sku_id, s.vendor_sku, p.name, p.collection, c.name AS category
  FROM products p JOIN skus s ON s.product_id=p.id
  LEFT JOIN pricing pr ON pr.sku_id=s.id LEFT JOIN categories c ON c.id=p.category_id
  WHERE p.vendor_id=$1 AND s.status='active' AND pr.retail_price IS NULL
  ORDER BY c.name, p.collection, s.vendor_sku`, [DAL])).rows;

const out = [];
for (const r of live) {
  const code = (r.vendor_sku || '').toUpperCase();
  let cls;
  if (exact.has(code)) cls = 'EXACT';
  else if ((liveLvpKey(code) && lvpIdx.has(liveLvpKey(code))) || (liveMosaicKey(code) && mosIdx.has(liveMosaicKey(code)))) cls = 'ATTR';
  else if (stem(code) && stemSet.has(stem(code))) cls = 'FAMILY';
  else cls = 'ABSENT';
  out.push({ ...r, stem: stem(code), cls });
}

const by = (key) => out.reduce((m, r) => ((m[r[key]] = (m[r[key]] || 0) + 1), m), {});
console.log('\n=== classification (of ' + out.length + ') ===');
console.log(by('cls'));

console.log('\n=== by category × class ===');
const cats = [...new Set(out.map(r => r.category))];
console.log(['category'.padEnd(24), 'EXACT', 'ATTR', 'FAMILY', 'ABSENT'].join('\t'));
for (const cat of cats) {
  const rows = out.filter(r => r.category === cat);
  const c = (k) => rows.filter(r => r.cls === k).length;
  console.log([(cat || 'NULL').padEnd(24), c('EXACT'), c('ATTR'), c('FAMILY'), c('ABSENT')].join('\t'));
}

console.log('\n=== sample FAMILY (line+color in feed, mappable) ===');
out.filter(r => r.cls === 'FAMILY').slice(0, 12).forEach(r => console.log('  ', r.vendor_sku, '| stem', r.stem, '|', r.category, '|', r.collection));
console.log('\n=== sample ABSENT (not in current EDI) ===');
out.filter(r => r.cls === 'ABSENT').slice(0, 12).forEach(r => console.log('  ', r.vendor_sku, '| stem', r.stem, '|', r.category, '|', r.collection));

fs.mkdirSync('data/daltile', { recursive: true });
fs.writeFileSync('data/daltile/edi-593-check.json', JSON.stringify({ generatedFrom: 'live 832 feed', pricedEdiItems: priced.length, classification: by('cls'), rows: out }, null, 1));
console.log('\nWrote data/daltile/edi-593-check.json');
await pool.end();
