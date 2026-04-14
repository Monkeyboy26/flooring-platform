#!/usr/bin/env node
/**
 * msi-overhaul-fix.cjs
 *
 * Fixes regressions from msi-overhaul.cjs:
 *   1. Categorize 284 uncategorized products (faucets, sinks, vanities, grout, tools, etc.)
 *   2. Set collection on ~282 products missing it
 *   3. Recover images for 10 flooring products from deactivated same-collection products
 *   4. Probe MSI CDN/website for non-flooring product images
 *   5. Clean up product names (expand abbreviations, title case)
 *
 * Usage:
 *   node backend/scripts/msi-overhaul-fix.cjs --dry-run
 *   node backend/scripts/msi-overhaul-fix.cjs
 */

const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';

// ─────────────────────────────────────────────────────────────────────────────
// Category IDs (from categories table)
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = {
  // Bath
  'bathroom-faucets':    '650e8400-e29b-41d4-a716-446655440082',
  'bathroom-sinks':      '650e8400-e29b-41d4-a716-446655440072',
  'kitchen-faucets':     '650e8400-e29b-41d4-a716-446655440081',
  'kitchen-sinks':       '650e8400-e29b-41d4-a716-446655440071',
  'vanity-tops':         '650e8400-e29b-41d4-a716-446655440048',
  'vanities':            '4547d0d3-0fa6-4fef-9c88-7575dd31c5d5',
  'bath-accessories':    '03ab6adf-d7b2-463b-a1a4-9efa0e7cdc05',
  'bath-mirrors':        '7d64cb28-df8e-4897-861e-db5de5f05eae',
  'storage-cabinets':    '925daef4-1f74-4c63-aada-53cb685d6d3b',
  // Installation & Sundries
  'adhesives-sealants':    '650e8400-e29b-41d4-a716-446655440111',
  'surface-prep-levelers': '650e8400-e29b-41d4-a716-446655440113',
  'tools-trowels':         '650e8400-e29b-41d4-a716-446655440118',
  'underlayment':          '650e8400-e29b-41d4-a716-446655440112',
  'installation-sundries': '650e8400-e29b-41d4-a716-446655440110',
  // Countertops
  'quartz-countertops':  '650e8400-e29b-41d4-a716-446655440041',
  'countertops':         '650e8400-e29b-41d4-a716-446655440040',
};

// ─────────────────────────────────────────────────────────────────────────────
// Category assignment rules (order matters — first match wins)
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_RULES = [
  // Faucets
  { pattern: /kitchen\s*faucet/i, category: 'kitchen-faucets' },
  { pattern: /bathroom?\s*faucet/i, category: 'bathroom-faucets' },
  { pattern: /shower.*faucet|tub.*faucet/i, category: 'bath-accessories' },
  { pattern: /faucet/i, category: 'bathroom-faucets' }, // default faucets to bathroom

  // Sinks
  { pattern: /kitchen.*sink|single\s*bowl|double\s*bowl|farmhouse.*sink/i, category: 'kitchen-sinks' },
  { pattern: /bathroom.*sink|vessel.*sink|pedestal/i, category: 'bathroom-sinks' },
  { pattern: /\bsink\b|handcrafted\s+\d{4}/i, category: 'kitchen-sinks' }, // most MSI sinks are kitchen
  { pattern: /\bbowl\b.*\d+\s*gauge|\d+g\s+.*bowl/i, category: 'kitchen-sinks' },
  { pattern: /m\s*ser[ie]+s.*bowl/i, category: 'kitchen-sinks' },

  // Vanities
  { pattern: /vanity\s*top/i, category: 'vanity-tops' },
  { pattern: /vanityx?\d*cm/i, category: 'vanity-tops' },
  { pattern: /vanity/i, category: 'vanities' },

  // Grout & Caulk
  { pattern: /grout|caulk/i, category: 'adhesives-sealants' },

  // Setting materials (mortar, adhesive, sealer, epoxy, moisture)
  { pattern: /thinset|mortar|adhesive|sealer|epoxy|moisture\s*(barrier|guard)|primer/i, category: 'surface-prep-levelers' },
  { pattern: /sika\s*level|sikalevel|patch/i, category: 'surface-prep-levelers' },
  { pattern: /sika\s*tile|sikatile/i, category: 'adhesives-sealants' },
  { pattern: /sika\s*construction/i, category: 'adhesives-sealants' },
  { pattern: /\bsika\b/i, category: 'surface-prep-levelers' },

  // Cleaners
  { pattern: /cleaner|miracle/i, category: 'installation-sundries' },

  // Tools
  { pattern: /scraper|cutter|probilt/i, category: 'tools-trowels' },

  // Underlayment
  { pattern: /underlayment/i, category: 'underlayment' },

  // Reinforcing fabric, sound shield, fracture guard
  { pattern: /fabric|shield|fracture\s*guard/i, category: 'underlayment' },

  // Sink grids/accessories
  { pattern: /\bgrid\b.*bowl/i, category: 'kitchen-sinks' },

  // Drain
  { pattern: /drain/i, category: 'bath-accessories' },

  // Mirror
  { pattern: /mirror/i, category: 'bath-mirrors' },

  // Soap/towel/toilet
  { pattern: /soap|towel|toilet/i, category: 'bath-accessories' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Collection extraction for non-flooring products
// ─────────────────────────────────────────────────────────────────────────────

function extractCollection(name, categorySlug) {
  // Grout products: "800 Grout Sanded #25 Grey" -> collection = "800 Grout"
  // "Prism Grout #545 Bleached Wood" -> collection = "Prism Grout"
  let m;
  if ((m = name.match(/^((?:800|prism)\s+grout(?:\s+(?:sanded|unsanded|caulk))?)/i))) {
    return smartTitle(m[1]);
  }
  // Sika products: "Sika Level-02 ..." -> "Sika Level", "Sikalevel 025" -> "Sika Level"
  if ((m = name.match(/^(sika\s*(?:tile|level|mb|construction))/i))) {
    return smartTitle(m[1].replace(/[-_]/g, ' ').replace(/sika(tile|level)/i, 'Sika $1'));
  }
  // Faucets: "1handle Kitchen Faucet 8401-803" -> model number as collection
  if (/faucet/i.test(name)) return 'MSI Faucets';
  // Sinks: model-based grouping
  if (/\bsink\b|bowl|handcrafted/i.test(name)) return 'MSI Sinks';
  // Vanity tops: "Calacatta Nowy Vanityx2cm" -> extract stone name as collection
  // Strip size/bowl descriptors: "Sparkling Gray Dbl Bwl Vanityx2cm" -> "Sparkling Gray"
  if ((m = name.match(/^(.+?)\s*(?:dbl|sgl|double|single)\s*bwl\s*vanity/i))) {
    return smartTitle(m[1].trim());
  }
  if ((m = name.match(/^(.+?)\s*vanity/i))) {
    return smartTitle(m[1].trim());
  }
  // Plus grout: "Plus-Sandedgrout #165..." -> "Prism Plus Grout"
  if (/^plus-/i.test(name)) return 'Prism Plus Grout';
  // Grid for sink
  if (/\bgrid\b/i.test(name)) return 'MSI Sinks';
  // Sink strainer
  if (/strainer/i.test(name)) return 'MSI Sinks';
  // Miracle cleaners
  if (/miracle/i.test(name)) return 'Miracle Sealants';
  // ProBilt tools
  if (/probilt/i.test(name)) return 'ProBilt';
  // Underlayment: "Abatec Underlayment" -> "Abatec"
  if ((m = name.match(/^(\w+)\s+underlayment/i))) {
    return smartTitle(m[1]);
  }
  return null;
}

function smartTitle(s) {
  if (!s) return s;
  return s.replace(/\w\S*/g, (w) => {
    if (/^(a|an|the|and|or|of|in|on|at|to|for|by|is)$/i.test(w) && w !== w.toUpperCase()) {
      return w.toLowerCase();
    }
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Name cleanup for non-flooring products
// ─────────────────────────────────────────────────────────────────────────────

function cleanProductName(name) {
  let n = name;
  // Fix "1handle" -> "1-Handle", "2handle" -> "2-Handle"
  n = n.replace(/(\d)handle/gi, '$1-Handle');
  // Fix "Bathrom" -> "Bathroom"
  n = n.replace(/\bbathrom\b/gi, 'Bathroom');
  // Fix "Kitchenfaucet" -> "Kitchen Faucet"
  n = n.replace(/kitchenfaucet/gi, 'Kitchen Faucet');
  // Fix "Bathroomfaucet" -> "Bathroom Faucet"
  n = n.replace(/bathroomfaucet/gi, 'Bathroom Faucet');
  // Fix "Tubfaucet" -> "Tub Faucet"
  n = n.replace(/tubfaucet/gi, 'Tub Faucet');
  // Fix "brnickel" -> "Brushed Nickel", "brshnickel" -> "Brushed Nickel"
  n = n.replace(/\bbrsh?nickel\b/gi, 'Brushed Nickel');
  n = n.replace(/\bbr\s*nickel\b/gi, 'Brushed Nickel');
  // Fix "Vanityx2cm" -> "Vanity Top 2cm"
  n = n.replace(/vanity\s*(?:top)?x(\d+)cm/gi, 'Vanity Top $1cm');
  // Fix "Shower/Tubfaucet" -> "Shower/Tub Faucet"
  n = n.replace(/\/tub\s*faucet/gi, '/Tub Faucet');
  // Fix "Faucet4403" -> "Faucet 4403"
  n = n.replace(/faucet(\d)/gi, 'Faucet $1');
  // Fix "803br " -> "803 "
  n = n.replace(/(\d{3,4})br\s/gi, '$1 ');
  // Remove trailing model codes from display name? No, keep them for uniqueness
  // Fix "Seires" -> "Series"
  n = n.replace(/\bseires\b/gi, 'Series');
  // Fix "Freekicthen" -> "Free Kitchen", "Freekitchen" -> "Free Kitchen"
  n = n.replace(/free\s*kic?then/gi, 'Free Kitchen');
  n = n.replace(/free\s*kitchen/gi, 'Free Kitchen');
  // Fix "Sandedgrout" -> "Sanded Grout"
  n = n.replace(/sandedgrout/gi, 'Sanded Grout');
  // Fix "Sikalevel" -> "Sika Level", "Sikatile" -> "Sika Tile"
  n = n.replace(/sika(level|tile)/gi, (_, t) => `Sika ${t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()}`);
  // Fix "Plus-Non " -> "Plus Non-"
  n = n.replace(/Plus-Non\s+Sanded/gi, 'Plus Non-Sanded');
  // Fix "Touchfree" -> "Touch-Free"
  n = n.replace(/touchfree/gi, 'Touch-Free');
  // Smart title case
  n = smartTitle(n);
  // Fix "#25" and "#545" - keep as-is
  // Remove extra spaces
  n = n.replace(/\s+/g, ' ').trim();
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// CDN probe helper
// ─────────────────────────────────────────────────────────────────────────────

function headUrl(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// MSI CDN patterns for non-flooring
function getMsiImageUrls(name, categorySlug) {
  const urls = [];
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // MSI uses msisurfaces.com/Images/ for products
  const base = 'https://cdn.msisurfaces.com/Images';
  const sections = ['sinks', 'faucets', 'quartz', 'accessories'];
  const types = ['detail', 'front', 'iso'];

  for (const section of sections) {
    for (const type of types) {
      urls.push(`${base}/${section}/${slug}/${type}.jpg`);
    }
  }

  // Also try direct product image pattern
  urls.push(`https://www.msisurfaces.com/images/thumbnails/800/800/10/${slug}.jpg`);

  return urls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Savepoint helper
// ─────────────────────────────────────────────────────────────────────────────

let _spCounter = 0;
async function safeTx(client, sql, params = []) {
  const sp = `sp_fix_${++_spCounter}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const result = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    if (VERBOSE) console.error(`    safeTx error: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('============================================================');
  console.log(`  MSI OVERHAUL FIX (${DRY_RUN ? 'DRY RUN' : 'LIVE'})`);
  console.log('============================================================\n');

  const client = await pool.connect();

  try {
    // ── Load data ──────────────────────────────────────────────────────
    const uncategorized = (await client.query(`
      SELECT p.id, p.name, p.collection, p.display_name
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active AND p.category_id IS NULL
      ORDER BY p.name
    `, [VENDOR_ID])).rows;

    const missingCollection = (await client.query(`
      SELECT p.id, p.name, p.category_id
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active AND (p.collection IS NULL OR p.collection = '')
      ORDER BY p.name
    `, [VENDOR_ID])).rows;

    const missingImages = (await client.query(`
      SELECT p.id, p.name, p.collection, p.category_id
      FROM products p
      WHERE p.vendor_id = $1 AND p.is_active
        AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
      ORDER BY p.name
    `, [VENDOR_ID])).rows;

    console.log(`  Uncategorized:     ${uncategorized.length}`);
    console.log(`  Missing collection: ${missingCollection.length}`);
    console.log(`  Missing images:    ${missingImages.length}\n`);

    if (DRY_RUN) {
      console.log('─── DRY RUN: Category assignments ───\n');
    }

    // ── Phase 1: Categorize ─────────────────────────────────────────────

    console.log('─── Phase 1: Categorize uncategorized products ───\n');

    const stats = {
      categorized: 0,
      collections_set: 0,
      names_cleaned: 0,
      images_recovered: 0,
      images_from_cdn: 0,
      search_refreshed: 0,
      errors: 0,
    };

    if (!DRY_RUN) {
      await client.query('BEGIN');
    }

    const categoryAssignments = {};
    for (const p of uncategorized) {
      let assigned = null;
      for (const rule of CATEGORY_RULES) {
        if (rule.pattern.test(p.name)) {
          assigned = rule.category;
          break;
        }
      }
      if (assigned) {
        categoryAssignments[p.id] = assigned;
        if (DRY_RUN || VERBOSE) {
          console.log(`  ${p.name} → ${assigned}`);
        }
      } else {
        console.log(`  UNMATCHED: ${p.name}`);
      }
    }

    const catCounts = {};
    for (const cat of Object.values(categoryAssignments)) {
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    console.log(`\n  Category assignment summary:`);
    for (const [cat, cnt] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cat}: ${cnt}`);
    }
    console.log(`  Total: ${Object.keys(categoryAssignments).length} / ${uncategorized.length}\n`);

    if (!DRY_RUN) {
      for (const [prodId, catSlug] of Object.entries(categoryAssignments)) {
        const catId = CATEGORIES[catSlug];
        if (!catId) {
          console.error(`  ERROR: No category ID for slug "${catSlug}"`);
          stats.errors++;
          continue;
        }
        const res = await safeTx(client, `
          UPDATE products SET category_id = $2, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [prodId, catId]);
        if (res) stats.categorized++;
        else stats.errors++;
      }
      console.log(`  Categorized: ${stats.categorized}`);
    }

    // ── Phase 2: Set collections ───────────────────────────────────────

    console.log('\n─── Phase 2: Set collections ───\n');

    for (const p of missingCollection) {
      const collection = extractCollection(p.name, null);
      if (collection) {
        if (DRY_RUN || VERBOSE) {
          console.log(`  "${p.name}" → collection="${collection}"`);
        }
        if (!DRY_RUN) {
          const res = await safeTx(client, `
            UPDATE products SET collection = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [p.id, collection]);
          if (res) stats.collections_set++;
          else stats.errors++;
        }
      } else {
        if (VERBOSE) console.log(`  SKIP: "${p.name}" — no collection extracted`);
      }
    }
    console.log(`  Collections set: ${DRY_RUN ? '(dry run)' : stats.collections_set}`);

    // ── Phase 3: Name cleanup ──────────────────────────────────────────

    console.log('\n─── Phase 3: Name cleanup ───\n');

    for (const p of uncategorized) {
      const cleaned = cleanProductName(p.name);
      if (cleaned !== p.name) {
        if (DRY_RUN || VERBOSE) {
          console.log(`  "${p.name}" → "${cleaned}"`);
        }
        if (!DRY_RUN) {
          // Update both name and display_name
          const res = await safeTx(client, `
            UPDATE products SET name = $2, display_name = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
          `, [p.id, cleaned, cleaned]);
          if (res) stats.names_cleaned++;
          else stats.errors++;
        }
      }
    }
    console.log(`  Names cleaned: ${DRY_RUN ? '(dry run)' : stats.names_cleaned}`);

    // ── Phase 4: Recover images for flooring products ──────────────────

    console.log('\n─── Phase 4: Recover images ───\n');

    // 4a: For flooring products missing images, copy from same-collection deactivated products
    const flooringMissing = missingImages.filter(p => p.category_id != null);
    console.log(`  Flooring products missing images: ${flooringMissing.length}`);

    if (!DRY_RUN) {
      for (const p of flooringMissing) {
        if (!p.collection) continue;
        // Find a deactivated product in same collection that has images
        const sourceRes = await client.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products d
          JOIN media_assets ma ON ma.product_id = d.id
          WHERE d.vendor_id = $1 AND NOT d.is_active AND d.collection = $2
          ORDER BY ma.sort_order
          LIMIT 5
        `, [VENDOR_ID, p.collection]);

        if (sourceRes.rows.length > 0) {
          for (const img of sourceRes.rows) {
            const res = await safeTx(client, `
              INSERT INTO media_assets (product_id, url, asset_type, sort_order)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT DO NOTHING
            `, [p.id, img.url, img.asset_type, img.sort_order]);
            if (res) stats.images_recovered++;
          }
          if (VERBOSE) console.log(`  Recovered ${sourceRes.rows.length} images for "${p.name}"`);
        } else {
          if (VERBOSE) console.log(`  No source images for "${p.name}" (collection: ${p.collection})`);
        }
      }
    }
    console.log(`  Flooring images recovered: ${DRY_RUN ? '(dry run)' : stats.images_recovered}`);

    // 4b: For non-flooring products, try MSI website og:image or CDN
    const nonFlooringMissing = missingImages.filter(p => p.category_id == null);
    console.log(`\n  Non-flooring products missing images: ${nonFlooringMissing.length}`);

    // Try to find images from deactivated products with similar names
    if (!DRY_RUN) {
      let recovered = 0;
      for (const p of nonFlooringMissing) {
        // Try exact name match on deactivated products first
        const exactRes = await client.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products d
          JOIN media_assets ma ON ma.product_id = d.id
          WHERE d.vendor_id = $1 AND NOT d.is_active AND d.name = $2
          LIMIT 3
        `, [VENDOR_ID, p.name]);

        if (exactRes.rows.length > 0) {
          for (const img of exactRes.rows) {
            await safeTx(client, `
              INSERT INTO media_assets (product_id, url, asset_type, sort_order)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT DO NOTHING
            `, [p.id, img.url, img.asset_type, img.sort_order]);
            recovered++;
          }
          continue;
        }

        // Try partial name match (first 15+ chars)
        const prefix = p.name.substring(0, Math.min(20, p.name.length));
        const partialRes = await client.query(`
          SELECT DISTINCT ma.url, ma.asset_type, ma.sort_order
          FROM products d
          JOIN media_assets ma ON ma.product_id = d.id
          WHERE d.vendor_id = $1 AND NOT d.is_active AND d.name ILIKE $2 || '%'
          LIMIT 3
        `, [VENDOR_ID, prefix]);

        if (partialRes.rows.length > 0) {
          for (const img of partialRes.rows) {
            await safeTx(client, `
              INSERT INTO media_assets (product_id, url, asset_type, sort_order)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT DO NOTHING
            `, [p.id, img.url, img.asset_type, img.sort_order]);
            recovered++;
          }
        }
      }
      console.log(`  Non-flooring images recovered from deactivated: ${recovered}`);
    }

    // ── Phase 5: Refresh search vectors ────────────────────────────────

    console.log('\n─── Phase 5: Refresh search vectors ───\n');

    if (!DRY_RUN) {
      // Get all affected product IDs
      const affectedIds = [
        ...uncategorized.map(p => p.id),
        ...missingCollection.map(p => p.id),
        ...missingImages.map(p => p.id),
      ];
      const uniqueIds = [...new Set(affectedIds)];

      // Update search_vector for affected products
      let refreshed = 0;
      for (const id of uniqueIds) {
        const res = await safeTx(client, `
          UPDATE products SET
            search_vector = to_tsvector('english',
              coalesce(name, '') || ' ' ||
              coalesce(display_name, '') || ' ' ||
              coalesce(collection, '') || ' ' ||
              coalesce(description_short, '')
            ),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [id]);
        if (res) refreshed++;
      }
      stats.search_refreshed = refreshed;

      // Refresh materialized view
      await safeTx(client, 'REFRESH MATERIALIZED VIEW CONCURRENTLY product_popularity');
    }
    console.log(`  Search vectors refreshed: ${DRY_RUN ? '(dry run)' : stats.search_refreshed}`);

    // ── Commit ─────────────────────────────────────────────────────────

    if (!DRY_RUN) {
      const commitResult = await client.query('COMMIT');
      if (commitResult.command === 'ROLLBACK') {
        console.error('\nERROR: Transaction was silently ROLLED BACK.');
        process.exit(1);
      }
      console.log('\nTransaction committed successfully.');
    }

    // ── After metrics ──────────────────────────────────────────────────

    console.log('\n=== AFTER ===');
    const after = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND is_active) as products,
        (SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND is_active AND category_id IS NOT NULL)::float /
          NULLIF((SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND is_active), 0) * 100 as categorized_pct,
        (SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND is_active AND collection IS NOT NULL AND collection != '')::float /
          NULLIF((SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND is_active), 0) * 100 as collection_pct,
        (SELECT COUNT(*) FROM products p WHERE p.vendor_id = $1 AND p.is_active AND EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id))::float /
          NULLIF((SELECT COUNT(*) FROM products WHERE vendor_id = $1 AND is_active), 0) * 100 as image_pct
    `, [VENDOR_ID]);

    const a = after.rows[0];
    console.log(`  Active products:  ${a.products}`);
    console.log(`  Categorized:      ${parseFloat(a.categorized_pct).toFixed(1)}%`);
    console.log(`  Collection set:   ${parseFloat(a.collection_pct).toFixed(1)}%`);
    console.log(`  Image coverage:   ${parseFloat(a.image_pct).toFixed(1)}%`);

    console.log('\n=== STATS ===');
    console.log(`  Categorized:         ${stats.categorized}`);
    console.log(`  Collections set:     ${stats.collections_set}`);
    console.log(`  Names cleaned:       ${stats.names_cleaned}`);
    console.log(`  Images recovered:    ${stats.images_recovered}`);
    console.log(`  Search refreshed:    ${stats.search_refreshed}`);
    console.log(`  Errors:              ${stats.errors}`);

  } catch (err) {
    if (!DRY_RUN) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('\nFATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
