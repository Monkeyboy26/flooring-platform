/**
 * Split combined "Glossy & Matte" SKUs into separate Glossy and Matte variants.
 *
 * For each "Glossy & Matte" SKU:
 *   1. Rename original to "Glossy" (keep existing vendor_sku/internal_sku)
 *   2. Create new "Matte" SKU with new vendor_sku/internal_sku
 *   3. Copy pricing, packaging, and attributes
 *   4. Add "finish" attribute to both (Glossy / Matte)
 *
 * Run: docker compose exec api node scripts/split-glossy-matte.cjs [--dry-run]
 * Then re-run: docker compose exec api node scrapers/unicorn.js --force
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all combined "Glossy & Matte" SKUs for Unicorn Tile Corp
    const { rows: combined } = await client.query(`
      SELECT s.id, s.product_id, s.vendor_sku, s.internal_sku, s.variant_name,
             s.sell_by, s.variant_type, s.is_sample, s.status
      FROM skus s
      JOIN products p ON p.id = s.product_id
      JOIN vendors v ON v.id = p.vendor_id
      WHERE v.name = 'Unicorn Tile Corp'
        AND s.variant_name LIKE '%Glossy & Matte%'
      ORDER BY s.variant_name
    `);

    console.log(`Found ${combined.length} combined "Glossy & Matte" SKUs to split\n`);

    let created = 0, renamed = 0, skipped = 0;

    for (const sku of combined) {
      const origName = sku.variant_name;

      // Build Glossy and Matte variant names
      // "White Glossy & Matte 3x12" → "White Glossy 3x12" + "White Matte 3x12"
      // "Picket Glossy & Matte 3x12" → "Picket Glossy 3x12" + "Picket Matte 3x12"
      // "Jolly Glossy & Matte" → "Jolly Glossy" + "Jolly Matte"
      // "Covebase Glossy & Matte" → "Covebase Glossy" + "Covebase Matte"
      // "White Bullnose Glossy & Matte" → "White Bullnose Glossy" + "White Bullnose Matte"
      const glossyName = origName.replace('Glossy & Matte', 'Glossy');
      const matteName = origName.replace('Glossy & Matte', 'Matte');

      // Generate Matte vendor_sku from original
      // Original pattern: UN-{SERIES}-{COLOR_FIRST6}-{SIZE}
      // "Glossy & Matte" → genSku used first 6 chars of cleaned color
      // e.g. "WHITEG" from "WHITEGLOSSYMATTE" for Glossy
      //      "WHITEM" from "WHITEMATTE" for Matte
      // Strategy: replace the 'G' suffix with 'M' in the color portion
      const matteVendorSku = generateMatteSku(sku.vendor_sku, origName);
      const matteInternalSku = matteVendorSku; // Same convention

      // Check if Matte SKU already exists
      const { rows: existing } = await client.query(
        `SELECT id FROM skus WHERE internal_sku = $1`, [matteInternalSku]
      );
      if (existing.length > 0) {
        console.log(`  SKIP ${origName} — Matte SKU ${matteInternalSku} already exists`);
        skipped++;
        continue;
      }

      console.log(`  ${origName}`);
      console.log(`    Glossy: ${glossyName} (${sku.vendor_sku})`);
      console.log(`    Matte:  ${matteName} (${matteVendorSku})`);

      if (DRY_RUN) { created++; renamed++; continue; }

      // 1. Rename original SKU to Glossy
      await client.query(`
        UPDATE skus SET variant_name = $1 WHERE id = $2
      `, [glossyName, sku.id]);
      renamed++;

      // 2. Create new Matte SKU
      const { rows: [newSku] } = await client.query(`
        INSERT INTO skus (id, product_id, vendor_sku, internal_sku, variant_name,
                          sell_by, variant_type, is_sample, status)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id
      `, [sku.product_id, matteVendorSku, matteInternalSku, matteName,
          sku.sell_by, sku.variant_type, sku.is_sample, sku.status]);
      const newSkuId = newSku.id;
      created++;

      // 3. Copy pricing
      const { rows: pricing } = await client.query(
        `SELECT cost, retail_price, price_basis, sale_price, sale_ends_at FROM pricing WHERE sku_id = $1`,
        [sku.id]
      );
      if (pricing.length > 0) {
        const pr = pricing[0];
        await client.query(`
          INSERT INTO pricing (sku_id, cost, retail_price, price_basis, sale_price, sale_ends_at)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (sku_id) DO NOTHING
        `, [newSkuId, pr.cost, pr.retail_price, pr.price_basis, pr.sale_price, pr.sale_ends_at]);
      }

      // 4. Copy packaging
      const { rows: packaging } = await client.query(
        `SELECT pieces_per_box, sqft_per_box, weight_per_box_lbs, boxes_per_pallet FROM packaging WHERE sku_id = $1`,
        [sku.id]
      );
      if (packaging.length > 0) {
        const pk = packaging[0];
        await client.query(`
          INSERT INTO packaging (sku_id, pieces_per_box, sqft_per_box, weight_per_box_lbs, boxes_per_pallet)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (sku_id) DO NOTHING
        `, [newSkuId, pk.pieces_per_box, pk.sqft_per_box, pk.weight_per_box_lbs, pk.boxes_per_pallet]);
      }

      // 5. Copy attributes from original (size, color, etc.)
      const { rows: attrs } = await client.query(`
        SELECT attribute_id, value FROM sku_attributes WHERE sku_id = $1
      `, [sku.id]);
      for (const attr of attrs) {
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, $3)
          ON CONFLICT (sku_id, attribute_id) DO NOTHING
        `, [newSkuId, attr.attribute_id, attr.value]);
      }

      // 6. Add "finish" attribute to both SKUs
      const { rows: [finishAttr] } = await client.query(
        `SELECT id FROM attributes WHERE slug = 'finish'`
      );
      if (finishAttr) {
        // Glossy finish for original
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, 'Glossy')
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = 'Glossy'
        `, [sku.id, finishAttr.id]);
        // Matte finish for new
        await client.query(`
          INSERT INTO sku_attributes (sku_id, attribute_id, value)
          VALUES ($1, $2, 'Matte')
          ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = 'Matte'
        `, [newSkuId, finishAttr.id]);
      }
    }

    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Would rename ${renamed} SKUs, create ${created} new Matte SKUs, skip ${skipped}`);
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log(`\nDone: renamed ${renamed} SKUs to Glossy, created ${created} new Matte SKUs, skipped ${skipped}`);
      console.log('Now re-run the image scraper: docker compose exec api node scrapers/unicorn.js --force');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Generate a Matte vendor_sku from the original combined one.
 *
 * Examples:
 *   UN-ARTE-WHITEG-3X12 → UN-ARTE-WHITEM-3X12   (White Glossy & Matte)
 *   UN-SHADE-CREMAG-3X12 → UN-SHADE-CREMAM-3X12  (Crema Glossy & Matte)
 *   UN-NOX-COVEBA-6X6 → UN-NOX-COVEBM-6X6       (Covebase Glossy & Matte)
 *   UN-SILOM-ETOILE-12X24 → UN-SILOM-ETOILM-12X24 (Etoile Glossy & Matte)
 *   UN-SILOM-WHITEB-3X12 → UN-SILOM-WHITBM-3X12  (White Bullnose Glossy & Matte)
 *
 * Strategy: the original genSku takes the first 6 chars of the cleaned color.
 * For "White Glossy & Matte" → cleaned "WHITEGLOSSYMATTE" → first 6 → "WHITEG"
 * For matte we want "White Matte" → cleaned "WHITEMATTE" → first 6 → "WHITEM"
 *
 * We regenerate using the same logic but with the matte-only variant name.
 */
function generateMatteSku(origSku, origVariantName) {
  // Parse the original SKU: UN-SERIES-COLOR6-SIZE or UN-SERIES-COLOR6
  const parts = origSku.split('-');
  const prefix = parts[0]; // UN or DR
  const series = parts[1]; // ARTE, SHADE, etc.
  const origColor6 = parts[2]; // e.g., WHITEG, COVEBA, ETOILE
  const origSize = parts.slice(3).join('-'); // e.g., "3X12", "6X6", "5/8X12"

  // Generate matte color6 from the matte variant name
  const matteName = origVariantName.replace('Glossy & Matte', 'Matte');
  const sizeMatch = matteName.match(/\d+[x\/]\d+.*/i);
  const colorPart = sizeMatch
    ? matteName.substring(0, sizeMatch.index).trim()
    : matteName.trim();
  let matteColor6 = colorPart.toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 6);

  // If matte color6 collides with original (e.g., COVEBA from both
  // "Covebase Glossy & Matte" and "Covebase Matte"), add M suffix
  if (matteColor6 === origColor6) {
    // Truncate to 5 and append M
    matteColor6 = origColor6.substring(0, 5) + 'M';
  }

  if (origSize) {
    return `${prefix}-${series}-${matteColor6}-${origSize}`;
  } else {
    return `${prefix}-${series}-${matteColor6}`;
  }
}

run().catch(err => { console.error(err); process.exit(1); });
