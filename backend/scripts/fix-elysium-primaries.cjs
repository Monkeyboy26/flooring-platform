/**
 * Fix Elysium lifestyle images incorrectly stored as primary asset_type.
 *
 * Visual audit of 522 Elysium primary photos identified 57 products where
 * lifestyle/room-scene photos are used as the primary product image, plus
 * 4 broken images. These slipped through automated detection because their
 * filenames lack recognizable lifestyle keywords.
 *
 * Two-phase fix (same pattern as fix-lifestyle-primaries.cjs):
 *   Phase 1: Products that have a lifestyle primary AND a non-lifestyle alternate —
 *            swap them (promote alternate to primary, demote primary to lifestyle).
 *   Phase 2: Products that ONLY have a lifestyle primary (no alternate to swap) —
 *            reclassify the primary to 'lifestyle'.
 *
 * Also handles 4 broken images (missing/404) and product-level primaries.
 *
 * HISTORY:
 *   Round 1: 57 targets from initial visual audit → script run
 *   Round 2: 15 more targets from aspect-ratio screening → script run
 *   Round 3: 11 stubborn products still showing lifestyle after rounds 1-2.
 *            The isLifestyleUrl() keyword check can't detect Elysium lifestyle images,
 *            so the script kept cycling between lifestyle images. Fixed via direct SQL
 *            targeting specific media_asset IDs based on visual confirmation of each
 *            image. 10 swapped to confirmed product shots, 1 reclassified (Grey/Details
 *            Wood — all images are lifestyle room scenes, no product shot available).
 *
 * Run: docker compose exec api node scripts/fix-elysium-primaries.cjs [--dry-run]
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');

// Elysium vendor UUID
const ELYSIUM_VENDOR_ID = '550e8400-e29b-41d4-a716-446655440006';

// Products identified in visual audit as having lifestyle/room-scene primaries.
// Round 1: 57 products from initial audit.
// Round 2: 15 more found via aspect-ratio screening + visual confirmation.
// Round 3: 11 stubborn re-targets fixed via direct SQL (not in this list).
// Format: [product_name, collection]
const LIFESTYLE_TARGETS = [
  // --- Round 1 (original 57) ---
  ['Gold', 'Aeris'],
  ['Gold', 'Aston'],
  ['Malaysia AMZN TRAV. White', 'Amazon Travertine'],
  ['CanalGrande Stone', 'Canal Grande'],
  ['Blanco 259', 'Colores'],
  ['Snow', 'Core'],
  ['Pearl', 'Deco Wood'],
  ['Grey', 'Details Wood'],
  ['Taupe', 'Details Wood'],
  ['Verdigris', 'Dripart'],
  ['HGO260 Bianco', 'Due2'],
  ['Earth Moon White', 'Earth Stone'],
  ['Vintage Cream', 'Ewood'],
  ['Vintage Grey', 'Ewood'],
  ['Malaysia EX White', 'Extra White'],
  ['Breccia Cenere', 'Gemme'],
  ['Breccia Sabbia', 'Gemme'],
  ['Colorado', 'Gemme'],
  ['Mosaico', 'Iris Nacar'],
  ['Ecru', 'La Roche'],
  ['Mud', 'La Roche'],
  ['Fume RT', 'Larix'],
  ['Cosmo Light', 'Logico'],
  ['Light', 'Logico'],
  ['Amani Grey', 'Luxury'],
  ['Grafito', 'Madison'],
  ['Noce', 'Madison'],
  ['Light Grey', 'NG Pulpis Prime'],
  ['Cloud', 'Onyx of Cerim'],
  ['Argent', 'Origines'],
  ['Ombre Doree', 'Origines'],
  ['Light', 'Oxyde'],
  ['Charming Amber', 'Prexious'],
  ['Mountain Treasure', 'Prexious'],
  ['HQT Quartzite 1 - Sand', 'Quartzite'],
  ['Avorio', 'Sea Luster'],
  ['Amber', 'Selection Oak'],
  ['Grey', 'Selection Oak'],
  ['Marmi St. Laurent', 'Selezione Marmi'],
  ['Marmi St. Laurent Bricks', 'Selezione Marmi'],
  ['Cendre', 'Soft'],
  ['Sugar', 'Soft'],
  ['Polished', 'Statuario Mercury'],
  ['Flames Ice', 'Sunstone'],
  ['Charcoal', 'Supreme'],
  ['Var', 'Taiga'],
  ['I-Travertini Black', 'Travertino'],
  ['I-Travertini Grey', 'Travertino'],
  ['I-Travertini White', 'Travertino'],
  ['Ash', 'Urban Wood'],
  ['Natural Grey', 'Villa Rica'],
  ['White', 'Villa Rica'],
  ['White Gloss', 'Villa Rica'],
  ['Grey', 'Waystone'],
  ['Malaysia Roy White', 'White Tile'],
  ['Brown', 'Wild Wood'],
  ['Grey', 'Wild Wood'],
  // --- Round 2 (aspect-ratio screening + visual confirmation) ---
  ['Malaysia AMZN TRAV. Grey', 'Amazon Travertine'],
  ['Graphite', 'Basalt'],
  ['Bianco', 'Le Plance'],
  ['Sand', 'Onyx of Cerim'],
  ['OB03 Walnut', 'Orto Botanico'],
  ['OB10 White', 'Orto Botanico'],
  ['Belleville Marrone', 'Paris'],
  ['Fan White Gloss', 'Scale'],
  ['Black', 'Selection Oak'],
  ['389 Gris', 'Skyline'],
  ['Smoke', 'Soft'],
  ['Beige', 'Supreme'],
  ['Walnut', 'Urban Wood'],
  ['Fume', 'Larix'],
  ['White Gloss', 'Villa Rica'],
];

// 4 broken images (no photo loads)
// Format: [product_name, collection]
const BROKEN_TARGETS = [
  ['Art Flow Wall 2018', 'Carrara'],
  ['Wander Warm', 'Untamed'],
  ['Wander White', 'Untamed'],
  ['Polished Ceramic Wall', 'White'],
];

// Same keywords as base.js / fix-lifestyle-primaries.cjs — for validating alternates
const LIFESTYLE_KEYWORDS = [
  'room', 'scene', 'lifestyle', 'installed', 'roomscene', 'setting',
  'interior', 'kitchen', 'bath', 'bathroom', 'living', 'outdoor', 'pool',
  'backyard', 'application', 'install', 'showroom',
  'ambiance', 'vignette', 'hero', 'banner', 'header',
  'spotlight', 'promo', 'campaign', '1920x1080', '_4k',
  '.mp4', '.mov', '.webm',
  'amb0', 'amb1', '_amb_', '-amb-', 'amb_', 'ambi_',
  '_amb.', '-amb.', '-amb ',
  'ambience', 'gallery', 'roomview', 'room-view', 'insitu', 'in-situ',
  'inspiration', 'styled',
  'ambiente', 'bagno', 'cucina', 'ristorante', 'terrazza', 'soggiorno',
  'camera_', 'camera-',
  'posa', 'esterno', 'ingresso', 'veranda', 'giardino',
  'pavimento', 'rivestimento', 'vetrina', 'negozio',
  'parete', 'salotto', 'ufficio', 'balcone', 'realizzazione',
  'detalle', '_bano', '-bano', 'cocina', 'proyecto',
  ' amb ', 'restaurant', '_shop.', '_shop_',
  'beauty center', 'beauty_center', 'smart working', 'smart_working',
  'reception', 'lobby', 'lounge', 'hotel', 'corridor', 'patio',
  'bedroom', 'dining', 'terrace', 'garden',
  'render', 'rendering',
  // Elysium-specific patterns
  'csa_', 'img_', '_sto_', '_sto.',
  'crop_upscale',
];

/**
 * Check if a URL is a lifestyle image, accounting for product name false positives.
 */
function isLifestyleUrl(url, productName) {
  const filename = url.toLowerCase().split('/').pop().split('?')[0];
  const contextLow = (productName || '').toLowerCase();

  for (const kw of LIFESTYLE_KEYWORDS) {
    if (filename.includes(kw)) {
      if (contextLow && contextLow.includes(kw)) continue;
      return true;
    }
  }
  return false;
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // =========================================================================
    // Step 1: Resolve target products to their product IDs
    // =========================================================================
    console.log('Resolving target products...\n');

    const { rows: allProducts } = await client.query(`
      SELECT p.id, p.name, p.collection
      FROM products p
      WHERE p.vendor_id = $1 AND p.status = 'active'
    `, [ELYSIUM_VENDOR_ID]);

    // Build lookup: "name|collection" → product_id
    const productLookup = new Map();
    for (const p of allProducts) {
      productLookup.set(`${p.name}|${p.collection}`, p.id);
    }

    // Resolve lifestyle targets
    const targetProductIds = [];
    const missingTargets = [];
    for (const [name, collection] of LIFESTYLE_TARGETS) {
      const key = `${name}|${collection}`;
      const pid = productLookup.get(key);
      if (pid) {
        targetProductIds.push({ product_id: pid, name, collection });
      } else {
        missingTargets.push(`${name} / ${collection}`);
      }
    }

    if (missingTargets.length) {
      console.log(`WARNING: ${missingTargets.length} targets not found in DB:`);
      for (const m of missingTargets) console.log(`  - ${m}`);
      console.log();
    }
    console.log(`Matched ${targetProductIds.length} of ${LIFESTYLE_TARGETS.length} lifestyle targets\n`);

    // Resolve broken targets
    const brokenProductIds = [];
    for (const [name, collection] of BROKEN_TARGETS) {
      const key = `${name}|${collection}`;
      const pid = productLookup.get(key);
      if (pid) {
        brokenProductIds.push({ product_id: pid, name, collection });
      } else {
        console.log(`WARNING: Broken target not found: ${name} / ${collection}`);
      }
    }
    console.log(`Matched ${brokenProductIds.length} of ${BROKEN_TARGETS.length} broken targets\n`);

    // =========================================================================
    // Step 2: Fix product-level primaries (sku_id IS NULL)
    // =========================================================================
    const allTargetPids = targetProductIds.map(t => t.product_id);

    // Fetch product-level primaries for targets
    const { rows: prodPrimaries } = await client.query(`
      SELECT ma.id, ma.product_id, ma.url, ma.asset_type, ma.sort_order,
             p.name as product_name, p.collection
      FROM media_assets ma
      JOIN products p ON p.id = ma.product_id
      WHERE ma.product_id = ANY($1)
        AND ma.asset_type = 'primary'
        AND ma.sku_id IS NULL
    `, [allTargetPids]);

    console.log(`Found ${prodPrimaries.length} product-level primaries to fix\n`);

    // Fetch product-level alternates for these products
    const { rows: prodAlternates } = await client.query(`
      SELECT ma.id, ma.product_id, ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma
      WHERE ma.product_id = ANY($1)
        AND ma.asset_type IN ('alternate', 'lifestyle')
        AND ma.sku_id IS NULL
    `, [allTargetPids]);

    // Group alternates by product_id
    const prodAltsByPid = new Map();
    for (const alt of prodAlternates) {
      if (!prodAltsByPid.has(alt.product_id)) prodAltsByPid.set(alt.product_id, []);
      prodAltsByPid.get(alt.product_id).push(alt);
    }

    let swapped = 0;
    let reclassified = 0;

    console.log('=== Phase 1: Swap product-level lifestyle primaries with product-shot alternates ===\n');

    for (const row of prodPrimaries) {
      const alts = prodAltsByPid.get(row.product_id) || [];
      const replacement = alts.find(a =>
        a.asset_type === 'alternate' && !isLifestyleUrl(a.url, row.product_name)
      ) || alts.find(a =>
        !isLifestyleUrl(a.url, row.product_name)
      );

      if (replacement) {
        swapped++;
        console.log(`  SWAP: ${row.product_name} / ${row.collection}`);
        console.log(`    OLD primary: ${row.url.split('/').pop().substring(0, 80)}`);
        console.log(`    NEW primary: ${replacement.url.split('/').pop().substring(0, 80)}`);

        if (!DRY_RUN) {
          const oldSort = row.sort_order ?? 0;

          // Step 1: move old primary out of the way
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = -1000 - $1 WHERE id = $2`,
            [swapped, row.id]
          );
          // Step 2: promote alternate to primary
          await client.query(
            `UPDATE media_assets SET asset_type = 'primary', sort_order = $1 WHERE id = $2`,
            [oldSort, replacement.id]
          );
          // Step 3: find safe sort_order for demoted image
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS max_sort FROM media_assets
             WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'lifestyle'`,
            [row.product_id]
          );
          await client.query(
            `UPDATE media_assets SET sort_order = $1 WHERE id = $2`,
            [max_sort, row.id]
          );
        }
      }
    }

    console.log(`\nPhase 1 (product-level): ${swapped} swapped\n`);
    console.log('=== Phase 2: Reclassify product-level primaries with no suitable alternate ===\n');

    for (const row of prodPrimaries) {
      const alts = prodAltsByPid.get(row.product_id) || [];
      const replacement = alts.find(a =>
        a.asset_type === 'alternate' && !isLifestyleUrl(a.url, row.product_name)
      ) || alts.find(a =>
        !isLifestyleUrl(a.url, row.product_name)
      );

      if (!replacement) {
        reclassified++;
        console.log(`  RECLASSIFY: ${row.product_name} / ${row.collection}`);
        console.log(`    ${row.url.split('/').pop().substring(0, 80)} -> lifestyle`);

        if (!DRY_RUN) {
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_sort FROM media_assets
             WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'lifestyle'`,
            [row.product_id]
          );
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [max_sort, row.id]
          );
        }
      }
    }

    console.log(`\nPhase 2 (product-level): ${reclassified} reclassified\n`);

    // =========================================================================
    // Step 3: Fix SKU-level primaries for the same products
    // =========================================================================
    console.log('=== Phase 3: Fix SKU-level primaries for targeted products ===\n');

    // Get all SKU-level primaries for target products, check if they share the
    // same image URL as the (now-demoted) product-level primary
    const { rows: skuPrimaries } = await client.query(`
      SELECT ma.id, ma.product_id, ma.sku_id, ma.url, ma.asset_type, ma.sort_order,
             s.variant_name, p.name as product_name, p.collection
      FROM media_assets ma
      JOIN skus s ON s.id = ma.sku_id
      JOIN products p ON p.id = ma.product_id
      WHERE ma.product_id = ANY($1)
        AND ma.asset_type = 'primary'
        AND ma.sku_id IS NOT NULL
    `, [allTargetPids]);

    // For each SKU primary, check if it uses the same URL as the product-level
    // primary we just fixed (same lifestyle image propagated to SKU level)
    const prodPrimaryUrls = new Set(prodPrimaries.map(r => r.url));

    // Fetch SKU-level alternates
    const skuIds = skuPrimaries.filter(r => prodPrimaryUrls.has(r.url)).map(r => r.sku_id);
    let skuAlternates = [];
    if (skuIds.length > 0) {
      const result = await client.query(`
        SELECT id, sku_id, product_id, url, asset_type, sort_order
        FROM media_assets
        WHERE sku_id = ANY($1)
          AND asset_type IN ('alternate', 'lifestyle')
      `, [skuIds]);
      skuAlternates = result.rows;
    }

    const skuAltsBySku = new Map();
    for (const alt of skuAlternates) {
      if (!skuAltsBySku.has(alt.sku_id)) skuAltsBySku.set(alt.sku_id, []);
      skuAltsBySku.get(alt.sku_id).push(alt);
    }

    let skuSwapped = 0;
    let skuReclassified = 0;

    for (const row of skuPrimaries) {
      if (!prodPrimaryUrls.has(row.url)) continue; // Only fix SKUs sharing the bad primary

      const alts = skuAltsBySku.get(row.sku_id) || [];
      const replacement = alts.find(a =>
        a.asset_type === 'alternate' && !isLifestyleUrl(a.url, row.product_name)
      ) || alts.find(a =>
        !isLifestyleUrl(a.url, row.product_name)
      );

      if (replacement) {
        skuSwapped++;
        console.log(`  SWAP SKU: ${row.product_name} / ${row.collection} / ${row.variant_name}`);
        console.log(`    NEW primary: ${replacement.url.split('/').pop().substring(0, 80)}`);

        if (!DRY_RUN) {
          const oldSort = row.sort_order ?? 0;
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = -2000 - $1 WHERE id = $2`,
            [skuSwapped, row.id]
          );
          await client.query(
            `UPDATE media_assets SET asset_type = 'primary', sort_order = $1 WHERE id = $2`,
            [oldSort, replacement.id]
          );
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS max_sort FROM media_assets
             WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'`,
            [row.product_id, row.sku_id]
          );
          await client.query(
            `UPDATE media_assets SET sort_order = $1 WHERE id = $2`,
            [max_sort, row.id]
          );
        }
      } else {
        skuReclassified++;
        console.log(`  RECLASSIFY SKU: ${row.product_name} / ${row.collection} / ${row.variant_name}`);

        if (!DRY_RUN) {
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_sort FROM media_assets
             WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'`,
            [row.product_id, row.sku_id]
          );
          await client.query(
            `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = $1 WHERE id = $2`,
            [max_sort, row.id]
          );
        }
      }
    }

    console.log(`\nPhase 3 (SKU-level): ${skuSwapped} swapped, ${skuReclassified} reclassified\n`);

    // =========================================================================
    // Step 4: Fix broken images
    // =========================================================================
    console.log('=== Phase 4: Fix broken images ===\n');

    const brokenPids = brokenProductIds.map(t => t.product_id);
    let brokenFixed = 0;
    let brokenDeleted = 0;

    if (brokenPids.length > 0) {
      // Get all media_assets for broken products
      const { rows: brokenAssets } = await client.query(`
        SELECT ma.id, ma.product_id, ma.sku_id, ma.url, ma.asset_type, ma.sort_order,
               p.name as product_name, p.collection
        FROM media_assets ma
        JOIN products p ON p.id = ma.product_id
        WHERE ma.product_id = ANY($1)
        ORDER BY ma.product_id, ma.sku_id, ma.asset_type, ma.sort_order
      `, [brokenPids]);

      // Group by product_id
      const assetsByProduct = new Map();
      for (const a of brokenAssets) {
        if (!assetsByProduct.has(a.product_id)) assetsByProduct.set(a.product_id, []);
        assetsByProduct.get(a.product_id).push(a);
      }

      for (const target of brokenProductIds) {
        const assets = assetsByProduct.get(target.product_id) || [];
        const primaries = assets.filter(a => a.asset_type === 'primary');
        const nonPrimaries = assets.filter(a => a.asset_type !== 'primary');

        console.log(`  ${target.name} / ${target.collection}: ${primaries.length} primaries, ${nonPrimaries.length} others`);

        for (const primary of primaries) {
          // Check if any non-primary alternate exists for the same scope (product-level or same SKU)
          const scopeAlts = nonPrimaries.filter(a =>
            a.sku_id === primary.sku_id &&
            !isLifestyleUrl(a.url, target.name)
          );

          if (scopeAlts.length > 0) {
            const replacement = scopeAlts[0];
            brokenFixed++;
            const scope = primary.sku_id ? 'SKU' : 'product';
            console.log(`    SWAP (${scope}): promote ${replacement.url.split('/').pop().substring(0, 60)}`);

            if (!DRY_RUN) {
              await client.query(
                `UPDATE media_assets SET asset_type = 'lifestyle', sort_order = -3000 - $1 WHERE id = $2`,
                [brokenFixed, primary.id]
              );
              await client.query(
                `UPDATE media_assets SET asset_type = 'primary', sort_order = $1 WHERE id = $2`,
                [primary.sort_order ?? 0, replacement.id]
              );
              // Reassign safe sort_order
              if (primary.sku_id) {
                const { rows: [{ max_sort }] } = await client.query(
                  `SELECT COALESCE(MAX(sort_order), 0) + 1 AS max_sort FROM media_assets
                   WHERE product_id = $1 AND sku_id = $2 AND asset_type = 'lifestyle'`,
                  [primary.product_id, primary.sku_id]
                );
                await client.query(`UPDATE media_assets SET sort_order = $1 WHERE id = $2`, [max_sort, primary.id]);
              } else {
                const { rows: [{ max_sort }] } = await client.query(
                  `SELECT COALESCE(MAX(sort_order), 0) + 1 AS max_sort FROM media_assets
                   WHERE product_id = $1 AND sku_id IS NULL AND asset_type = 'lifestyle'`,
                  [primary.product_id]
                );
                await client.query(`UPDATE media_assets SET sort_order = $1 WHERE id = $2`, [max_sort, primary.id]);
              }
            }
          } else {
            brokenDeleted++;
            const scope = primary.sku_id ? 'SKU' : 'product';
            console.log(`    DELETE (${scope}): broken ${primary.url.split('/').pop().substring(0, 60)}`);

            if (!DRY_RUN) {
              await client.query(`DELETE FROM media_assets WHERE id = $1`, [primary.id]);
            }
          }
        }
      }
    }

    console.log(`\nPhase 4 (broken): ${brokenFixed} replaced, ${brokenDeleted} deleted\n`);

    // =========================================================================
    // Summary
    // =========================================================================
    const totalFixed = swapped + reclassified + skuSwapped + skuReclassified + brokenFixed + brokenDeleted;
    console.log('=== Summary ===');
    console.log(`  Product-level: ${swapped} swapped + ${reclassified} reclassified`);
    console.log(`  SKU-level:     ${skuSwapped} swapped + ${skuReclassified} reclassified`);
    console.log(`  Broken:        ${brokenFixed} replaced + ${brokenDeleted} deleted`);
    console.log(`  Total:         ${totalFixed} changes\n`);

    if (DRY_RUN) {
      console.log('[DRY RUN] No changes made. Remove --dry-run to apply.');
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
      console.log('Done! Changes committed.');
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

run().catch(err => { console.error(err); process.exit(1); });
