#!/usr/bin/env node
/**
 * emser-dedup-clean.mjs
 *
 * Cleans up the Emser catalog in two passes, non-destructively:
 *
 *  1. DEDUPE — Emser was re-scraped/re-imported under drifted vendor-SKU codes,
 *     fragmenting one physical tile into several product rows differentiated only
 *     by junk name suffixes ("9.4mm", "10.2mm", "Catx Dcs"). The drift is encoded
 *     in the vendor_sku two ways, both proven 100% consistent against a clean twin:
 *        • trailing  V2 / V3           ("F16PORTCH2424P" ← "F16PORTCH2424PV3")
 *        • injected  W after the code  ("F16PORTCH2424P" ← "F16PORTWCH2424P")
 *     Normalizing those away groups duplicate SKUs. We keep one canonical SKU per
 *     group (clean code + clean-named product + media + pricing) and, for any
 *     product whose *every* SKU is a duplicate of a canonical elsewhere,
 *     deactivate the product (status='inactive' — reversible; the
 *     cascade_product_deactivation trigger deactivates its SKUs). Products that
 *     still hold unique SKUs (mosaics, bullnose trims, true one-offs) are kept.
 *
 *  2. RENAME — on the surviving ACTIVE products, tidy the names:
 *        • strip "Catx"/"Dcs"  (junk DCOF/slip spec codes)
 *        • strip thickness "N.Nmm"  (owner: unnecessary) — but NOT on tools/
 *          accessories where mm is a real dimension (cutters, leveling clips…)
 *        • expand "Sbn" → "Single Bullnose"  (a real trim type, not junk)
 *        • reuse tidyEmserTileName()'s existing normalization
 *     If stripping thickness would collide with another surviving active product,
 *     the thickness is retained to disambiguate (and reported).
 *
 * 0 order/cart refs exist on any duplicate SKU (verified) so deactivation is safe.
 * A full backup of every change is written to backend/data/ before --apply.
 *
 * Usage:
 *   node backend/scripts/emser-dedup-clean.mjs            # dry run (default)
 *   node backend/scripts/emser-dedup-clean.mjs --apply    # write changes
 */

import pg from 'pg';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Tools / accessories where "mm" is a genuine product dimension — never strip it.
const TOOL_RE = /\b(clip|cutter|blade|leveling|scraper|spacer|wedge|bucket|trowel|sponge|vibrating|buster|washer|screw|pliers|elevel|cyclone|system)\b/i;

// ── Name normalization ──────────────────────────────────────────────────────
// Mirrors tidyEmserTileName() in scrapers/emser-832.js, plus the owner-requested
// junk-token removal (catx/dcs, thickness) and Sbn expansion.
function tidyEmserTileName(raw) {
  if (!raw) return raw;
  let n = raw;
  n = n.replace(/\b([A-Za-z]+)x(\d*\.?\d+)\s*mm\b/gi, '$1 $2mm');
  n = n.replace(/\b([A-Za-z]+)x\d*\.?\d+\s*cm\b/gi, '$1');
  n = n.replace(/\b\d+(?:\.\d+)?\s*cm\s*x\s*\d+(?:\.\d+)?\s*cm\b/gi, '');
  n = n.replace(/\bmesh\s*x\s*[\d.]+/gi, 'Mesh');
  n = n
    .replace(/\bon\s+\d*\.?\d+\s*(?:pcs?|sf)\b[^,]*/gi, '')
    .replace(/\d*\.?\d+\s*sf\s*\/\s*(?:pc|ct)\b/gi, '')
    .replace(/\d*\.?\d+\s*pcs?\s*\/\s*(?:ct|box)\b/gi, '')
    .replace(/\b\d+\s*pcs?\b/gi, '')
    .replace(/\bper\s+ct\b/gi, '')
    .replace(/\bgrp\d+\b/gi, '')
    .replace(/\bmixed\s+sizes\b/gi, '');
  n = n
    .replace(/\bthickness\b/gi, '')
    .replace(/(\d)\s*mm\b/gi, '$1mm')
    .replace(/(\d)\s*cm\b/gi, '$1cm')
    .replace(/(\d(?:mm|cm))\s+thick\b/gi, '$1')
    .replace(/\bthick\b/gi, '')
    .replace(/(^|\s)cm\b/gi, '$1');
  n = n
    .replace(/\b(matte|satin|polished|glossy|gloss|honed|semigloss|lappato|brushed|flamed|tumbled|rectified|sbn)(?:por|cer)\b/gi, '$1')
    .replace(/\bpor\b/gi, '');
  n = n
    .replace(/\s+On$/i, '')
    .replace(/\s*\/\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,/])/g, '$1')
    .trim()
    .replace(/[\s,/-]+$/, '')
    .trim();
  return n || raw;
}

function finalTidy(s) {
  return s
    .replace(/\bii\b/g, 'II')                 // "Porto ii" → "Porto II"
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,/])/g, '$1')
    .trim()
    .replace(/[\s,/-]+$/, '')
    .trim();
}

// Compute the cleaned name. `stripThickness` is decided by the caller (collision-aware).
function cleanName(raw, { stripThickness }) {
  let n = tidyEmserTileName(raw);
  n = n.replace(/\bcatx\b/gi, '').replace(/\bdcs\b/gi, '');   // junk spec codes
  n = n.replace(/\bsbn\b/gi, 'Single Bullnose');              // real trim type
  const isTool = TOOL_RE.test(raw);
  if (stripThickness && !isTool) {
    // Strip thickness, but preserve LVT thickness/wear-layer spec pairs
    // ("5mm/12mil", "2mm/12mil") — there mm is a real, differentiating spec.
    n = n.replace(/\b\d+(?:\.\d+)?\s*mm\b(?!\s*\/\s*\d+\s*mil)/gi, '');
  }
  return finalTidy(n);
}

// vendor_sku → duplicate-normal form. Strips V2/V3 drift, and the injected "W"
// after the collection code — but the W-strip is DATA-DRIVEN: it only applies
// when the de-W'd code actually exists as another SKU (its clean twin). This
// avoids mangling colors that legitimately start with W (e.g. WH = White, whose
// de-W'd form "…H…" has no twin and is therefore left intact).
const baseOf = v => v.replace(/[Vv][23]$/, '').toLowerCase();
const deW = b => b.replace(/^(f\d{2}[a-z]{4})w/, '$1');
let BASE_SET = new Set();
function normSku(v) {
  if (!v) return v;
  const b = baseOf(v);
  const d = deW(b);
  return (d !== b && BASE_SET.has(d)) ? d : b;
}

const isJunkName = (name, vsku) =>
  /\bcatx\b|\bdcs\b/i.test(name || '') ||
  /\d(?:\.\d)?\s*mm\b/i.test(name || '') ||
  /[Vv][23]$/.test(vsku || '') ||
  /^F\d{2}[A-Z]{4}W/.test(vsku || '');

async function main() {
  console.log(`\n=== Emser dedupe + name cleanup — ${APPLY ? 'APPLY' : 'DRY RUN'} ===\n`);

  const { rows: vrows } = await pool.query(
    `SELECT id FROM vendors WHERE name ILIKE '%emser%' LIMIT 1`);
  if (!vrows.length) throw new Error('Emser vendor not found');
  const vendorId = vrows[0].id;

  // Pull every Emser SKU with its product + pricing + media count.
  const { rows: skus } = await pool.query(`
    SELECT s.id AS sku_id, s.vendor_sku, s.variant_name, s.status AS sku_status,
           p.id AS product_id, p.name AS product_name, p.status AS product_status,
           pr.cost,
           (SELECT count(*) FROM media_assets m WHERE m.sku_id = s.id) AS media
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.vendor_sku IS NOT NULL
  `, [vendorId]);

  // Seed the base-form set so normSku's W-strip can check for a real clean twin.
  BASE_SET = new Set(skus.map(s => baseOf(s.vendor_sku)));

  // Group by normalized vendor_sku and pick a keeper per group.
  const groups = new Map();
  for (const s of skus) {
    s.norm = normSku(s.vendor_sku);
    s.cleanCode = s.vendor_sku.toLowerCase() === s.norm;   // no drift, no injected W
    s.junk = isJunkName(s.product_name, s.vendor_sku);
    if (!groups.has(s.norm)) groups.set(s.norm, []);
    groups.get(s.norm).push(s);
  }

  const keeperScore = (s) => [
    s.cleanCode ? 1 : 0,
    s.junk ? 0 : 1,
    Number(s.media) || 0,
    s.cost != null ? 1 : 0,
    (s.variant_name || '').length,
  ];
  const better = (a, b) => {
    const sa = keeperScore(a), sb = keeperScore(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i] ? a : b;
    return a.vendor_sku <= b.vendor_sku ? a : b;
  };

  const loserSkuIds = [];          // duplicate SKUs (their product may be deactivated)
  const mediaMigrations = [];      // { fromSku, toSku } when keeper lacks media
  let dupGroups = 0, costDeltas = 0;
  for (const [, arr] of groups) {
    if (arr.length < 2) continue;
    dupGroups++;
    let keeper = arr[0];
    for (const s of arr.slice(1)) keeper = better(keeper, s);
    keeper.isKeeper = true;
    const costs = new Set(arr.map(s => s.cost).filter(c => c != null).map(Number));
    if (costs.size > 1) costDeltas++;
    for (const s of arr) {
      if (s === keeper) continue;
      s.isLoser = true;
      loserSkuIds.push(s.sku_id);
      if ((Number(keeper.media) || 0) === 0 && (Number(s.media) || 0) > 0) {
        mediaMigrations.push({ fromSku: s.sku_id, toSku: keeper.sku_id });
      }
    }
  }

  // Per product: does it retain ANY non-loser SKU? If not → deactivate.
  const byProduct = new Map();
  for (const s of skus) {
    if (!byProduct.has(s.product_id))
      byProduct.set(s.product_id, { id: s.product_id, name: s.product_name, status: s.product_status, skus: [] });
    byProduct.get(s.product_id).skus.push(s);
  }
  const toDeactivate = [];
  const survivors = [];
  for (const p of byProduct.values()) {
    const keepsSomething = p.skus.some(s => !s.isLoser);
    if (!keepsSomething && p.status === 'active') toDeactivate.push(p);
    else survivors.push(p);
  }
  const deactivateIds = new Set(toDeactivate.map(p => p.id));

  // Name cleanup on active survivors. Collision-aware thickness stripping:
  // build the set of proposed names WITH thickness stripped; if a name would
  // collide with another surviving active product, retain thickness for the
  // colliding members.
  const activeSurvivors = survivors.filter(p => p.status === 'active');
  const strippedName = new Map();   // productId → name (thickness stripped)
  for (const p of activeSurvivors) strippedName.set(p.id, cleanName(p.name, { stripThickness: true }));
  const nameCount = new Map();
  for (const nm of strippedName.values()) nameCount.set(nm.toLowerCase(), (nameCount.get(nm.toLowerCase()) || 0) + 1);

  // Desired cleaned name per product (thickness retained where stripping would
  // collide with another survivor — e.g. Porto II 9.4mm vs 10.2mm).
  const skuCountFor = new Map(activeSurvivors.map(p => [p.id, p.skus.length]));
  const collisionsKept = [];
  for (const p of activeSurvivors) {
    const stripped = strippedName.get(p.id);
    const collides = nameCount.get(stripped.toLowerCase()) > 1;
    p.desired = collides ? cleanName(p.name, { stripThickness: false }) : stripped;
    if (collides && /\d(?:\.\d)?\s*mm/i.test(p.name)) collisionsKept.push({ name: p.name, finalName: p.desired });
  }

  // Collision-safe assignment: never CREATE a duplicate active name. A rename is
  // applied only if its target isn't another survivor's original name and hasn't
  // been claimed by a higher-priority rename. Losers keep their original name.
  const originalNameCount = new Map();
  for (const p of activeSurvivors) {
    const k = p.name.toLowerCase();
    originalNameCount.set(k, (originalNameCount.get(k) || 0) + 1);
  }
  const claimed = new Set();
  const renames = [];
  const skippedRenames = [];
  const candidates = activeSurvivors
    .filter(p => p.desired && p.desired !== p.name)
    .sort((a, b) => (skuCountFor.get(b.id) - skuCountFor.get(a.id)) || a.name.localeCompare(b.name));
  for (const p of candidates) {
    const key = p.desired.toLowerCase();
    const clashesOriginal = (originalNameCount.get(key) || 0) - (p.name.toLowerCase() === key ? 1 : 0) > 0;
    if (claimed.has(key) || clashesOriginal) { skippedRenames.push({ from: p.name, wanted: p.desired }); continue; }
    claimed.add(key);
    renames.push({ id: p.id, from: p.name, to: p.desired });
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`Duplicate SKU groups:        ${dupGroups}`);
  console.log(`Duplicate SKUs (losers):     ${loserSkuIds.length}`);
  console.log(`  …of which cost-delta grps:  ${costDeltas} (penny-level; keeper price kept)`);
  console.log(`Media migrations (keeper←dup): ${mediaMigrations.length}`);
  console.log(`Products to DEACTIVATE:       ${toDeactivate.length}  (all-duplicate rows)`);
  console.log(`Products to RENAME:           ${renames.length}`);
  console.log(`Renames skipped (would collide): ${skippedRenames.length}`);
  console.log(`Thickness kept for collisions: ${collisionsKept.length}`);

  // Post-rename uniqueness check: no two surviving ACTIVE products should share a name.
  const finalNames = new Map();
  for (const p of activeSurvivors) {
    const r = renames.find(x => x.id === p.id);
    const nm = (r ? r.to : p.name).toLowerCase();
    finalNames.set(nm, (finalNames.get(nm) || 0) + 1);
  }
  const preExisting = new Set([...originalNameCount].filter(([, c]) => c > 1).map(([n]) => n));
  const newCollisions = [...finalNames.entries()].filter(([n, c]) => c > 1 && !preExisting.has(n));
  const stillPre = [...finalNames.entries()].filter(([n, c]) => c > 1 && preExisting.has(n));
  console.log(`NEW duplicate names created:   ${newCollisions.length}` +
    (newCollisions.length ? `  ⚠ ${newCollisions.map(([n]) => n).join(' | ')}` : '  ✓ none'));
  console.log(`Pre-existing dup names (untouched): ${stillPre.length}` +
    (stillPre.length ? `  ${stillPre.map(([n]) => n).join(' | ')}` : ''));

  console.log(`\n── Sample deactivations (first 15) ──`);
  for (const p of toDeactivate.slice(0, 15)) console.log(`  ⊘ ${p.name}`);
  console.log(`\n── Sample renames (first 25) ──`);
  for (const r of renames.slice(0, 25)) console.log(`  "${r.from}"\n    → "${r.to}"`);
  if (collisionsKept.length) {
    console.log(`\n── Thickness retained to avoid name collision (first 10) ──`);
    for (const c of collisionsKept.slice(0, 10)) console.log(`  ${c.finalName}`);
  }

  // ── Backup ──────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = {
    generated: new Date().toISOString(),
    vendorId,
    deactivate: toDeactivate.map(p => ({ id: p.id, name: p.name })),
    renames,
    skippedRenames,
    loserSkuIds,
    mediaMigrations,
    collisionsKept,
  };
  const backupPath = join(DATA_DIR, `emser-dedup-clean-backup-${stamp}.json`);
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup written: ${backupPath}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — no changes written. Re-run with --apply to commit.\n`);
    await pool.end();
    return;
  }

  // ── Apply ─────────────────────────────────────────────────────────────────
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of mediaMigrations)
      await client.query(`UPDATE media_assets SET sku_id = $1 WHERE sku_id = $2`, [m.toSku, m.fromSku]);
    for (const r of renames)
      await client.query(`UPDATE products SET name = $1, updated_at = now() WHERE id = $2`, [r.to, r.id]);
    // Deactivate all-duplicate products (trigger cascades to their SKUs).
    for (const p of toDeactivate)
      await client.query(`UPDATE products SET status = 'inactive', updated_at = now() WHERE id = $1`, [p.id]);
    await client.query('COMMIT');
    console.log(`\n✅ Applied: ${renames.length} renamed, ${toDeactivate.length} deactivated, ${mediaMigrations.length} media moved.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('ROLLBACK —', e.message);
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
