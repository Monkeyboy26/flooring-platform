#!/usr/bin/env node
/**
 * Stone Pride borders — add sizes to variant names + attach corners as accessories
 * (2026-09-08)
 *
 * Products: "Waterjet Marble Borders" (42) and "Marble Mosaic Liners" (17) — one product
 * per collection, each SKU a design (Grace, Carolina, Design 03…). Sizes and corner pieces
 * are encoded in the vendor_sku / catalog `desc` ('4"X12" Marble border…', '6"X6" Corner
 * for ML-81Grace6x18'), but the variant labels were inconsistent ("Grace" vs "Grace 5×18")
 * and the corner pieces sat in the main variant pills.
 *
 * This does (idempotent — recomputes names from catalog `desc`, ON CONFLICT on links):
 *   1. SIZES: rewrites every border/liner variant_name to "{Design} {W}×{L}" (corners →
 *      "{Design} {W}×{L} Corner"), taking the size from the catalog `desc`.
 *   2. CORNERS → ACCESSORIES: each corner is matched to the linear border of the SAME
 *      design + width (Grace 5×5 Corner → Grace 5×18; Harmony 4×4 → Harmony 4×12), then
 *      set variant_type='accessory' + accessory_label='Matching Corner' (removes it from
 *      the variant pills — server.js siblings excludes accessories) and linked via
 *      sku_accessories so it shows in the PDP "Matching Corner" accessory card.
 *      A corner with no linear parent in its product (e.g. Waterjet ML-21-Corner) is left
 *      as a normal variant and reported.
 *
 * Reverse: rename is derived (re-run of import/this script is the source of truth);
 *   to undo the accessory conversion:
 *     DELETE FROM sku_accessories WHERE accessory_sku_id IN (<corner ids>);
 *     UPDATE skus SET variant_type=NULL, accessory_label=NULL WHERE id IN (<corner ids>);
 *
 * Usage (inside api container):
 *   docker compose exec -T api node scripts/fix-stone-pride-borders.mjs --dry-run
 *   docker compose exec -T api node scripts/fix-stone-pride-borders.mjs
 */
import pg from 'pg';
import fs from 'fs';
import { fileURLToPath } from 'url';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});
const DRY = process.argv.includes('--dry-run');
const PRODUCTS = ['Waterjet Marble Borders', 'Marble Mosaic Liners'];
// Corners with no linear parent in their OWN product, cross-linked to a parent in the
// other product by explicit owner decision (vendor_sku -> parent vendor_sku).
const CROSS_LINKS = { 'ML-21-Corner(D)': 'MSL-21-P(D)' }; // Waterjet Design 21 corner -> Mosaic Liner Design 21
const CATALOG = fileURLToPath(new URL('../data/stone-pride/catalog.json', import.meta.url));

const SIZE_RE = /(\d+(?:\.\d+)?)\s*["″]?\s*[×xX]\s*(\d+(?:\.\d+)?)\s*["″]?/;
function sizeFromDesc(desc) {
  const m = SIZE_RE.exec(desc || '');
  return m ? { w: parseFloat(m[1]), l: parseFloat(m[2]), str: `${m[1]}×${m[2]}` } : null;
}
// Derive a clean "{Design} {W}×{L}[ Corner][ (qual)]" name + matching keys from the raw
// variant_name and the catalog desc.
function derive(variantName, desc) {
  const size = sizeFromDesc(desc);
  if (!size) return null;
  const isCorner = /corner/i.test(desc) || /corner/i.test(variantName);
  let name = variantName;
  // pull trailing parenthetical qualifiers off the end: (v2) (BWG) (ED) (RA) …
  const quals = [];
  let m;
  while ((m = /\s*(\([^)]*\))\s*$/.exec(name))) { quals.unshift(m[1]); name = name.slice(0, m.index); }
  // strip size tokens and the word Corner, then trim stray separators
  let core = name
    .replace(/\d+(?:\.\d+)?\s*["″]?\s*[×xX]\s*\d+(?:\.\d+)?\s*["″]?/g, ' ')
    .replace(/\bcorner\b/ig, ' ')
    .replace(/[\s\-–]+/g, ' ')
    .trim();
  const qual = quals.join(' ');
  const newName = `${core} ${size.str}${isCorner ? ' Corner' : ''}${qual ? ' ' + qual : ''}`.replace(/\s+/g, ' ').trim();
  return { newName, coreKey: core.toLowerCase(), width: size.w, isCorner };
}

async function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const descBySku = new Map();
  for (const p of catalog) if (PRODUCTS.includes(p.name))
    for (const s of p.skus) descBySku.set(s.vendor_sku, s.desc || '');

  let renamed = 0, linked = 0, converted = 0, orphans = [];
  for (const pname of PRODUCTS) {
    const { rows: skus } = await pool.query(`
      SELECT s.id, s.variant_name, s.vendor_sku, s.variant_type
      FROM skus s JOIN products p ON p.id = s.product_id JOIN vendors v ON v.id = p.vendor_id
      WHERE v.code = 'STPR' AND p.name = $1 AND s.status = 'active'
    `, [pname]);

    // compute derived names/keys
    const info = new Map(); // id -> {newName, coreKey, width, isCorner, vendor_sku}
    for (const s of skus) {
      const d = descBySku.get(s.vendor_sku);
      const der = derive(s.variant_name, d);
      if (!der) { console.log(`  [${pname}] no size in desc, left: ${s.vendor_sku} (${s.variant_name})`); continue; }
      info.set(s.id, { ...der, vendor_sku: s.vendor_sku, oldName: s.variant_name });
    }

    // 1) rename
    for (const [id, i] of info) {
      if (i.newName !== i.oldName) {
        console.log(`  rename [${pname}] "${i.oldName}" -> "${i.newName}"`);
        if (!DRY) await pool.query(`UPDATE skus SET variant_name = $1 WHERE id = $2`, [i.newName, id]);
        renamed++;
      }
    }

    // 2) corners -> accessories, matched to linear of same design core + width
    const linears = [...info.entries()].filter(([, i]) => !i.isCorner);
    for (const [cid, ci] of info) {
      if (!ci.isCorner) continue;
      const parents = linears.filter(([, li]) => li.coreKey === ci.coreKey && li.width === ci.width);
      if (!parents.length) {
        // no same-product parent — use an explicit cross-product link if defined
        const targetVsku = CROSS_LINKS[ci.vendor_sku];
        if (targetVsku) {
          const { rows: tr } = await pool.query(`
            SELECT s.id, s.variant_name FROM skus s JOIN products p ON p.id = s.product_id
            JOIN vendors v ON v.id = p.vendor_id
            WHERE v.code = 'STPR' AND s.vendor_sku = $1 AND s.status = 'active' LIMIT 1`, [targetVsku]);
          if (tr.length) {
            if (!DRY) {
              await pool.query(`UPDATE skus SET variant_type = 'accessory', accessory_label = 'Matching Corner' WHERE id = $1`, [cid]);
              await pool.query(`INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [tr[0].id, cid]);
            }
            console.log(`  corner->accessory [${pname}] ${ci.newName}  ->  ${tr[0].variant_name} (cross-product)`);
            converted++; linked++;
            continue;
          }
        }
        orphans.push(`${pname}: ${ci.vendor_sku} (${ci.newName})`); continue;
      }
      if (!DRY) {
        await pool.query(`UPDATE skus SET variant_type = 'accessory', accessory_label = 'Matching Corner' WHERE id = $1`, [cid]);
        for (const [pid] of parents)
          await pool.query(`INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [pid, cid]);
      }
      console.log(`  corner->accessory [${pname}] ${ci.newName}  ->  ${parents.map(([, p]) => p.newName).join(', ')}`);
      converted++; linked += parents.length;
    }
  }

  console.log(`\n${DRY ? '[DRY-RUN] ' : ''}renamed=${renamed}  corners_converted=${converted}  accessory_links=${linked}`);
  if (orphans.length) console.log(`Corners with no linear parent (left as normal variant): ${orphans.length}\n  - ${orphans.join('\n  - ')}`);
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
