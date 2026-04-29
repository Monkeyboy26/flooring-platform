#!/usr/bin/env node
/**
 * attach-provenza-accessories.cjs
 *
 * Moves 656 Provenza accessory SKUs from the flat "Provenza Floors Inc."
 * collection into the correct "Provenza - <Collection>" flooring products.
 *
 * Two groups of accessories:
 *   A. "Modessa Collection ..." — route directly to Provenza - Modessa
 *   B. Generic "Provenza End Cap", "Quarter Round", etc. — match by color name
 *
 * Since 832 flooring has MORE colors than website-scraped data, we also
 * build a cross-reference: 832 flooring color → target Provenza collection
 * using product name patterns (e.g., "Moda Living Wpf-lvp..." → Provenza - Moda Living).
 *
 * Usage:
 *   node backend/scripts/attach-provenza-accessories.cjs --dry-run
 *   node backend/scripts/attach-provenza-accessories.cjs
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@db:5432/flooring_pim' });

const DRY_RUN = process.argv.includes('--dry-run');

/* ── helpers ─────────────────────────────────────────────────────── */

function norm(s) {
  return s
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '')        // strip parentheticals
    .replace(/[\/]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .replace(/[\s-]european\s*oak$/i, '')  // strip species (hyphen or space)
    .replace(/[\s-]white\s*oak$/i, '')
    .replace(/[\s-]oak$/i, '')
    .replace(/[\s-]hickory$/i, '')
    .replace(/hour\s*glass/g, 'hourglass') // normalize "Hour Glass" → "Hourglass"
    .replace(/\s+/g, ' ')
    .trim();
}

function baseColor(s) {
  return norm(s).split('-')[0].trim();
}

async function main() {
  const client = await pool.connect();

  try {
    // 1. Get vendor ID
    const { rows: [tw] } = await client.query(`SELECT id FROM vendors WHERE code = 'TW'`);
    if (!tw) { console.error('Tri-West vendor not found'); return; }
    const vendorId = tw.id;

    // 2. Load Provenza flooring SKUs (target products)
    const { rows: floorSkus } = await client.query(`
      SELECT s.id as sku_id, s.variant_name, s.product_id, p.name as product_name, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.collection LIKE 'Provenza - %'
        AND s.variant_type IS DISTINCT FROM 'accessory'
    `);

    console.log(`Loaded ${floorSkus.length} Provenza flooring SKUs across ${new Set(floorSkus.map(f => f.collection)).size} collections`);

    // Build color → product lookup
    const colorToProduct = new Map();  // normalized color → { product_id, product_name, collection }
    const baseToProduct = new Map();

    for (const f of floorSkus) {
      const n = norm(f.variant_name);
      const b = baseColor(f.variant_name);
      if (n && !colorToProduct.has(n)) {
        colorToProduct.set(n, { product_id: f.product_id, product_name: f.product_name, collection: f.collection });
      }
      if (b && !baseToProduct.has(b)) {
        baseToProduct.set(b, { product_id: f.product_id, product_name: f.product_name, collection: f.collection });
      }
    }

    console.log(`Color index (website): ${colorToProduct.size} exact, ${baseToProduct.size} base`);

    // 2b. Cross-reference: 832 flooring SKUs → Provenza - X collections
    //     The 832 has more colors than the website scraper captured.
    //     Map 832 product names to the target Provenza - X collection.
    const ediNameToCollection = {
      'affinity coll':             'Provenza - Affinity',
      'antico coll':               'Provenza - Antico',
      'concorde oak':              'Provenza - Concorde Oak',
      'grand pompeii coll':        'Provenza - Grand Pompeii',
      'lighthouse cove':           'Provenza - Lighthouse Cove',
      'lugano coll':               'Provenza - Lugano',
      'mateus coll':               'Provenza - Old World',     // Mateus = Old World collection
      'moda living elite':         'Provenza - Moda Living Elite',
      'moda living wpf':           'Provenza - Moda Living',
      'moda living':               'Provenza - Moda Living',
      'modessa collection':        'Provenza - Modessa',
      'new wave collection':       'Provenza - New Wave',
      'nyc loft coll':             'Provenza - New York Loft',
      'opia collection':           'Provenza - Opia',
      'stonescape':                'Provenza - Stonescape',
      'tresor collection':         'Provenza - Tresor',
      'uptown chic':               'Provenza - Uptown Chic',
      'vitali elite':              'Provenza - Vitali Elite',
      'vitali collection':         'Provenza - Vitali',
      'volterra coll':             'Provenza - Volterra',
    };

    // Build collection → product_id lookup for target products
    const collToProductId = new Map();
    for (const f of floorSkus) {
      if (!collToProductId.has(f.collection)) {
        collToProductId.set(f.collection, { product_id: f.product_id, product_name: f.product_name });
      }
    }

    // Load 832 flooring SKUs and cross-reference their colors
    const { rows: ediFloorSkus } = await client.query(`
      SELECT s.variant_name, p.name as product_name
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND p.collection = 'Provenza Floors Inc.'
        AND s.variant_type IS DISTINCT FROM 'accessory'
    `, [vendorId]);

    let ediIndexed = 0;
    for (const ef of ediFloorSkus) {
      const pn = ef.product_name.toLowerCase();
      let targetColl = null;

      // Find matching collection by product name prefix
      for (const [prefix, coll] of Object.entries(ediNameToCollection)) {
        if (pn.startsWith(prefix)) {
          targetColl = coll;
          break;
        }
      }

      if (targetColl && collToProductId.has(targetColl)) {
        const target = collToProductId.get(targetColl);
        const n = norm(ef.variant_name);
        const b = baseColor(ef.variant_name);

        // Only add if not already indexed from website data
        if (n && !colorToProduct.has(n)) {
          colorToProduct.set(n, target);
          ediIndexed++;
        }
        if (b && !baseToProduct.has(b)) {
          baseToProduct.set(b, target);
        }
      }
    }

    console.log(`Color index (+ 832 xref): ${colorToProduct.size} exact, ${baseToProduct.size} base (+${ediIndexed} from 832)`);

    // Modessa product_id for direct routing
    const modessaProduct = floorSkus.find(f => f.collection === 'Provenza - Modessa');
    const modessaProductId = modessaProduct ? modessaProduct.product_id : null;
    const modessaProductName = modessaProduct ? modessaProduct.product_name : null;
    if (modessaProductId) {
      console.log(`Modessa target: ${modessaProductName} (${modessaProductId})`);
    }

    // 3. Load Provenza accessory SKUs
    const { rows: accSkus } = await client.query(`
      SELECT s.id as sku_id, s.variant_name, s.product_id as old_product_id,
             p.name as old_product_name, s.variant_type
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1
        AND p.collection = 'Provenza Floors Inc.'
        AND (s.variant_type = 'accessory'
             OR p.name ILIKE '%quarter round%' OR p.name ILIKE '%reducer%'
             OR p.name ILIKE '%end cap%' OR p.name ILIKE '%t-molding%' OR p.name ILIKE '%t-moulding%'
             OR p.name ILIKE '%stairnose%' OR p.name ILIKE '%stair nose%' OR p.name ILIKE '%stair ns%'
             OR p.name ILIKE '%sq.nose%' OR p.name ILIKE '%square nose%'
             OR p.name ILIKE '%overlap stair%')
      ORDER BY p.name, s.variant_name
    `, [vendorId]);

    console.log(`Found ${accSkus.length} Provenza accessory SKUs to process`);

    // 4. Match each accessory to a flooring product
    let matched = 0, unmatched = 0;
    const moves = [];
    const nomatch = [];

    for (const acc of accSkus) {
      const color = acc.variant_name;
      const oldName = acc.old_product_name.toLowerCase();
      let target = null;
      let reason = '';

      // Strategy 1: Modessa-specific products route directly
      if (oldName.includes('modessa')) {
        if (modessaProductId) {
          target = { product_id: modessaProductId, product_name: modessaProductName };
          reason = 'collection-route: Modessa';
        }
      }

      // Strategy 2: Color-name matching
      if (!target) {
        const n = norm(color);
        const b = baseColor(color);

        if (colorToProduct.has(n)) {
          target = colorToProduct.get(n);
          reason = `color-exact: "${n}"`;
        } else if (baseToProduct.has(b)) {
          target = baseToProduct.get(b);
          reason = `color-base: "${b}"`;
        }

        // Strategy 3: Compound color names
        if (!target && /[,\/]/.test(color)) {
          const parts = color.split(/[,\/]/).map(p => p.trim());
          for (const part of parts) {
            const pn = norm(part);
            const pb = baseColor(part);
            if (colorToProduct.has(pn)) {
              target = colorToProduct.get(pn);
              reason = `color-compound: "${pn}"`;
              break;
            }
            if (baseToProduct.has(pb)) {
              target = baseToProduct.get(pb);
              reason = `color-compound-base: "${pb}"`;
              break;
            }
          }
        }
      }

      if (target && target.product_id) {
        moves.push({
          sku_id: acc.sku_id,
          old_product_id: acc.old_product_id,
          new_product_id: target.product_id,
          new_product_name: target.product_name,
          color,
          reason
        });
        matched++;
      } else {
        nomatch.push({ sku_id: acc.sku_id, color, old_product_name: acc.old_product_name });
        unmatched++;
      }
    }

    console.log(`\nMatched: ${matched}, Unmatched: ${unmatched}`);

    // Show matches by target product
    const byProduct = {};
    for (const m of moves) {
      byProduct[m.new_product_name] = (byProduct[m.new_product_name] || 0) + 1;
    }
    console.log('\nAccessories per target product:');
    for (const [name, count] of Object.entries(byProduct).sort()) {
      console.log(`  ${name}: ${count}`);
    }

    if (nomatch.length > 0) {
      console.log(`\nUnmatched accessories (${nomatch.length}):`);
      for (const n of nomatch.slice(0, 30)) {
        console.log(`  "${n.color}" from "${n.old_product_name}"`);
      }
      if (nomatch.length > 30) console.log(`  ... and ${nomatch.length - 30} more`);
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] No changes made.');
      return;
    }

    // 5. Execute moves in a transaction
    await client.query('BEGIN');

    for (const m of moves) {
      await client.query(`
        UPDATE skus SET product_id = $1, variant_type = 'accessory', sell_by = 'unit'
        WHERE id = $2
      `, [m.new_product_id, m.sku_id]);

      await client.query(`
        UPDATE media_assets SET product_id = $1
        WHERE sku_id = $2
      `, [m.new_product_id, m.sku_id]);
    }

    await client.query('COMMIT');
    console.log(`\nMoved ${moves.length} accessory SKUs to Provenza products.`);

    // 6. Clean up empty "Provenza Floors Inc." products
    const { rows: orphans } = await client.query(`
      SELECT p.id, p.name
      FROM products p
      LEFT JOIN skus s ON s.product_id = p.id
      WHERE p.vendor_id = $1
        AND p.collection = 'Provenza Floors Inc.'
        AND s.id IS NULL
    `, [vendorId]);

    if (orphans.length > 0) {
      console.log(`\nOrphaned products to clean up: ${orphans.length}`);
      for (const o of orphans) {
        console.log(`  Deleting: ${o.name}`);
        await client.query(`DELETE FROM media_assets WHERE product_id = $1`, [o.id]);
        await client.query(`DELETE FROM products WHERE id = $1`, [o.id]);
      }
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
