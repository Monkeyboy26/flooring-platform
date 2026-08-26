#!/usr/bin/env node
/**
 * dedupe-emser-tile-products.cjs
 *
 * Resolves the duplicate Emser tile PRODUCT rows that Emser's EDI creates by
 * splitting one tile into extra rows differentiated only by carton count
 * ("Baja" + "Baja 6 Pcs/Ct" + "Baja 8 Pcs/Ct"). Runs AFTER
 * cleanup-emser-tile-names.cjs (which cleaned the survivors' names).
 *
 * Groups Emser tile products by (collection, tidied-name):
 *   • Clean survivor exists (name already tidy)  → deactivate the dup rows;
 *     the survivor already carries every color+size (redundant pack variants).
 *   • No clean survivor (all rows junk-named)     → promote the member with the
 *     most SKUs, rename it clean, repoint any UNIQUE-color SKUs (and their media)
 *     from the other members so no colors are lost, then deactivate the emptied
 *     members. Colors are keyed by normalized variant_name.
 *
 * Deactivation (status='inactive') is reversible. Dry-run by default.
 *
 * Usage:
 *   node backend/scripts/dedupe-emser-tile-products.cjs           # dry run
 *   node backend/scripts/dedupe-emser-tile-products.cjs --apply
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

const TILE_CATS = [
  'porcelain-tile', 'ceramic-tile', 'mosaic-tile', 'natural-stone', 'tile',
  'stacked-stone', 'porcelain-slabs', 'wood-look-tile', 'large-format-tile',
];

// Same tidy used by cleanup-emser-tile-names.cjs / emser-832.js.
function tidy(raw) {
  if (!raw) return raw;
  let n = raw;
  n = n.replace(/\b([A-Za-z]+)x(\d*\.?\d+)\s*mm\b/gi, '$1 $2mm')
       .replace(/\b([A-Za-z]+)x\d*\.?\d+\s*cm\b/gi, '$1')
       .replace(/\b\d+(?:\.\d+)?\s*cm\s*x\s*\d+(?:\.\d+)?\s*cm\b/gi, '')
       .replace(/\bmesh\s*x\s*[\d.]+/gi, 'Mesh')
       .replace(/\bon\s+\d*\.?\d+\s*(?:pcs?|sf)\b[^,]*/gi, '')
       .replace(/\d*\.?\d+\s*sf\s*\/\s*(?:pc|ct)\b/gi, '')
       .replace(/\d*\.?\d+\s*pcs?\s*\/\s*(?:ct|box)\b/gi, '')
       .replace(/\b\d+\s*pcs?\b/gi, '')
       .replace(/\bper\s+ct\b/gi, '')
       .replace(/\bgrp\d+\b/gi, '')
       .replace(/\bmixed\s+sizes\b/gi, '')
       .replace(/\bthickness\b/gi, '')
       .replace(/(\d)\s*mm\b/gi, '$1mm')
       .replace(/(\d)\s*cm\b/gi, '$1cm')
       .replace(/(\d(?:mm|cm))\s+thick\b/gi, '$1')
       .replace(/\bthick\b/gi, '')
       .replace(/(^|\s)cm\b/gi, '$1')
       .replace(/\b(matte|satin|polished|glossy|gloss|honed|semigloss|lappato|brushed|flamed|tumbled|rectified|sbn)(?:por|cer)\b/gi, '$1')
       .replace(/\bpor\b/gi, '')
       .replace(/\s+On$/i, '')
       .replace(/\s{2,}/g, ' ')
       .replace(/\s+([,/])/g, '$1')
       .trim()
       .replace(/[\s,/-]+$/, '')
       .trim();
  return n || raw;
}

const key = s => (s || '').trim().toUpperCase();

async function main() {
  console.log(`\n=== Dedupe Emser Tile Products ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  const vendorId = (await pool.query("SELECT id FROM vendors WHERE code='EMS'")).rows[0].id;

  const rows = (await pool.query(
    `SELECT p.id, COALESCE(p.collection,'') AS collection, p.name, p.status,
            (SELECT count(*) FROM skus s WHERE s.product_id = p.id) AS sku_ct,
            (SELECT count(*) FROM media_assets m WHERE m.product_id = p.id) AS img_ct
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND c.slug = ANY($2) AND p.status <> 'inactive'`,
    [vendorId, TILE_CATS]
  )).rows.map(r => ({ ...r, sku_ct: +r.sku_ct, img_ct: +r.img_ct, clean: tidy(r.name) }));

  // Group by (collection, clean name).
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.collection}|||${r.clean}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const deactivate = [];   // {id, name, reason}
  const renames = [];      // {id, from, to}
  const repoints = [];     // {skuMoves:[{from,to,variant}], survivor, loser}
  let refGuardHits = 0;

  // variant-name sets per product (only needed for no-survivor merges)
  async function variantKeys(productId) {
    const vs = (await pool.query(
      'SELECT DISTINCT variant_name FROM skus WHERE product_id=$1 AND variant_name IS NOT NULL', [productId]
    )).rows.map(r => key(r.variant_name));
    return new Set(vs);
  }
  async function hasRefs(productId) {
    const r = (await pool.query(
      `SELECT (SELECT count(*) FROM order_items oi JOIN skus s ON s.id=oi.sku_id WHERE s.product_id=$1) o,
              (SELECT count(*) FROM cart_items ci JOIN skus s ON s.id=ci.sku_id WHERE s.product_id=$1) c`,
      [productId]
    )).rows[0];
    return (+r.o + +r.c) > 0;
  }

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const cleanMembers = members.filter(m => m.name === m.clean);

    if (cleanMembers.length) {
      // Survivor already clean & complete — deactivate the junk dup rows.
      const survivor = cleanMembers.sort((a, b) => b.sku_ct - a.sku_ct)[0];
      for (const m of members) {
        if (m.id === survivor.id) continue;
        if (await hasRefs(m.id)) { refGuardHits++; continue; }
        deactivate.push({ id: m.id, name: m.name, reason: `redundant of "${survivor.name}"` });
      }
    } else {
      // No clean survivor — promote the largest, merge unique colors from the rest.
      const survivor = members.slice().sort((a, b) => b.sku_ct - a.sku_ct || b.img_ct - a.img_ct)[0];
      // Guard the unique (vendor, collection, name) index against an external clash.
      const clash = (await pool.query(
        'SELECT 1 FROM products WHERE vendor_id=$1 AND COALESCE(collection,\'\')=$2 AND name=$3 AND id<>$4 LIMIT 1',
        [vendorId, survivor.collection, survivor.clean, survivor.id]
      )).rows.length;
      if (!clash && survivor.name !== survivor.clean) {
        renames.push({ id: survivor.id, from: survivor.name, to: survivor.clean });
      }
      const survKeys = await variantKeys(survivor.id);
      for (const m of members) {
        if (m.id === survivor.id) continue;
        if (await hasRefs(m.id)) { refGuardHits++; continue; }
        const skus = (await pool.query(
          'SELECT id, variant_name FROM skus WHERE product_id=$1', [m.id])).rows;
        const moves = [];
        for (const s of skus) {
          const vk = key(s.variant_name);
          if (vk && !survKeys.has(vk)) { survKeys.add(vk); moves.push({ id: s.id, variant: s.variant_name }); }
        }
        if (moves.length) repoints.push({ survivorId: survivor.id, survivorName: survivor.clean, loserName: m.name, moves });
        deactivate.push({ id: m.id, name: m.name, reason: moves.length ? `${moves.length} colors merged → "${survivor.clean}"` : `redundant of "${survivor.clean}"` });
      }
    }
  }

  // ---- Report ----
  console.log(`RENAME survivors: ${renames.length}`);
  for (const r of renames) console.log(`   "${r.from}"  →  "${r.to}"`);
  console.log(`\nMERGE unique colors (repoint SKUs + their media): ${repoints.length} loser rows`);
  for (const r of repoints) {
    console.log(`   ${r.moves.length} SKUs  "${r.loserName}"  →  "${r.survivorName}"  [${r.moves.map(m => m.variant).join(', ')}]`);
  }
  console.log(`\nDEACTIVATE dup rows: ${deactivate.length}`);
  const totalMovedSkus = repoints.reduce((n, r) => n + r.moves.length, 0);
  if (refGuardHits) console.log(`\n(!) ${refGuardHits} dup rows had order/cart refs and were LEFT ACTIVE.`);
  console.log(`\nSummary: ${renames.length} renamed, ${totalMovedSkus} SKUs merged, ${deactivate.length} rows deactivated.`);

  if (!APPLY) {
    console.log(`\n(DRY RUN — no changes written. Re-run with --apply.)\n`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of renames) {
      await client.query('UPDATE products SET name=$1 WHERE id=$2', [r.to, r.id]);
    }
    for (const r of repoints) {
      for (const m of r.moves) {
        await client.query('UPDATE skus SET product_id=$1 WHERE id=$2', [r.survivorId, m.id]);
        // Sku-level media follow their SKU to the survivor product.
        await client.query('UPDATE media_assets SET product_id=$1 WHERE sku_id=$2', [r.survivorId, m.id]);
      }
    }
    for (const d of deactivate) {
      await client.query("UPDATE products SET status='inactive' WHERE id=$1", [d.id]);
    }
    await client.query('COMMIT');
    console.log(`\nApplied.\n`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
