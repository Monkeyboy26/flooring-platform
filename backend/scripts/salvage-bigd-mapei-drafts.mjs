// One-time salvage of the 848 orphaned "Mapei Corporation <color> <sku>" Big D
// draft products — stale June-2026 residue from the old Daltile EDI feed, left
// behind when Mapei moved to Big D. Never sold, mostly imageless, uncurated.
//
// Decision (owner, 2026-08-30): SALVAGE the ones we can reconstruct from local
// Mapei data, DISCONTINUE the rest.
//   - Matched (Lowe's catalog model/family/name OR Big D sheet code) → rename to
//     "Mapei <cleanDesc>", categorize via the central classifier, keep as draft.
//   - Unmatched → status='discontinued' (soft; reversible, unlike delete).
//
// Scope is strict: only BIGD products with status='draft' AND name ILIKE
// 'Mapei Corporation%'. The 139 curated ACTIVE Mapei products are never touched.
// Pricing is left as-is (these already carry Big D costs) — this is a
// name+category+status cleanup, not a reprice.
//
// The matching/naming helpers below mirror scrapers/mapei-unified.js (the
// designed Mapei pipeline). We don't run that wholesale because it also reprices
// the curated actives and does network image work — out of scope here.
//
//   node scripts/salvage-bigd-mapei-drafts.mjs            # dry-run (default)
//   node scripts/salvage-bigd-mapei-drafts.mjs --apply

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import { classifyName } from '../lib/categoryClassifier.js';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

// ── helpers mirrored from mapei-unified.js (pure) ───────────────────────────
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function alnumParts(code) {
  const m = /^([0-9])([A-Z]{2})(\d{4})(\d{2})$/.exec(code);
  if (!m) return null;
  let color = m[3]; if (color.startsWith('0')) color = '5' + color.slice(1);
  return { fam: `${m[1]}${m[2]}-${m[4]}`, color };
}
function normalizeCode(code) {
  const c = code.toUpperCase();
  const m = /^([0-9])([A-Z]{2})(\d{4})(\d{2})$/.exec(c);
  if (m && m[3].startsWith('0')) return `${m[1]}${m[2]}5${m[3].slice(1)}${m[4]}`;
  return c;
}
const CODE_RE = /\b([0-9][A-Z]{2}\d{6}|\d{5,8}(?:USA)?)\b/g;
function extractCodes(...texts) {
  const out = [];
  for (const t of texts) { if (!t) continue; const up = t.toUpperCase(); let m; CODE_RE.lastIndex = 0; while ((m = CODE_RE.exec(up)) !== null) out.push(m[1]); }
  return out;
}
function cleanDesc(desc) {
  const unitWord = (u) => /pound/i.test(u) ? 'lb' : /gal/i.test(u) ? 'Gal' : /quart/i.test(u) ? 'Qt' : 'fl oz';
  return desc
    .replace(/\(\s*(\d+(?:\.\d+)?)\s*(?:-\s*)?(Pound\(s\)|Gallons?|Quarts?|Fluid ounce\(s\))\s*\)/gi, (_, n, u) => `(${n} ${unitWord(u)})`)
    .replace(/(\d+(?:\.\d+)?)\s*(Pound\(s\)|Gallon\(s\)|Quart\(s\)|Fluid ounce\(s\))/gi, (_, n, u) => `${n} ${unitWord(u)}`)
    .replace(/\s+/g, ' ').trim();
}
// Tidy a raw Big D sheet desc (ALL CAPS, brand mid-string) into a title.
function titleFromSheet(desc) {
  let d = cleanDesc(desc).replace(/\bMAPEI\b/i, '').replace(/\s+/g, ' ').trim();
  d = d.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return d;
}

// ── load Lowe's catalog + Big D sheet ───────────────────────────────────────
const lowes = JSON.parse(fs.readFileSync(path.join(dataDir, 'lowes-mapei-catalog.json'), 'utf8'));
const byModel = new Map(), byFamily = new Map(), byName = new Map();
for (const it of lowes) {
  byModel.set(String(it.model).toUpperCase(), it);
  byName.set(('mapei ' + cleanDesc(it.desc)).toLowerCase(), it);
  const p = alnumParts(String(it.model).toUpperCase());
  if (p) { if (!byFamily.has(p.fam)) byFamily.set(p.fam, []); byFamily.get(p.fam).push(it); }
}
const sheetRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'bigd-mapei-pricesheet.json'), 'utf8'));
const sheetItems = sheetRaw.items || Object.values(sheetRaw).find(Array.isArray);
const sheetByCode = new Map(), sheetByPrefix = new Map();
for (const it of sheetItems) {
  if (!it.code) continue;
  const code = String(it.code).toUpperCase().replace(/USA?$/, '');
  if (code.includes('XXX')) continue;
  sheetByCode.set(code, it);
  const pm = /^(\d{5})\d{2}$/.exec(code);
  if (pm && !sheetByPrefix.has(pm[1])) sheetByPrefix.set(pm[1], it);
}

// Match one draft's codes → a source item with a usable desc, EXACT matches only.
// Family/prefix tiers are deliberately excluded: they return a representative
// sibling (one color of a line), which would mislabel a different-color draft
// and collapse several drafts to one duplicate name. For a draft with no exact
// source, a wrong name is worse than discontinuing — so it gets discontinued.
// Returns { desc, via } or null.
function matchDesc(codes) {
  for (const c of codes) { const it = byModel.get(normalizeCode(c)) || byModel.get(c); if (it) return { desc: cleanDesc(it.desc), via: 'lowes-model' }; }
  for (const c of codes) {
    const code = normalizeCode(c).replace(/USA?$/, '');
    if (sheetByCode.has(code)) return { desc: titleFromSheet(sheetByCode.get(code).desc), via: 'sheet-code' };
  }
  return null;
}

// ── scan the broken drafts ──────────────────────────────────────────────────
const { rows } = await pool.query(`
  SELECT p.id AS product_id, p.name, p.category_id,
         array_agg(s.vendor_sku) AS skus, array_agg(s.variant_name) AS variants
  FROM products p JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN skus s ON s.product_id = p.id
  WHERE v.code = 'BIGD' AND p.status = 'draft' AND p.name ILIKE 'Mapei Corporation%'
  GROUP BY p.id, p.name, p.category_id
`);

const salvage = [];    // { product_id, newName, catSlug, via, needsReview }
const discontinue = []; // product_id
for (const r of rows) {
  const codes = extractCodes(...(r.skus || []), ...(r.variants || []), r.name);
  const hit = matchDesc(codes);
  if (hit && hit.desc) {
    const newName = ('Mapei ' + hit.desc).replace(/\s+/g, ' ').trim();
    const kw = classifyName(newName, null);
    const catSlug = kw || 'adhesives-sealants'; // Mapei setting materials default
    salvage.push({ product_id: r.product_id, newName, catSlug, via: hit.via, needsReview: !kw });
  } else {
    discontinue.push(r.product_id);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`Broken Mapei drafts scanned: ${rows.length}`);
console.log(`  SALVAGE (rename + categorize): ${salvage.length}`);
const byVia = {}, byCat = {};
for (const s of salvage) { byVia[s.via] = (byVia[s.via] || 0) + 1; byCat[s.catSlug] = (byCat[s.catSlug] || 0) + 1; }
console.log('    by match:', Object.entries(byVia).map(([k, n]) => `${k}:${n}`).join(', '));
console.log('    by category:', Object.entries(byCat).map(([k, n]) => `${k}:${n}`).join(', '));
console.log('    e.g. ' + salvage.slice(0, 8).map(s => `[${s.catSlug}] "${s.newName.slice(0, 48)}"`).join('\n         '));
console.log(`  DISCONTINUE (no source data): ${discontinue.length}`);

if (!APPLY) { console.log('\nDRY-RUN — no changes written. Re-run with --apply.'); await pool.end(); process.exit(0); }

// ── apply ─────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupIds = [...salvage.map(s => s.product_id), ...discontinue];
const backup = (await pool.query(
  `SELECT id AS product_id, name, status, category_id, category_needs_review FROM products WHERE id = ANY($1::uuid[])`,
  [backupIds]
)).rows;
const backupFile = path.join(dataDir, `bigd-mapei-salvage-backup-${ts}.json`);
fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
console.log(`\nBackup written: ${backupFile} (${backup.length} rows)`);

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const s of salvage) {
    await client.query(
      `UPDATE products SET name = $2,
              category_id = (SELECT id FROM categories WHERE slug = $3),
              category_needs_review = $4, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [s.product_id, s.newName, s.catSlug, s.needsReview]
    );
  }
  if (discontinue.length) {
    await client.query(
      `UPDATE products SET status = 'discontinued', category_needs_review = false, updated_at = CURRENT_TIMESTAMP
       WHERE id = ANY($1::uuid[])`,
      [discontinue]
    );
  }
  await client.query('COMMIT');
  console.log(`Applied: ${salvage.length} salvaged (renamed+categorized), ${discontinue.length} discontinued.`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('ROLLBACK —', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
