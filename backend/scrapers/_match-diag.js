/**
 * Offline matching diagnostics: replay the daltile-inventory crosswalk against
 * /app/data/daltile-instock.json and explain every unmatched/ambiguous item.
 */
import fs from 'fs';
import pg from 'pg';

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const first = (v) => Array.isArray(v) ? v[0] : v;
const finishCompatible = (a, b) => a === b || (a && b && (a.startsWith(b) || b.startsWith(a)));
const lcSubstr = (a, b) => {
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    prev = cur;
  }
  return best;
};
const lcsLen = (a, b) => {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
};

async function main() {
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  const items = JSON.parse(fs.readFileSync('/app/data/daltile-instock.json'));

  const all = await pool.query(`
    SELECT s.id, s.vendor_sku, s.status AS sku_status, p.status AS product_status, p.collection, pr.cost, s.variant_type, p.name AS product_name,
           MAX(CASE WHEN a.name = 'Size' THEN sa.value END) AS size,
           MAX(CASE WHEN a.name = 'Finish' THEN sa.value END) AS finish,
           MAX(CASE WHEN a.name = 'Shape' THEN sa.value END) AS shape,
           MAX(CASE WHEN a.name = 'Color' THEN sa.value END) AS color
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id AND a.name IN ('Size', 'Finish', 'Shape', 'Color')
    WHERE v.code IN ('DAL', 'AO', 'MZ') AND s.vendor_sku IS NOT NULL
    GROUP BY s.id, s.vendor_sku, s.status, p.status, p.collection, pr.cost, s.variant_type, p.name
  `);
  const active = all.rows.filter(r => r.product_status === 'active' && r.sku_status === 'active');
  const exactMap = new Map();
  for (const r of all.rows) exactMap.set(r.vendor_sku.toUpperCase(), r);

  const stats = { exact: 0, exactActive: 0, crosswalked: 0, ambiguous: 0, unmatched: 0 };
  const unmatched = [];
  const ambiguous = [];

  for (const item of items) {
    const rawSku = (item.sku || '').toUpperCase();
    const exact = exactMap.get(rawSku);
    if (exact) { stats.exact++; if (exact.product_status === 'active' && exact.sku_status === 'active') stats.exactActive++; }

    const colorCode = String(item.color || '').toUpperCase();
    const sizeKey = norm(first(item.nominalsize));
    const itemFinish = norm(first(item.finish));
    let candidates = active.filter(c => colorCode && c.vendor_sku.toUpperCase().startsWith(colorCode));
    const byPrefix = candidates.length;
    candidates = candidates.filter(c => norm(c.size) === sizeKey);
    const bySize = candidates.length;
    candidates = candidates.filter(c => finishCompatible(norm(c.finish), itemFinish));
    if (candidates.length > 1) {
      const s = candidates.filter(c => norm(c.collection) === norm(item.seriesname));
      if (s.length >= 1) candidates = s;
    }
    // Type alignment: field tile vs trim/accessory
    if (candidates.length > 1) {
      const portalIsTrim = /trim|installation/i.test(String(first(item.planproducttype) || ''));
      const isTrimCand = (c) => c.variant_type === 'accessory' || /trim/i.test(c.product_name || '');
      const aligned = candidates.filter(c => isTrimCand(c) === portalIsTrim);
      if (aligned.length >= 1 && aligned.length < candidates.length) { candidates = aligned; stats.typeAligned = (stats.typeAligned || 0) + 1; }
    }
    // Marker tokens: candidate variants flagged MB (Microban) / BV (bevel) must be
    // echoed by the portal sku/description, else dropped (and vice versa)
    if (candidates.length > 1) {
      const portalStr = (rawSku + ' ' + (item.skudescription || '')).toUpperCase();
      for (const [tok, re] of [['MB', /MICROBAN|MB/], ['BV', /BEV/]]) {
        const withTok = candidates.filter(c => c.vendor_sku.toUpperCase().slice(4).includes(tok));
        if (withTok.length > 0 && withTok.length < candidates.length) {
          const keep = re.test(portalStr) ? withTok : candidates.filter(c => !withTok.includes(c));
          if (keep.length >= 1) candidates = keep;
        }
      }
    }
    // Shape alignment (Hexagon vs Straight Joint etc.)
    if (candidates.length > 1) {
      const itemShape = norm(first(item.shapeandmosaic));
      if (itemShape) {
        const shaped = candidates.filter(c => norm(c.shape) && norm(c.shape) === itemShape);
        if (shaped.length >= 1 && shaped.length < candidates.length) { candidates = shaped; stats.shapeAligned = (stats.shapeAligned || 0) + 1; }
      }
    }
    // Contiguous substring (color prefix stripped): trim codes share literal tokens
    if (candidates.length > 1) {
      const colorLen = colorCode.length;
      const rem = norm(rawSku.slice(colorLen));
      const scored = candidates.map(c => ({ c, score: lcSubstr(rem, norm(c.vendor_sku.slice(colorLen))) }));
      const best = Math.max(...scored.map(x => x.score));
      const winners = scored.filter(x => x.score === best);
      if (winners.length === 1) { candidates = [winners[0].c]; stats.substrResolved = (stats.substrResolved || 0) + 1; }
    }
    if (candidates.length > 1 && item.classprices > 0) {
      const withDiff = candidates.map(c => ({ c, diff: c.cost > 0 ? Math.abs(parseFloat(c.cost) - item.classprices) / item.classprices : Infinity }));
      const close = withDiff.filter(x => x.diff < 0.03);
      if (close.length === 1) { candidates = [close[0].c]; stats.priceResolved = (stats.priceResolved || 0) + 1; }
    }
    if (candidates.length > 1) {
      const scored = candidates.map(c => ({ c, score: lcsLen(rawSku, c.vendor_sku.toUpperCase()) }));
      const best = Math.max(...scored.map(x => x.score));
      const winners = scored.filter(x => x.score === best);
      if (winners.length === 1) candidates = [winners[0].c];
    }

    if (candidates.length === 1) { if (!exact || candidates[0].id !== exact.id) stats.crosswalked++; }
    else if (candidates.length > 1) {
      stats.ambiguous++;
      ambiguous.push({
        sku: item.sku, size: first(item.nominalsize), finish: first(item.finish),
        shape: first(item.shapeandmosaic), series: item.seriesname,
        classprices: item.classprices, cands: candidates.map(c => `${c.vendor_sku}[$${c.cost}]`),
      });
    } else if (!exact) {
      stats.unmatched++;
      // Explain: how far did the funnel get?
      const prefixSizes = [...new Set(active.filter(c => colorCode && c.vendor_sku.toUpperCase().startsWith(colorCode)).map(c => c.size))].slice(0, 8);
      unmatched.push({
        sku: item.sku, qty: item.inventoryitems, uom: item.uom,
        color: item.color, size: first(item.nominalsize), finish: first(item.finish),
        series: item.seriesname, type: first(item.planproducttype),
        byPrefix, bySize, activeSizesForColor: prefixSizes,
      });
    }
  }

  console.log('BASELINE:', JSON.stringify(stats));
  console.log('\n=== UNMATCHED with active same-color candidates (normalization gaps) ===');
  for (const u of unmatched.filter(u => u.byPrefix > 0).slice(0, 30)) {
    console.log(` ${u.sku} | size=${u.size} finish=${u.finish} | prefix-cands=${u.byPrefix} size-cands=${u.bySize} | active sizes for ${u.color}: ${u.activeSizesForColor.join(', ')}`);
  }
  console.log('\n=== UNMATCHED with NO active same-color SKU (not in catalog) ===');
  const noCat = unmatched.filter(u => u.byPrefix === 0);
  console.log(`count: ${noCat.length}`);
  const byType = {};
  for (const u of noCat) byType[u.type || '?'] = (byType[u.type || '?'] || 0) + 1;
  console.log('by product type:', JSON.stringify(byType));
  console.log('\n=== AMBIGUOUS (first 20) ===');
  for (const a of ambiguous.slice(0, 20)) {
    console.log(` ${a.sku} [$${a.classprices}] → ${a.cands.join(' | ')}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
