#!/usr/bin/env node

/**
 * Give Bellezza accessories self-contained, specific display names.
 *
 * The storefront shows accessories by `skus.accessory_label` (COALESCE with the
 * product name). Bellezza's were bare type words — "Jolly Trim", "Mosaic",
 * "Reducer", "Stair Nose", "Schluter Trim" — which are meaningless out of the
 * PDP context (e.g. in the cart or the "Matching Accessories" list). This sets
 * each to `<base> <variant_name>` so it reads e.g. "Altea Ash Blue Jolly Trim",
 * "Dolomite Matte Mosaic 2x2", "Mango Reducer", "Schluter Covebase Matte 8ft".
 *
 * Deterministic (rebuilds the label from product + variant each run) → idempotent.
 *
 * Usage: docker compose exec api node scripts/fix-bellezza-accessory-names.mjs
 */

import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.env.DRY_RUN === '1';

// Prefix to use instead of the raw product name for a cleaner read.
const BASE_OVERRIDE = { 'Mango Moldings': 'Mango', 'Schluter Trim': 'Schluter' };

// Only touch rows whose current label is a bare generic type word.
const GENERIC = new Set(['Jolly Trim', 'Mosaic', 'Quarter Round', 'Reducer', 'Stair Nose', 'T-Molding', 'Schluter Trim']);

function buildLabel(product, variant) {
  const base = BASE_OVERRIDE[product] || product;
  const v = (variant || '').trim();
  if (!v) return base;
  // Avoid duplicating the base if the variant already starts with it.
  if (v.toLowerCase().startsWith(base.toLowerCase())) return v;
  return `${base} ${v}`;
}

async function main() {
  const vendor = (await pool.query("SELECT id FROM vendors WHERE code='BLZ'")).rows[0];
  if (!vendor) throw new Error('BLZ vendor not found');

  const rows = (await pool.query(`
    SELECT s.id, p.name AS product, s.variant_name, s.accessory_label
    FROM products p JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.variant_type = 'accessory'
      AND COALESCE(NULLIF(s.accessory_label, ''), '') <> ''
    ORDER BY p.name, s.variant_name
  `, [vendor.id])).rows;

  let changed = 0;
  for (const r of rows) {
    if (!GENERIC.has(r.accessory_label)) continue; // already specific — leave it
    const next = buildLabel(r.product, r.variant_name);
    if (next === r.accessory_label) continue;
    console.log(`  "${r.accessory_label}" -> "${next}"`);
    if (!DRY_RUN) await pool.query('UPDATE skus SET accessory_label=$2 WHERE id=$1', [r.id, next]);
    changed++;
  }
  console.log(`\n${changed} accessory label(s) ${DRY_RUN ? 'would be' : ''} updated.`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
