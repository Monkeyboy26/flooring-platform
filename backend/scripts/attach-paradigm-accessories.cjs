#!/usr/bin/env node
/**
 * attach-paradigm-accessories.cjs
 *
 * Finds Paradigm/Conquest/Odyssey/Performer accessory SKUs in the generic
 * "End Cap 94", "Reducer 94.49", "T-molding 94", etc. products, matches
 * them to their parent flooring SKUs by color name, and links them via
 * sku_accessories. Also sets variant_type='accessory' and sell_by='unit'.
 *
 * Accessory vendor_sku patterns:
 *   Conquest:  FOSCON{num}PAD{suffix}   → Paradigm Conquest SPC W/pad 20mil 9 X72
 *   Insignia:  ELTPI{num}{suffix}       → Paradigm Insignia 20mil WPC W/pad 9 X60
 *   Perf Plus: ELTPPPSPC{num}{suffix}   → Paradigm Performer Plus SPC W/pad 20mil 9 X60
 *   Perf 20:   RCGPPSPC{num}{suffix}    → Paradigm Performer SPC W/pad 20mil 9 X60
 *   Perf 12:   ELTPPSPC{num}{suffix}    → Paradigm Performer SPC 12mil (Micro/Painted)
 *   Odyssey:   FOS7{num}{suffix}        → Odyssey WPC Coll W/pad 20mil 9 X72
 *
 * Usage:
 *   node backend/scripts/attach-paradigm-accessories.cjs --dry-run
 *   node backend/scripts/attach-paradigm-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Accessory type label derived from product name
function deriveLabel(productName) {
  const pn = productName.toLowerCase();
  if (pn.includes('end cap')) return 'End Cap';
  if (pn.includes('flush stair') || pn.includes('flush square stair')) return 'Flush Stair Nose';
  if (pn.includes('overlap stair')) return 'Overlap Stair Nose';
  if (pn.includes('bullnose stair') || pn.includes('bullnose')) return 'Bullnose Stair Tread';
  if (pn.includes('quarter round')) return 'Quarter Round';
  if (pn.includes('reducer')) return 'Reducer';
  if (pn.includes('t-molding') || pn.includes('t-mold')) return 'T-Molding';
  if (pn.includes('threshold')) return 'Threshold';
  if (pn.includes('multi function') || pn.includes('multi-function')) return 'Multi-Function';
  return productName;
}

// Map vendor_sku prefix → parent product name(s)
const SKU_PREFIX_TO_PARENT = [
  { prefix: 'FOSCON',     parents: ['Paradigm Conquest SPC W/pad 20mil 9 X72'] },
  { prefix: 'FOS7',       parents: ['Odyssey WPC Coll W/pad 20mil 9 X72'] },
  { prefix: 'ELTPPPSPC',  parents: ['Paradigm Performer Plus SPC W/pad 20mil 9 X60'] },
  { prefix: 'RCGPPSPC',   parents: ['Paradigm Performer SPC W/pad 20mil 9 X60'] },
  { prefix: 'RCGHAWPPSPC', parents: ['Paradigm Performer 20mil SPC W/pad'] },
  { prefix: 'ELTPPSPC',   parents: ['Paradigm Performer SPC W/pad 12mil 7 X60 - Micro Bevel',
                                     'Paradigm Performer SPC W/pad 12mil 7 X60 - Painted Bevel',
                                     'Performer Dryback'] },
  { prefix: 'ELTPI',      parents: ['Paradigm Insignia 20mil WPC W/pad 9 X60'] },
];

// Suffix patterns that indicate accessories (not main planks)
const ACC_SUFFIXES = /(?:EC|FSN|OSN|QR|RD|TM|TH|BST|MFN|XLEC|XLFSN|XLOSN|XLQR|XLRD|XLTM|XLTH|XLBST|TRD|WFSN|WOSN|WRD|WTM|WEC|WQR)$/;

function norm(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function main() {
  const client = await pool.connect();
  try {
    // 1. Load all main Paradigm flooring SKUs
    const parentNames = SKU_PREFIX_TO_PARENT.flatMap(m => m.parents);
    const { rows: floorSkus } = await client.query(`
      SELECT s.id, s.variant_name, s.product_id, p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.name = ANY($1)
        AND s.status = 'active'
        AND (s.variant_type IS NULL OR s.variant_type != 'accessory')
    `, [parentNames]);

    console.log(`Loaded ${floorSkus.length} Paradigm flooring SKUs`);

    // Build color→parent lookup per product
    // Key: "product_name|normalized_color" → sku_id
    const parentLookup = new Map();
    for (const f of floorSkus) {
      const key = f.product_name + '|' + norm(f.variant_name);
      if (!parentLookup.has(key)) parentLookup.set(key, f.id);
    }

    // 2. Load ALL accessory SKUs from generic accessory products
    const { rows: accSkus } = await client.query(`
      SELECT s.id, s.variant_name, s.vendor_sku, s.product_id, s.status,
             s.variant_type, s.sell_by,
             p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.name = 'Tri-West'
        AND (p.name ILIKE 'End Cap%' OR p.name ILIKE 'Flush Stair%'
             OR p.name ILIKE 'Overlap Stair%' OR p.name ILIKE 'Quarter Round%'
             OR p.name ILIKE 'Reducer%' OR p.name ILIKE 'T-molding%'
             OR p.name ILIKE 'Threshold%' OR p.name ILIKE 'Conquest Fabricated%'
             OR p.name ILIKE 'Odyssey Bullnose%' OR p.name ILIKE 'Odyssey Flush%')
    `);

    console.log(`Loaded ${accSkus.length} candidate accessory SKUs`);

    // 3. Match accessories to parents
    let linked = 0, activated = 0, typed = 0, sellByFixed = 0;
    const linkPairs = []; // { parent_sku_id, accessory_sku_id, sort_order }
    const sortOrderMap = {
      'End Cap': 1, 'Flush Stair Nose': 2, 'Overlap Stair Nose': 3,
      'Bullnose Stair Tread': 4, 'Quarter Round': 5, 'Reducer': 6,
      'T-Molding': 7, 'Threshold': 8, 'Multi-Function': 9
    };

    for (const acc of accSkus) {
      const vsku = acc.vendor_sku || '';

      // Determine which parent collection this accessory belongs to
      let matchedParents = null;
      for (const mapping of SKU_PREFIX_TO_PARENT) {
        if (vsku.startsWith(mapping.prefix) && ACC_SUFFIXES.test(vsku)) {
          matchedParents = mapping.parents;
          break;
        }
      }

      // Also match Conquest Fabricated and Odyssey Bullnose/Flush by product name
      if (!matchedParents) {
        if (acc.product_name.startsWith('Conquest Fabricated')) {
          matchedParents = ['Paradigm Conquest SPC W/pad 20mil 9 X72'];
        } else if (acc.product_name.startsWith('Odyssey Bullnose') || acc.product_name.startsWith('Odyssey Flush')) {
          matchedParents = ['Odyssey WPC Coll W/pad 20mil 9 X72'];
        }
      }

      if (!matchedParents) continue;

      // Find matching parent by color
      const accColor = norm(acc.variant_name);
      let parentSkuId = null;
      for (const parentName of matchedParents) {
        const key = parentName + '|' + accColor;
        if (parentLookup.has(key)) {
          parentSkuId = parentLookup.get(key);
          break;
        }
      }

      if (!parentSkuId) continue;

      const label = deriveLabel(acc.product_name);
      const sortOrder = sortOrderMap[label] || 10;

      linkPairs.push({ parent_sku_id: parentSkuId, accessory_sku_id: acc.id, sort_order: sortOrder });

      // Update variant_type and sell_by
      if (acc.variant_type !== 'accessory' || acc.sell_by !== 'unit') {
        const updates = [];
        if (acc.variant_type !== 'accessory') { updates.push("variant_type = 'accessory'"); typed++; }
        if (acc.sell_by !== 'unit') { updates.push("sell_by = 'unit'"); sellByFixed++; }
        if (!DRY_RUN && updates.length) {
          await client.query(`UPDATE skus SET ${updates.join(', ')} WHERE id = $1`, [acc.id]);
        }
      }

      // Activate if inactive
      if (acc.status === 'inactive') {
        if (!DRY_RUN) {
          await client.query(`UPDATE skus SET status = 'active' WHERE id = $1`, [acc.id]);
        }
        activated++;
      }
    }

    // 4. Insert links (deduped)
    if (!DRY_RUN && linkPairs.length > 0) {
      // Clear existing Paradigm accessory links first
      const accIds = linkPairs.map(p => p.accessory_sku_id);
      await client.query(`DELETE FROM sku_accessories WHERE accessory_sku_id = ANY($1)`, [accIds]);

      for (const pair of linkPairs) {
        await client.query(`
          INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING
        `, [pair.parent_sku_id, pair.accessory_sku_id, pair.sort_order]);
        linked++;
      }
    } else {
      linked = linkPairs.length;
    }

    // 5. Activate accessory products that have active SKUs
    if (!DRY_RUN) {
      await client.query(`
        UPDATE products SET status = 'active'
        WHERE status = 'inactive'
        AND id IN (
          SELECT DISTINCT s.product_id FROM skus s
          WHERE s.status = 'active' AND s.variant_type = 'accessory'
          AND s.product_id IN (
            SELECT p.id FROM products p
            JOIN vendors v ON v.id = p.vendor_id
            WHERE v.name = 'Tri-West'
            AND (p.name ILIKE 'End Cap%' OR p.name ILIKE 'Flush Stair%'
                 OR p.name ILIKE 'Overlap Stair%' OR p.name ILIKE 'Quarter Round%'
                 OR p.name ILIKE 'Reducer%' OR p.name ILIKE 'T-molding%'
                 OR p.name ILIKE 'Threshold%')
          )
        )
      `);
    }

    // 6. Also fix the already-active Conquest/Odyssey accessories
    if (!DRY_RUN) {
      await client.query(`
        UPDATE skus SET variant_type = 'accessory', sell_by = 'unit'
        WHERE variant_type IS DISTINCT FROM 'accessory'
        AND product_id IN (
          SELECT id FROM products
          WHERE name ILIKE 'Conquest Fabricated%'
             OR name ILIKE 'Odyssey Bullnose%'
             OR name ILIKE 'Odyssey Flush%'
        )
      `);
    }

    console.log(`\n--- Summary ${DRY_RUN ? '(DRY RUN)' : ''} ---`);
    console.log(`Accessory links created: ${linked}`);
    console.log(`SKUs activated: ${activated}`);
    console.log(`variant_type set to accessory: ${typed}`);
    console.log(`sell_by fixed to unit: ${sellByFixed}`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
