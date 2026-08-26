#!/usr/bin/env node
/**
 * cleanup-emser-tile-names.cjs
 *
 * One-time backfill that cleans up Emser TILE product names and evicts
 * non-tile strays (trim/bullnose/leveling hardware) that leaked into the
 * field-tile categories. The name-normalization logic mirrors
 * `tidyEmserTileName()` in scrapers/emser-832.js so re-imports stay clean.
 *
 * Two independent fixes:
 *   1. NAME:     strip packaging/quantity junk ("8 Pcs/Ct", "3.875 Sf/Pc",
 *                "Grp1", "2000pc"), normalize thickness ("9 Mm"→"9mm",
 *                "Mattex7.5 Mm"→"Matte 7.5mm"), drop "Thickness"/"Por"/"Cm"
 *                noise and trailing "Mixed Sizes".
 *   2. STRUCTURE: bullnose/cove/sbn/sill → trim-accessories,
 *                edge-protector/reducer/quarter-circle/ramp → transitions-moldings,
 *                elevel/wedge/clip/washer/screw/pliers → installation-sundries.
 *
 * Only touches products in Emser's field-tile categories. Dry-run by default.
 *
 * Usage:
 *   node backend/scripts/cleanup-emser-tile-names.cjs            # dry run
 *   node backend/scripts/cleanup-emser-tile-names.cjs --apply    # write
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const APPLY = process.argv.includes('--apply');

// Field-tile categories this cleanup operates on.
const TILE_CATS = [
  'porcelain-tile', 'ceramic-tile', 'mosaic-tile', 'natural-stone', 'tile',
  'stacked-stone', 'porcelain-slabs', 'wood-look-tile', 'large-format-tile',
];

// ---------------------------------------------------------------------------
// Name normalization — kept in sync with tidyEmserTileName() in emser-832.js
// ---------------------------------------------------------------------------
function tidyEmserTileName(raw) {
  if (!raw) return raw;
  let n = raw;

  // Un-glue finish words fused to a thickness ("Mattex7.5 Mm", "Polishedx0.90 Cm",
  // "Mosaicx0.55 Cm", "Satincerx1.00 Cm"). mm thickness is kept (normalized);
  // cm thickness is dropped as noise (values are unreliable — often the tile size).
  n = n.replace(/\b([A-Za-z]+)x(\d*\.?\d+)\s*mm\b/gi, '$1 $2mm');
  n = n.replace(/\b([A-Za-z]+)x\d*\.?\d+\s*cm\b/gi, '$1');
  n = n.replace(/\b\d+(?:\.\d+)?\s*cm\s*x\s*\d+(?:\.\d+)?\s*cm\b/gi, ''); // "31.5cmx31.5cm" size noise
  n = n.replace(/\bmesh\s*x\s*[\d.]+/gi, 'Mesh');                          // "Meshx1.25" mesh count

  // Strip packaging / quantity noise anywhere in the string. Quantities may be
  // written with a leading-dot decimal (".949 Sf/Pc") or glued onto a thickness
  // ("7.5mm9pc/Ct"), so \d*\.?\d+ and the pcs/ct rule is not \b-anchored.
  n = n
    .replace(/\bon\s+\d*\.?\d+\s*(?:pcs?|sf)\b[^,]*/gi, '')  // "On 8 Pcs/Ct", "On 1.00sf/Pc"
    .replace(/\d*\.?\d+\s*sf\s*\/\s*(?:pc|ct)\b/gi, '')      // "3.875 Sf/Pc", ".949 Sf/Pc", "10.3 Sf/Ct"
    .replace(/\d*\.?\d+\s*pcs?\s*\/\s*(?:ct|box)\b/gi, '')   // "8 Pcs/Ct", "10pc/Box", "mm9pc/Ct"
    .replace(/\b\d+\s*pcs?\b/gi, '')                         // "6 Pcs", "2000pc", "5pc"
    .replace(/\bper\s+ct\b/gi, '')                           // "Per Ct"
    .replace(/\bgrp\d+\b/gi, '')                             // "Grp1"
    .replace(/\bmixed\s+sizes\b/gi, '');                     // engineered-stone packaging note

  // Thickness: normalize "9 Mm"/"9.2 MM" → "9mm", "2 Cm" → "2cm"; drop the
  // redundant "Thickness"/"Thick" words and any orphan standalone "Cm".
  n = n
    .replace(/\bthickness\b/gi, '')
    .replace(/(\d)\s*mm\b/gi, '$1mm')
    .replace(/(\d)\s*cm\b/gi, '$1cm')
    .replace(/(\d(?:mm|cm))\s+thick\b/gi, '$1')
    .replace(/\bthick\b/gi, '')
    .replace(/(^|\s)cm\b/gi, '$1');

  // Un-fuse a material-code suffix glued onto a finish ("Mattepor"→"Matte",
  // "Satincer"→"Satin") and drop the redundant standalone "Por" (already porcelain).
  n = n
    .replace(/\b(matte|satin|polished|glossy|gloss|honed|semigloss|lappato|brushed|flamed|tumbled|rectified|sbn)(?:por|cer)\b/gi, '$1')
    .replace(/\bpor\b/gi, '');

  // Collapse whitespace and tidy dangling separators / trailing "On".
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

// ---------------------------------------------------------------------------
// Structure — reclassify non-tile strays out of the field-tile categories.
// Returns a target category slug, or null to leave the product where it is.
// ---------------------------------------------------------------------------
function reclassifyStray(name) {
  const s = (name || '').toLowerCase();

  // Leveling systems, spacers, fasteners, misc install hardware → sundries.
  if (/\b(elevel|wedge|clip|spacer|washers?|screws?|pliers?|tab)\b/.test(s)) {
    return 'installation-sundries';
  }
  // Transition / edge profiles → transitions-moldings.
  if (/\b(edge\s*protector|reducer|quarter\s*circle|ramp|skirting|carpet\s*trim)\b/.test(s)) {
    return 'transitions-moldings';
  }
  // Tile finishing trim: bullnose, cove, sbn (single bullnose), sills, pencils.
  if (/\b(bullnose|sbn|cove\s*base|cove\s*corner|inside\s*cove|outside\s*cove|sill|threshold|shelf|pencil|liner|v-?cap|mud\s*cap)\b/.test(s)) {
    return 'trim-accessories';
  }
  return null;
}

async function main() {
  console.log(`\n=== Cleanup Emser Tile Names ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  const vendorRes = await pool.query("SELECT id FROM vendors WHERE code = 'EMS'");
  if (!vendorRes.rows.length) throw new Error('Emser vendor (EMS) not found');
  const vendorId = vendorRes.rows[0].id;

  const catRes = await pool.query('SELECT id, slug FROM categories WHERE slug = ANY($1)', [
    [...TILE_CATS, 'trim-accessories', 'transitions-moldings', 'installation-sundries'],
  ]);
  const catIdBySlug = new Map(catRes.rows.map(r => [r.slug, r.id]));

  const rows = (await pool.query(
    `SELECT p.id, p.name, COALESCE(p.collection,'') AS collection, c.slug AS cat
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND c.slug = ANY($2)
      ORDER BY c.slug, p.name`,
    [vendorId, TILE_CATS]
  )).rows;

  // The unique index is (vendor_id, collection, name). Build the map of every
  // Emser product's FUTURE (collection, name): tile rows use their cleaned name,
  // all other Emser products keep their current name. A rename is safe only when
  // its future pair is unique across this whole map — otherwise the whole colliding
  // group is a set of duplicate rows to merge, not rename (never half-clean a set).
  const allEmser = (await pool.query(
    `SELECT p.id, COALESCE(p.collection,'') AS collection, p.name,
            (c.slug = ANY($2)) AS is_tile
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1`,
    [vendorId, TILE_CATS]
  )).rows;

  const pairCount = new Map();
  for (const p of allEmser) {
    const futureName = p.is_tile ? tidyEmserTileName(p.name) : p.name;
    const pair = `${p.collection}|||${futureName}`;
    pairCount.set(pair, (pairCount.get(pair) || 0) + 1);
  }
  const pairIsUnique = (collection, name) => (pairCount.get(`${collection}|||${name}`) || 0) === 1;

  console.log(`Scanning ${rows.length} Emser products in field-tile categories.\n`);

  const nameChanges = [];
  const moves = [];
  const skipped = [];

  for (const r of rows) {
    const cleaned = tidyEmserTileName(r.name);
    // Classify on the cleaned name so glued forms ("Sbnpor"→"Sbn") are caught.
    const move = reclassifyStray(cleaned);
    const isMove = move && move !== r.cat;
    const willRename = cleaned !== r.name;
    // A rename is only safe when its future (collection, name) is unique.
    const renameSafe = willRename && pairIsUnique(r.collection, cleaned);

    if (willRename && !renameSafe) {
      skipped.push({ ...r, cleaned, to: isMove ? move : null });
      // A category move is collision-free (index ignores category) — still apply
      // it, keeping the original name.
      if (isMove) moves.push({ ...r, to: move, cleaned: r.name });
      continue;
    }

    if (isMove) moves.push({ ...r, to: move, cleaned: renameSafe ? cleaned : r.name });
    else if (renameSafe) nameChanges.push({ ...r, cleaned });
  }

  // ---- Report: structure moves ----
  console.log(`── STRUCTURE: ${moves.length} non-tile strays to move out of tile categories ──`);
  const byDest = {};
  for (const m of moves) byDest[m.to] = (byDest[m.to] || 0) + 1;
  for (const [dest, n] of Object.entries(byDest)) console.log(`   → ${dest}: ${n}`);
  console.log();
  for (const m of moves) {
    const rename = m.cleaned !== m.name ? `  ("${m.name}" → "${m.cleaned}")` : '';
    console.log(`   [${m.cat} → ${m.to}] ${m.name}${rename}`);
  }

  // ---- Report: name-only changes ----
  console.log(`\n── NAMES: ${nameChanges.length} tile products to rename ──\n`);
  for (const c of nameChanges) {
    console.log(`   [${c.cat}] "${c.name}"\n            → "${c.cleaned}"`);
  }

  // ---- Report: skipped renames (would collide on the unique index) ----
  if (skipped.length) {
    console.log(`\n── SKIPPED: ${skipped.length} renames that would duplicate an existing (collection, name) ──`);
    console.log(`   (these are near-duplicate product rows split by carton/group — left as-is; merge separately)\n`);
    for (const s of skipped) {
      console.log(`   [${s.cat}${s.to ? ` → ${s.to}` : ''}] "${s.name}"  ⇢  would become "${s.cleaned}" (taken)`);
    }
  }

  if (!APPLY) {
    console.log(`\n(DRY RUN — no changes written. Re-run with --apply to commit.)\n`);
    await pool.end();
    return;
  }

  // ---- Apply ----
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of moves) {
      const finalName = m.cleaned || m.name;
      await client.query('UPDATE products SET category_id = $1, name = $2 WHERE id = $3',
        [catIdBySlug.get(m.to), finalName, m.id]);
    }
    for (const c of nameChanges) {
      await client.query('UPDATE products SET name = $1 WHERE id = $2', [c.cleaned, c.id]);
    }
    await client.query('COMMIT');
    console.log(`\nApplied: ${moves.length} moved, ${nameChanges.length + moves.filter(m => m.cleaned !== m.name).length} renamed.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
