/**
 * MSI Insert Discovered Images
 *
 * Inserts CDN image URLs discovered through systematic probing into the database.
 * Maps vendor_sku -> CDN URL for products that were missing images.
 * Also runs collection-level inheritance for remaining unmatched products.
 *
 * Usage: node backend/scripts/msi-insert-discovered-images.cjs [--dry-run]
 */

const { Pool } = require('pg');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const CDN = 'https://cdn.msisurfaces.com/images';
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ── Discovered CDN URL mappings ──────────────────────────────────────────
// Format: vendor_sku -> array of CDN image URLs (first = primary)

const SKU_IMAGE_MAP = {
  // ═══ MOSAICS (25 products) ═══
  'SMOT-GLS-AKOPEAHEX6MM': [`${CDN}/mosaics/thumbnails/akoya-pearl-hexagon-mosaic-tile.jpg`],
  'SMOT-SGLSMT-BAYVIEW10MM': [`${CDN}/mosaics/thumbnails/bayview-elongated-octagon-10mm.jpg`],
  'SMOT-GLSMTIL-BIM4MM': [`${CDN}/mosaics/thumbnails/bimini-interlocking-4mm.jpg`],
  'SMOT-PEB-DORADO': [`${CDN}/mosaics/thumbnails/dorado-pebble-tumbled-10mm.jpg`],
  'SMOT-SGLSIL-EVICE8MM': [`${CDN}/mosaics/thumbnails/evita-ice-interlocking-8mm.jpg`],
  'SMOT-GLSBIL-GROAZU6MM': [`${CDN}/mosaics/thumbnails/grotta-azzura-interlocking-6mm.jpg`],
  'SMOT-GLSIL-HARCEL6MM': [`${CDN}/mosaics/thumbnails/harbor-celeste-interlocking-6mm.jpg`],
  'SMOT-SGLSIL-KG6MM': [`${CDN}/mosaics/thumbnails/kings-gate-interlocking-pattern-6mm.jpg`],
  'SMOT-GLSP-LYNX8MM': [`${CDN}/mosaics/thumbnails/lynx-pattern-8mm.jpg`, `${CDN}/mosaics/thumbnails/bianco-dolomite-lynx-polished.jpg`],
  'SMOT-SGLS-MAG6MM': [`${CDN}/mosaics/thumbnails/magica-pattern-6mm.jpg`],
  'SMOT-SGLSIL-ROC8MM': [`${CDN}/mosaics/thumbnails/rocklin-interlocking-8mm.jpg`],
  'SMOT-GLSMTIL-SEAGLA4MM': [`${CDN}/mosaics/thumbnails/seaglass-interlocking-4mm.jpg`],
  'SMOT-GLSIL-SILVA6MM': [`${CDN}/mosaics/thumbnails/silva-oak-interlocking-6mm.jpg`],
  'SMOT-GLSPK-SILVA6MM': [`${CDN}/mosaics/thumbnails/silva-oak-picket-6mm.jpg`],
  'SMOT-SGLS-SOHSTA8MM': [`${CDN}/mosaics/thumbnails/soho-stax-8mm.jpg`],
  'SMOT-SGLSIL-SONVAL4MM': [`${CDN}/mosaics/thumbnails/sonoma-valley-interlocking-4mm.jpg`],
  'SMOT-GLS-STACEL6MM': [`${CDN}/mosaics/thumbnails/statuario-celano-hexagon-6mm.jpg`],
  'SMOT-GLS-STACEL36': [`${CDN}/mosaics/thumbnails/statuario-celano-picket-6mm.jpg`],
  'SMOT-GLSIL-STACEL6MM': [`${CDN}/mosaics/thumbnails/statuario-celano-interlocking-6mm.jpg`],
  'SMOT-GLSIL-SUPNOV8MM': [`${CDN}/mosaics/thumbnails/super-nova-interlocking-8mm.jpg`],
  'SMOT-TETBLA-10MM': [`${CDN}/mosaics/thumbnails/tetris-blanco-10mm.jpg`],
  'SMOT-TETNERO-10MM': [`${CDN}/mosaics/thumbnails/tetris-nero-10mm.jpg`],
  'SMOT-GLSST-VERDE8MM': [`${CDN}/mosaics/thumbnails/verde-subway-2x6x8mm.jpg`],
  'SMOT-GLSIL-ZODIA6MM': [`${CDN}/mosaics/thumbnails/zodia-interlocking-6mm.jpg`],

  // ═══ LVP - Shorecliffs (7 products) ═══
  'VTLBRUWOO9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-brundinson-wood.jpg`],
  'VTLHOUTRA9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-houston-trail.jpg`],
  'VTLROGHAN9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-roghan.jpg`],
  'VTLSCHOAK9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-schertz-oak.jpg`],
  'VTLSUNSHA9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-sunny-shake.jpg`],
  'VTLWALBLO9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-wallingford-blonde.jpg`],
  'VTLWIXVAL9X87-12MM': [`${CDN}/lvt/detail/shorecliffs-wixom-valley.jpg`],

  // ═══ PORCELAIN - Exotika (8 SKUs) ═══
  'NALU2448P': [`${CDN}/porcelainceramic/thumbnails/exotika-alura-porcelain.jpg`],
  'NBIO2448P': [`${CDN}/porcelainceramic/thumbnails/exotika-biotite-porcelain.jpg`],
  'NTOU2448P': [`${CDN}/porcelainceramic/thumbnails/exotika-tourmaline-porcelain.jpg`],
  'NVERVIV2448P': [`${CDN}/porcelainceramic/thumbnails/exotika-verde-vivo-porcelain.jpg`],
  'NVIO2448P': [`${CDN}/porcelainceramic/thumbnails/exotika-violetta-porcelain.jpg`],
  'NWGLUXICEWHI2448P': [`${CDN}/porcelainceramic/thumbnails/exotika-lux-iceberg-porcelain.jpg`],
  'NWGLUXICEWHI4848P': [`${CDN}/porcelainceramic/thumbnails/exotika-lux-iceberg-porcelain.jpg`],

  // ═══ PORCELAIN - Trinity (1 SKU) ═══
  'NWGCON8X8': [`${CDN}/porcelainceramic/thumbnails/constantino-trinity-porcelain.jpg`],

  // ═══ STACKED STONE - Terrado (8 SKUs) ═══
  'LPNLECOPASH4COR': [`${CDN}/hardscaping/detail/copen-ash-terrado-stacked-stone-panels.jpg`],
  'LPNLECOPASH6': [`${CDN}/hardscaping/detail/copen-ash-terrado-stacked-stone-panels.jpg`],
  'LPNLECOPSNO4COR': [`${CDN}/hardscaping/detail/copen-snow-terrado-stacked-stone-panels.jpg`],
  'LPNLECOPSNO6': [`${CDN}/hardscaping/detail/copen-snow-terrado-stacked-stone-panels.jpg`],
  'LPNLEDENANT4COR': [`${CDN}/hardscaping/detail/denali-anthracite-terrado-stacked-stone-panels.jpg`],
  'LPNLEDENANT6': [`${CDN}/hardscaping/detail/denali-anthracite-terrado-stacked-stone-panels.jpg`],
  'LPNLEDENGRY4COR': [`${CDN}/hardscaping/detail/denali-grey-terrado-stacked-stone-panels.jpg`],
  'LPNLEDENGRY6': [`${CDN}/hardscaping/detail/denali-grey-terrado-stacked-stone-panels.jpg`],

  // ═══ NATURAL STONE (7 SKUs) ═══
  'SMOT-CAR-1X3HBP': [`${CDN}/mosaics/thumbnails/carrara-white-1x3-herringbone-polished.jpg`],
  'TTPICASSO-PAT-HUCB': [`${CDN}/colornames/picasso-travertine.jpg`],
  'SMOT-TUNGRY-BWP': [`${CDN}/colornames/tundra-gray-marble.jpg`],
  'TTUNGRY1212P': [`${CDN}/colornames/tundra-gray-marble.jpg`],
  'TTUNGRY1224P': [`${CDN}/colornames/tundra-gray-marble.jpg`],
  'TTUNGRY1818P': [`${CDN}/colornames/tundra-gray-marble.jpg`],
};

async function main() {
  const log = (msg) => console.log(msg);
  log('MSI Insert Discovered Images');
  log('='.repeat(60));
  if (DRY_RUN) log('DRY RUN - no changes will be made');

  let inserted = 0;
  let skipped = 0;
  let skusMissing = 0;

  // Phase 1: Insert discovered CDN images
  log('\n--- Phase 1: Insert discovered CDN images ---');

  for (const [vendorSku, urls] of Object.entries(SKU_IMAGE_MAP)) {
    // Find the SKU
    const { rows: skus } = await pool.query(
      `SELECT s.id as sku_id, s.product_id, p.name
       FROM skus s JOIN products p ON s.product_id = p.id
       WHERE s.vendor_sku = $1 AND p.vendor_id = $2 AND s.status = 'active'`,
      [vendorSku, VENDOR_ID]
    );

    if (skus.length === 0) {
      log(`  SKIP: ${vendorSku} - SKU not found`);
      skusMissing++;
      continue;
    }

    const sku = skus[0];

    // Check if SKU already has images
    const { rows: existing } = await pool.query(
      'SELECT id FROM media_assets WHERE sku_id = $1 LIMIT 1',
      [sku.sku_id]
    );

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    // Insert images
    for (let i = 0; i < urls.length; i++) {
      const assetType = i === 0 ? 'primary' : 'alternate';
      if (!DRY_RUN) {
        await pool.query(`
          INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
          VALUES ($1, $2, $3, $4, $4, $5, NOW())
          ON CONFLICT DO NOTHING
        `, [sku.product_id, sku.sku_id, assetType, urls[i], i]);
      }
      inserted++;
    }
    log(`  + ${sku.name} (${vendorSku}) -> ${urls.length} image(s)`);
  }

  log(`\nPhase 1 results: ${inserted} images inserted, ${skipped} already had images, ${skusMissing} SKUs not found`);

  // Phase 2: Collection-level inheritance for remaining missing SKUs
  log('\n--- Phase 2: Collection inheritance ---');

  const { rows: missing } = await pool.query(`
    SELECT DISTINCT p.id as product_id, p.name, p.collection, c.slug as category
    FROM products p
    JOIN skus s ON s.product_id = p.id
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND ma.id IS NULL AND s.status = 'active'
    ORDER BY c.slug, p.collection, p.name
  `, [VENDOR_ID]);

  log(`${missing.length} products still missing images`);

  let inherited = 0;
  let inheritedImages = 0;

  for (const prod of missing) {
    let donorImages = null;

    // Strategy 1: Same collection, same category
    if (prod.collection) {
      const { rows } = await pool.query(`
        SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
        FROM products p
        JOIN skus s ON s.product_id = p.id
        JOIN media_assets ma ON ma.sku_id = s.id
        JOIN categories c ON c.id = p.category_id
        WHERE p.vendor_id = $1 AND p.id != $2
          AND p.collection = $3 AND c.slug = $4
        ORDER BY ma.sort_order LIMIT 3
      `, [VENDOR_ID, prod.product_id, prod.collection, prod.category]);
      if (rows.length > 0) donorImages = rows;
    }

    // Strategy 2: Name prefix match (at least 2 words)
    if (!donorImages) {
      const words = prod.name.split(/\s+/).filter(w => w.length >= 2);
      for (let len = Math.min(words.length, 3); len >= 2; len--) {
        const prefix = words.slice(0, len).join(' ');
        const { rows } = await pool.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products p
          JOIN skus s ON s.product_id = p.id
          JOIN media_assets ma ON ma.sku_id = s.id
          WHERE p.vendor_id = $1 AND p.id != $2
            AND LOWER(p.name) LIKE $3
          ORDER BY ma.sort_order LIMIT 3
        `, [VENDOR_ID, prod.product_id, prefix.toLowerCase() + '%']);
        if (rows.length > 0) { donorImages = rows; break; }
      }
    }

    // Strategy 3: Same category, first word match
    if (!donorImages) {
      const firstWord = prod.name.split(/\s+/)[0];
      if (firstWord && firstWord.length >= 3) {
        const { rows } = await pool.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products p
          JOIN skus s ON s.product_id = p.id
          JOIN media_assets ma ON ma.sku_id = s.id
          JOIN categories c ON c.id = p.category_id
          WHERE p.vendor_id = $1 AND p.id != $2
            AND LOWER(p.name) LIKE $3 AND c.slug = $4
          ORDER BY ma.sort_order LIMIT 3
        `, [VENDOR_ID, prod.product_id, firstWord.toLowerCase() + '%', prod.category]);
        if (rows.length > 0) donorImages = rows;
      }
    }

    if (donorImages) {
      inherited++;
      const { rows: skus } = await pool.query(
        'SELECT id FROM skus WHERE product_id = $1 AND status = $2',
        [prod.product_id, 'active']
      );
      for (const sku of skus) {
        let sortOrder = 0;
        for (const img of donorImages) {
          if (!DRY_RUN) {
            await pool.query(`
              INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, created_at)
              VALUES ($1, $2, $3, $4, $4, $5, NOW())
              ON CONFLICT DO NOTHING
            `, [prod.product_id, sku.id, sortOrder === 0 ? 'primary' : 'alternate', img.url, sortOrder]);
          }
          inheritedImages++;
          sortOrder++;
        }
      }
      log(`  + [${prod.category}] ${prod.name} (${prod.collection}) -> inherited ${donorImages.length} images`);
    } else {
      log(`  - [${prod.category}] ${prod.name} (${prod.collection}) -> NO DONOR`);
    }
  }

  log(`\nPhase 2 results: ${inherited} products inherited, ${inheritedImages} images created`);

  // Final coverage report
  log('\n--- Final Coverage ---');
  const { rows: coverage } = await pool.query(`
    SELECT c.slug,
      COUNT(DISTINCT s.id) as total,
      COUNT(DISTINCT CASE WHEN ma.id IS NOT NULL THEN s.id END) as with_img
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id
    WHERE p.vendor_id = $1 AND s.status = 'active'
    GROUP BY c.slug ORDER BY total DESC
  `, [VENDOR_ID]);

  let totalSkus = 0, totalWithImages = 0;
  for (const row of coverage) {
    const pct = (100 * row.with_img / row.total).toFixed(1);
    log(`  ${row.slug || 'unknown'}: ${row.with_img}/${row.total} (${pct}%)`);
    totalSkus += parseInt(row.total);
    totalWithImages += parseInt(row.with_img);
  }

  log('');
  log('='.repeat(60));
  log(`  Phase 1 direct: ${inserted} images`);
  log(`  Phase 2 inherited: ${inheritedImages} images`);
  log(`  Total coverage: ${totalWithImages}/${totalSkus} (${(100*totalWithImages/totalSkus).toFixed(1)}%)`);
  log(`  Still missing: ${totalSkus - totalWithImages}`);
  log('='.repeat(60));

  // List remaining missing
  if (totalSkus - totalWithImages > 0) {
    log('\n--- Remaining missing products ---');
    const { rows: stillMissing } = await pool.query(`
      SELECT p.name, p.collection, c.slug as category, s.vendor_sku
      FROM skus s
      JOIN products p ON s.product_id = p.id
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN media_assets ma ON ma.sku_id = s.id
      WHERE p.vendor_id = $1 AND s.status = 'active' AND ma.id IS NULL
      ORDER BY c.slug, p.name
    `, [VENDOR_ID]);
    for (const row of stillMissing) {
      log(`  [${row.category}] ${row.name} (${row.collection}) - ${row.vendor_sku}`);
    }
  }

  await pool.end();
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
