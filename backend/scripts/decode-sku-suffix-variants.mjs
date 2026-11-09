// Decode (SKU)-suffixed variant names into real differentiators.
//
// The nightly variant deduper (quality/variantDedupe.js) appends "(vendor_sku)"
// to colliding sibling SKUs when no attribute splits the group — customers then
// see "Quarter Round 84\", (423113)" vs "(423114)" with no way to tell them
// apart. This pass decodes the vendor SKU against each vendor's authoritative
// source and rewrites the name with the human differentiator instead:
//
//   MANN  trim catalog number → parent color via the Nov-2026 pricelist JSON
//         (backend/data/mannington/mannington-pricelist-2026-11-06.json)
//   EF    final "-X" segment → carpet/LVT backing (BACK_TO_CODE in
//         scripts/import-ef-pricelist.cjs; ACTION vs ILOC etc.)
//   HR    trailing finish code (PC/SN/DBAC/…) → finish name, learned from the
//         vendor's own ROM440 CSVs ("Finish: X" rows; >=5 votes, >=90% agree)
//   DAL   design/texture token parsed from the Coveo productImageUrl in
//         backend/data/daltile-product-map.json, falling back to a static
//         trim-code map (QCL/QCR, DHB/SHB, HEX/STJ, LNR)
//
// New names APPEND to the stripped base ("base, Decoded") so the scraper
// upsert's prefix-preserve rule (base.js, `skus.variant_name ILIKE
// EXCLUDED.variant_name || ',%'`) keeps them across re-scrapes. The "(SKU)"
// suffix is dropped only when the decoded group is fully unique; members that
// still collide keep their original name.
//
// Dry-run by default. --apply writes (with JSON backup in backend/data/),
// --vendor=MANN,EF scopes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

const APPLY = process.argv.includes('--apply');
const vendorArg = process.argv.find(a => a.startsWith('--vendor='));
const ONLY = vendorArg ? vendorArg.split('=')[1].split(',').map(s => s.trim().toUpperCase()) : null;
const replayArg = process.argv.find(a => a.startsWith('--replay='));

const MAX_LEN = 120;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function stripSkuSuffix(name, vendorSku) {
  return (name || '')
    .replace(new RegExp(`[,\\s]*\\(${esc(vendorSku)}\\)`, 'i'), '')
    .replace(/[,\s]+$/, '')
    .trim();
}

// All active SKUs whose variant_name embeds the vendor_sku, grouped by
// (product, base name) — only groups where the SKU is the sole differentiator.
async function dupGroups(vendorCode) {
  const { rows } = await pool.query(`
    SELECT s.id AS sku_id, s.product_id, s.vendor_sku, s.variant_name,
           p.name AS product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = $1 AND s.status = 'active' AND p.is_active = true
      AND s.variant_name IS NOT NULL AND length(s.vendor_sku) >= 4
      AND s.variant_name ILIKE '%' || s.vendor_sku || '%'`, [vendorCode]);
  const groups = new Map();
  for (const r of rows) {
    r.base = stripSkuSuffix(r.variant_name, r.vendor_sku);
    const key = `${r.product_id}|${r.base.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

// ──────────────────────────────────────────────
// MANN — trim catalog → parent color(s) from pricelist JSON
// ──────────────────────────────────────────────
async function decodeMann(groups) {
  const plPath = path.join(DATA, 'mannington', 'mannington-pricelist-2026-11-06.json');
  const pl = JSON.parse(fs.readFileSync(plPath, 'utf8'));
  const fields = Array.isArray(pl) ? pl : pl.fields;
  const trimToCodes = new Map(); // catalog → Set(color_code)
  for (const f of fields) {
    for (const t of f.trims || []) {
      const cat = String(t.catalog || '').trim();
      if (!cat) continue;
      if (!trimToCodes.has(cat)) trimToCodes.set(cat, new Set());
      trimToCodes.get(cat).add(f.color_code);
    }
  }
  const allCodes = [...new Set([...trimToCodes.values()].flatMap(s => [...s]))];
  const { rows } = await pool.query(`
    SELECT s.vendor_sku, s.variant_name
    FROM skus s JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'MANN' AND s.vendor_sku = ANY($1)`, [allCodes]);
  const codeToColor = new Map();
  for (const r of rows) {
    const color = (r.variant_name || '').split(',')[0].trim();
    if (color) codeToColor.set(r.vendor_sku, color);
  }

  const decoded = new Map(); // sku_id → segment
  for (const g of groups) {
    for (const m of g) {
      const codes = trimToCodes.get(m.vendor_sku);
      if (!codes) continue;
      const colors = [...new Set([...codes].map(c => codeToColor.get(c)).filter(Boolean))];
      if (colors.length >= 1 && colors.length <= 3) decoded.set(m.sku_id, colors.join(' / '));
    }
  }
  return decoded;
}

// ──────────────────────────────────────────────
// EF — trailing backing code
// ──────────────────────────────────────────────
const EF_BACK = {
  A: 'Action Back', AB: 'Action Back', IL: 'I-LOC Back',
  FL: 'Floating', DB: 'Dry Back', LV: 'Lux Vinyl', NX: 'Nexus',
  '6M': 'Mod Tile', RF: 'Rigid Floor', RL: 'Rigid Long', '20': '20mil Flat',
  K: 'KangaHyde', K5: 'Direct 5', K6: 'Direct 6', HP: 'Premier Back Plus',
};
async function decodeEf(groups) {
  const decoded = new Map();
  for (const g of groups) {
    const segs = g.map(m => (m.vendor_sku.split('-').pop() || '').toUpperCase());
    if (new Set(segs).size !== g.length) continue;        // suffix must split the group
    if (!segs.every(s => EF_BACK[s])) continue;           // all suffixes known
    g.forEach((m, i) => decoded.set(m.sku_id, EF_BACK[segs[i]]));
  }
  return decoded;
}

// ──────────────────────────────────────────────
// HR — trailing finish code, learned from ROM440 CSVs
// ──────────────────────────────────────────────
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
const hrCode = (sku) => (sku.match(/(?:^|-|\d)([A-Z]{2,5})$/) || [])[1] || null;

function learnHrFinishMap() {
  const dir = path.join(DATA, 'ROM440');
  const votes = new Map(); // code → Map(finish → n)
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('price_list_') && f.endsWith('.csv'))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
    for (const line of lines.slice(1)) {
      const cols = parseCsvLine(line);
      if (cols.length < 4) continue;
      const sku = cols[0].trim(), desc = cols[3] || '';
      const fin = (desc.match(/Finish:\s*([^.]+?)\s*\.?\s*$/i) || [])[1];
      const code = hrCode(sku);
      if (!fin || !code) continue;
      if (!votes.has(code)) votes.set(code, new Map());
      const v = votes.get(code);
      v.set(fin.trim(), (v.get(fin.trim()) || 0) + 1);
    }
  }
  const map = new Map();
  for (const [code, v] of votes) {
    const total = [...v.values()].reduce((a, b) => a + b, 0);
    const [topName, topN] = [...v.entries()].sort((a, b) => b[1] - a[1])[0];
    if (total >= 5 && topN / total >= 0.9) map.set(code, topName);
  }
  return map;
}
async function decodeHr(groups) {
  const finishMap = learnHrFinishMap();
  const decoded = new Map();
  for (const g of groups) {
    const codes = g.map(m => hrCode(m.vendor_sku));
    if (new Set(codes).size !== g.length) continue;
    if (!codes.every(c => c && finishMap.has(c))) continue;
    g.forEach((m, i) => decoded.set(m.sku_id, finishMap.get(codes[i])));
  }
  return decoded;
}

// ──────────────────────────────────────────────
// DAL — design token from Coveo image URL, else static trim-code map
// ──────────────────────────────────────────────
const DAL_CODE = {
  QCL: 'Quarter Round Corner Left', QCR: 'Quarter Round Corner Right',
  SCL: 'Cove Base Corner Left', SCR: 'Cove Base Corner Right',
  CL: 'Corner Left', CR: 'Corner Right',
  DHB: 'Double Hollywood Bevel', SHB: 'Single Hollywood Bevel',
  HEX: 'Hexagon', STJ: 'Straight Joint', LNR: 'Linear',
};
function imageBase(url) {
  if (!url) return null;
  const base = url.split('/').pop().split('?')[0]
    .replace(/\.(jpe?g|png|webp)$/i, '')
    .replace(/_\d+$/, '');                 // trailing shot number
  return base || null;
}
function loadDalImageMap() {
  const map = new Map();
  const pm = JSON.parse(fs.readFileSync(path.join(DATA, 'daltile-product-map.json'), 'utf8'));
  for (const series of Object.values(pm.series || {})) {
    for (const prod of Object.values(series.products || {})) {
      for (const sku of prod.skus || []) {
        if (sku.coveoSku && sku.productImageUrl) map.set(sku.coveoSku.toUpperCase(), sku.productImageUrl);
      }
    }
  }
  return map;
}
const titleCase = (s) => s.replace(/\w\S*/g, t => t[0].toUpperCase() + t.slice(1).toLowerCase());
function commonAffixStrip(strs) {
  // Returns the differing middle of each string after removing the longest
  // common prefix and suffix across the set, plus the shared suffix (a code
  // may bleed into it: DHB/SHB char-strip to D/S with "HB…" left in the
  // suffix, so code matching re-expands the mid against it).
  let pre = 0;
  while (strs.every(s => pre < s.length && s[pre] === strs[0][pre])) pre++;
  let suf = 0;
  while (strs.every(s => suf < s.length - pre && s[s.length - 1 - suf] === strs[0][strs[0].length - 1 - suf])) suf++;
  return { mids: strs.map(s => s.slice(pre, s.length - suf)), suffix: strs[0].slice(strs[0].length - suf) };
}
function dalCodeFor(mid, suffix) {
  if (!mid) return null;
  const expanded = mid + suffix;
  const keys = Object.keys(DAL_CODE).sort((a, b) => b.length - a.length);
  return keys.find(k => k.length >= mid.length && expanded.startsWith(k)) || null;
}
async function decodeDal(groups) {
  const imgMap = loadDalImageMap();
  const decoded = new Map();
  for (const g of groups) {
    // 1) image-URL token diff
    const bases = g.map(m => imageBase(imgMap.get(m.vendor_sku.toUpperCase())));
    if (bases.every(Boolean) && new Set(bases).size === g.length) {
      const tokenSets = bases.map(b => b.split(/[_-]+/).filter(Boolean));
      const shared = tokenSets.reduce((acc, ts) => acc.filter(t => ts.includes(t)));
      const uniques = tokenSets.map(ts => ts.filter(t => !shared.includes(t) && /^[A-Za-z]{2,}$/.test(t)));
      if (uniques.every(u => u.length === 1) &&
          new Set(uniques.map(u => u[0].toLowerCase())).size === g.length) {
        g.forEach((m, i) => decoded.set(m.sku_id, titleCase(uniques[i][0])));
        continue;
      }
    }
    // 2) static code map on the differing sku segment. An empty mid means
    //    "the plain base piece" (0Q42Q + '' vs 'CL'/'CR') — leave it undecoded;
    //    planGroup drops its (SKU) once the siblings are renamed away.
    const { mids, suffix } = commonAffixStrip(g.map(m => m.vendor_sku.toUpperCase()));
    if (new Set(mids).size !== g.length) continue;
    const codes = mids.map(mid => dalCodeFor(mid, suffix));
    if (mids.every((mid, i) => mid === '' || codes[i])) {
      g.forEach((m, i) => { if (codes[i]) decoded.set(m.sku_id, DAL_CODE[codes[i]]); });
    }
  }
  return decoded;
}

// ──────────────────────────────────────────────
// Driver
// ──────────────────────────────────────────────
const DECODERS = { MANN: decodeMann, EF: decodeEf, HR: decodeHr, DAL: decodeDal };

function planGroup(group, decoded) {
  // Build new names; only commit members whose decoded name is unique in-group.
  // Undecoded members propose their bare base — if renaming the siblings makes
  // that unique, the stale "(SKU)" suffix comes off too.
  const anyDecoded = group.some(m => decoded.has(m.sku_id));
  const proposals = new Map();
  for (const m of group) {
    const seg = decoded.get(m.sku_id);
    if (!seg) {
      proposals.set(m.sku_id, anyDecoded && m.base ? m.base : m.variant_name);
      continue;
    }
    if (m.base.toLowerCase().includes(seg.toLowerCase())) { proposals.set(m.sku_id, m.variant_name); continue; }
    const name = (m.base ? `${m.base}, ${seg}` : seg).slice(0, MAX_LEN);
    proposals.set(m.sku_id, name);
  }
  const counts = new Map();
  for (const name of proposals.values()) {
    const k = name.toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const out = [];
  for (const m of group) {
    const name = proposals.get(m.sku_id);
    if (name === m.variant_name) continue;
    if (counts.get(name.toLowerCase()) > 1) continue; // still colliding → keep (SKU)
    out.push({ sku_id: m.sku_id, vendor_sku: m.vendor_sku, product_name: m.product_name, from: m.variant_name, to: name });
  }
  return out;
}

// Replay a backup JSON from another environment (match on vendor code +
// vendor_sku; only touch rows whose current name still matches `from`).
// Usage: node scripts/decode-sku-suffix-variants.mjs --replay=<backup.json> [--apply]
async function replay(file) {
  const renames = JSON.parse(fs.readFileSync(file, 'utf8'));
  let applied = 0, skipped = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of renames) {
      const res = await client.query(`
        UPDATE skus s SET variant_name = $4, updated_at = NOW()
        FROM products p, vendors v
        WHERE p.id = s.product_id AND v.id = p.vendor_id
          AND v.code = $1 AND s.vendor_sku = $2 AND s.variant_name = $3`,
        [r.vendor, r.vendor_sku, r.from, r.to]);
      if (res.rowCount) applied += res.rowCount; else skipped++;
    }
    if (APPLY) { await client.query('COMMIT'); console.log(`Replayed ${applied} renames (${skipped} skipped: name drift or missing sku).`); }
    else { await client.query('ROLLBACK'); console.log(`Dry-run: ${applied} would apply, ${skipped} would skip. Re-run with --apply.`); }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  if (replayArg) { await replay(replayArg.split('=')[1]); await pool.end(); return; }
  const vendors = ONLY || Object.keys(DECODERS);
  const allRenames = [];
  for (const code of vendors) {
    const decoder = DECODERS[code];
    if (!decoder) { console.log(`No decoder for ${code}, skipping`); continue; }
    const groups = await dupGroups(code);
    const members = groups.reduce((a, g) => a + g.length, 0);
    const decoded = await decoder(groups);
    const renames = groups.flatMap(g => planGroup(g, decoded));
    console.log(`\n[${code}] ${groups.length} groups / ${members} skus — decoded ${decoded.size}, renaming ${renames.length}`);
    for (const r of renames.slice(0, 12)) {
      console.log(`  ${r.vendor_sku.padEnd(20)} ${r.product_name.slice(0, 38).padEnd(38)} "${r.from}" -> "${r.to}"`);
    }
    if (renames.length > 12) console.log(`  ... and ${renames.length - 12} more`);
    allRenames.push(...renames.map(r => ({ vendor: code, ...r })));
  }

  if (APPLY && allRenames.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(DATA, `decode-sku-suffix-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(allRenames, null, 1));
    console.log(`\nBackup: ${backupPath}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of allRenames) {
        await client.query(`UPDATE skus SET variant_name = $2, updated_at = NOW() WHERE id = $1`, [r.sku_id, r.to]);
      }
      await client.query('COMMIT');
      console.log(`Applied ${allRenames.length} renames.`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else if (!APPLY) {
    console.log(`\nDry-run. Total planned renames: ${allRenames.length}. Re-run with --apply to write.`);
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
