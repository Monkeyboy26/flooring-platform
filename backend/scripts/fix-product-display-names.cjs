#!/usr/bin/env node
/**
 * fix-product-display-names.cjs — Two-phase fix for product display names:
 *
 *   Phase A: Restore lost variant info (~3,255 products)
 *     Products where display_name was set to just the collection name, stripping
 *     color/variant info. E.g. "Arterra Pure White" → display_name = "Arterra".
 *     Fix: restore display_name = name (which has the full info).
 *
 *   Phase B: Append product type suffix (~35,000+ products)
 *     Most products don't indicate what they are. "Arterra Pure White" gives no
 *     hint it's a paver. Fix: append category-based suffix when not already present.
 *     E.g. "Arterra Pure White" → "Arterra Pure White Paver"
 *
 * Usage:
 *   node backend/scripts/fix-product-display-names.cjs --dry-run          # Preview only
 *   node backend/scripts/fix-product-display-names.cjs                    # Execute updates
 *   node backend/scripts/fix-product-display-names.cjs --vendor MSI       # Single vendor
 *   node backend/scripts/fix-product-display-names.cjs --phase A          # Phase A only
 *   node backend/scripts/fix-product-display-names.cjs --phase B          # Phase B only
 *   node backend/scripts/fix-product-display-names.cjs --limit 50         # Cap updates
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/flooring_pim',
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const vendorIdx = args.indexOf('--vendor');
const VENDOR_FILTER = vendorIdx !== -1 ? args[vendorIdx + 1] : null;
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const phaseIdx = args.indexOf('--phase');
const PHASE_FILTER = phaseIdx !== -1 ? args[phaseIdx + 1].toUpperCase() : null;
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Category → Suffix mapping
// ---------------------------------------------------------------------------

const CATEGORY_SUFFIX_MAP = {
  // Hardwood
  'engineered hardwood': 'Engineered Hardwood',
  'solid hardwood': 'Solid Hardwood',
  'hardwood': 'Hardwood',
  'waterproof wood': 'Waterproof Wood',
  // Tile
  'porcelain tile': 'Porcelain Tile',
  'ceramic tile': 'Ceramic Tile',
  'mosaic tile': 'Mosaic Tile',
  'natural stone': 'Natural Stone Tile',
  'backsplash tile': 'Backsplash Tile',
  'backsplash & wall tile': 'Wall Tile',
  'decorative tile': 'Decorative Tile',
  'pool tile': 'Pool Tile',
  'wood look tile': 'Wood Look Tile',
  'large format tile': 'Large Format Tile',
  'fluted tile': 'Fluted Tile',
  'commercial tile': 'Commercial Tile',
  // Slabs & Countertops
  'porcelain slabs': 'Porcelain Slab',
  'quartz countertops': 'Quartz Countertop',
  'quartz': 'Quartz Countertop',
  'granite countertops': 'Granite Countertop',
  'quartzite countertops': 'Quartzite Countertop',
  'marble countertops': 'Marble Countertop',
  'soapstone countertops': 'Soapstone Countertop',
  'prefabricated countertops': 'Prefabricated Countertop',
  'countertops': 'Countertop',
  // Vinyl
  'lvp (plank)': 'Luxury Vinyl Plank',
  'lvp': 'Luxury Vinyl Plank',
  'lvt (tile)': 'Luxury Vinyl Tile',
  'lvt': 'Luxury Vinyl Tile',
  'luxury vinyl': 'Luxury Vinyl',
  'spc': 'SPC Vinyl',
  'wpc': 'WPC Vinyl',
  // Other flooring
  'laminate': 'Laminate',
  'laminate flooring': 'Laminate',
  'carpet': 'Carpet',
  'carpet tile': 'Carpet Tile',
  'rubber flooring': 'Rubber Flooring',
  'artificial turf': 'Artificial Turf',
  // Vanity & Bath
  'vanity': 'Vanity',
  'vanity tops': 'Vanity Top',
  'vanities': 'Vanity',
  'faucets': 'Faucet',
  'bathroom faucets': 'Faucet',
  'kitchen faucets': 'Faucet',
  'mirrors': 'Mirror',
  'sinks': 'Sink',
  'kitchen sinks': 'Sink',
  'bathroom sinks': 'Sink',
  'shower systems': 'Shower System',
  // Trim & Accessories
  'transitions & moldings': 'Molding',
  'transitions': 'Molding',
  'moldings': 'Molding',
  'moulding': 'Molding',
  'wall base': 'Wall Base',
  'underlayment': 'Underlayment',
  'stair treads & nosing': 'Stair Tread',
  // Outdoor
  'hardscaping': 'Paver',
  'pavers': 'Paver',
  'stacked stone': 'Stacked Stone',
};

// Categories to skip — names are already descriptive enough
const SKIP_CATEGORIES = new Set([
  'light & power',
  'decorative hardware',
  'functional hardware',
  'hardware & specialty',
  'carved wood',
  'organizers',
  'storage cabinets',
  'bath hardware',
  'bath accessories',
  'adhesives & sealants',
  'installation & sundries',
  'surface prep & levelers',
  'tools & trowels',
]);

// Synonyms: if any of these words/phrases are found in the name, the type is already present
const SUFFIX_SYNONYMS = {
  'Engineered Hardwood': ['engineered hardwood', 'engineered wood', 'eng hardwood', 'eng. hardwood'],
  'Solid Hardwood': ['solid hardwood', 'solid wood'],
  'Porcelain Tile': ['porcelain tile', 'porcelain'],
  'Ceramic Tile': ['ceramic tile', 'ceramic'],
  'Mosaic Tile': ['mosaic tile', 'mosaic'],
  'Natural Stone Tile': ['natural stone', 'stone tile', 'marble tile', 'travertine tile', 'slate tile', 'granite tile', 'limestone tile', 'onyx tile'],
  'Backsplash Tile': ['backsplash tile', 'backsplash'],
  'Decorative Tile': ['decorative tile', 'deco tile'],
  'Luxury Vinyl Plank': ['luxury vinyl plank', 'vinyl plank', 'lvp'],
  'Luxury Vinyl Tile': ['luxury vinyl tile', 'vinyl tile', 'lvt'],
  'SPC Vinyl': ['spc vinyl', 'spc flooring', 'spc'],
  'WPC Vinyl': ['wpc vinyl', 'wpc flooring', 'wpc'],
  'Laminate': ['laminate flooring', 'laminate'],
  'Carpet': ['carpet'],
  'Carpet Tile': ['carpet tile', 'carpet square'],
  'Porcelain Slab': ['porcelain slab', 'slab'],
  'Quartz Countertop': ['quartz countertop', 'quartz slab', 'quartz surface', 'countertop'],
  'Granite Countertop': ['granite countertop', 'granite slab', 'countertop'],
  'Quartzite Countertop': ['quartzite countertop', 'quartzite slab', 'countertop'],
  'Marble Countertop': ['marble countertop', 'marble slab', 'countertop'],
  'Soapstone Countertop': ['soapstone countertop', 'soapstone slab', 'countertop'],
  'Prefabricated Countertop': ['prefabricated countertop', 'prefab countertop', 'pre-fab', 'prefab', 'countertop'],
  'Countertop': ['countertop', 'counter top'],
  'Pool Tile': ['pool tile'],
  'Wood Look Tile': ['wood look tile', 'wood-look tile'],
  'Large Format Tile': ['large format tile', 'large format'],
  'Fluted Tile': ['fluted tile'],
  'Commercial Tile': ['commercial tile'],
  'Luxury Vinyl': ['luxury vinyl', 'lvp', 'lvt', 'vinyl plank', 'vinyl tile'],
  'Hardwood': ['hardwood'],
  'Waterproof Wood': ['waterproof wood', 'waterproof hardwood'],
  'Rubber Flooring': ['rubber flooring', 'rubber floor'],
  'Artificial Turf': ['artificial turf', 'synthetic turf', 'fake grass'],
  'Vanity': ['vanity', 'vanities'],
  'Vanity Top': ['vanity top'],
  'Molding': ['molding', 'moulding', 'transition', 'reducer', 't-molding', 't-mold', 'quarter round', 'stair nose', 'end cap'],
  'Wall Base': ['wall base', 'baseboard', 'base board', 'cove base'],
  'Underlayment': ['underlayment', 'underlay'],
  'Stair Tread': ['stair tread', 'stair nose', 'nosing', 'stair nosing'],
  'Paver': ['paver', 'pavers', 'hardscape'],
  'Stacked Stone': ['stacked stone', 'ledger stone', 'ledger panel', 'stone veneer', 'stacked-stone'],
  'Faucet': ['faucet'],
  'Mirror': ['mirror'],
  'Sink': ['sink'],
  'Shower System': ['shower system', 'shower panel'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if a product name already contains the type suffix or a synonym */
function nameAlreadyHasType(name, suffix) {
  const nameLower = name.toLowerCase();

  // Check exact suffix
  if (nameLower.includes(suffix.toLowerCase())) return true;

  // Check individual words of multi-word suffix (both words present)
  const suffixWords = suffix.toLowerCase().split(/\s+/);
  if (suffixWords.length > 1 && suffixWords.every(w => nameLower.includes(w))) return true;

  // Check synonyms
  const synonyms = SUFFIX_SYNONYMS[suffix];
  if (synonyms) {
    for (const syn of synonyms) {
      // For short synonyms (single word, ≤4 chars), require word boundary match
      if (!syn.includes(' ') && syn.length <= 4) {
        const regex = new RegExp('\\b' + syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (regex.test(name)) return true;
      } else {
        if (nameLower.includes(syn.toLowerCase())) return true;
      }
    }
  }

  return false;
}

/** Get the suffix for a category name. Returns null if category should be skipped. */
function getSuffixForCategory(categoryName) {
  if (!categoryName) return null;
  const catLower = categoryName.toLowerCase().trim();
  if (SKIP_CATEGORIES.has(catLower)) return null;
  return CATEGORY_SUFFIX_MAP[catLower] || null;
}

// ---------------------------------------------------------------------------
// Phase A: Restore lost variant info
// ---------------------------------------------------------------------------

async function phaseA() {
  console.log('\n' + '='.repeat(70));
  console.log('  PHASE A: Restore Lost Variant Info');
  console.log('='.repeat(70));

  // Find products where display_name equals collection but name has more info
  let query = `
    SELECT p.id, p.name, p.display_name, p.collection, v.name AS vendor_name, v.code AS vendor_code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
      AND p.display_name IS NOT NULL
      AND p.collection IS NOT NULL
      AND LOWER(TRIM(p.display_name)) = LOWER(TRIM(p.collection))
      AND LOWER(TRIM(p.name)) != LOWER(TRIM(p.collection))
      AND LENGTH(TRIM(p.name)) > LENGTH(TRIM(p.collection))
  `;
  const params = [];
  if (VENDOR_FILTER) {
    params.push(VENDOR_FILTER.toUpperCase());
    query += ` AND UPPER(v.code) = $${params.length}`;
  }
  query += ' ORDER BY v.name, p.collection, p.name';

  const { rows: products } = await pool.query(query, params);
  console.log(`  Found ${products.length} products where display_name = collection but name has more info.\n`);

  // Also find products where display_name = collection AND name = collection (need color attribute)
  let query2 = `
    SELECT p.id, p.name, p.display_name, p.collection, v.name AS vendor_name, v.code AS vendor_code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE p.status = 'active'
      AND p.display_name IS NOT NULL
      AND p.collection IS NOT NULL
      AND LOWER(TRIM(p.display_name)) = LOWER(TRIM(p.collection))
      AND LOWER(TRIM(p.name)) = LOWER(TRIM(p.collection))
  `;
  const params2 = [];
  if (VENDOR_FILTER) {
    params2.push(VENDOR_FILTER.toUpperCase());
    query2 += ` AND UPPER(v.code) = $${params2.length}`;
  }
  query2 += ' ORDER BY v.name, p.collection, p.name';

  const { rows: sameNameProducts } = await pool.query(query2, params2);
  console.log(`  Found ${sameNameProducts.length} products where display_name = collection = name (need color).\n`);

  // Fetch most common color per product for the sameNameProducts
  const colorProductIds = sameNameProducts.map(p => p.id);
  let productColorMap = new Map();
  if (colorProductIds.length > 0) {
    const colorQuery = `
      SELECT
        s.product_id,
        sa.value AS color,
        COUNT(*) AS cnt
      FROM skus s
      JOIN sku_attributes sa ON sa.sku_id = s.id
      JOIN attributes a ON a.id = sa.attribute_id
      WHERE a.slug = 'color'
        AND s.status = 'active'
        AND s.is_sample = false
        AND s.product_id = ANY($1::uuid[])
      GROUP BY s.product_id, sa.value
      ORDER BY s.product_id, cnt DESC, sa.value ASC
    `;
    const { rows: colorRows } = await pool.query(colorQuery, [colorProductIds]);
    for (const row of colorRows) {
      if (!productColorMap.has(row.product_id)) {
        let color = row.color;
        if (color && color.includes(',')) {
          color = color.split(',')[0].trim();
        }
        productColorMap.set(row.product_id, color);
      }
    }
  }

  const updates = [];

  // Group 1: name has more info than collection — restore name
  for (const p of products) {
    if (LIMIT && updates.length >= LIMIT) break;
    const newDisplayName = p.name.trim();
    if (newDisplayName && newDisplayName !== p.display_name) {
      updates.push({
        id: p.id,
        display_name: newDisplayName,
        oldDisplayName: p.display_name,
        name: p.name,
        collection: p.collection,
        vendor: p.vendor_name,
        reason: 'name has variant info',
      });
    }
  }

  // Group 2: name = collection — derive from collection + color
  for (const p of sameNameProducts) {
    if (LIMIT && updates.length >= LIMIT) break;
    const color = productColorMap.get(p.id);
    if (color && color.toLowerCase() !== p.collection.toLowerCase().trim()) {
      const newDisplayName = `${p.collection.trim()} ${color}`;
      updates.push({
        id: p.id,
        display_name: newDisplayName,
        oldDisplayName: p.display_name,
        name: p.name,
        collection: p.collection,
        vendor: p.vendor_name,
        reason: 'derived from collection + color',
      });
    }
  }

  // Print samples
  console.log('-'.repeat(70));
  console.log('  PHASE A SAMPLES (up to 20)');
  console.log('-'.repeat(70));
  for (const u of updates.slice(0, 20)) {
    console.log(`  [${u.vendor}] "${u.oldDisplayName}" → "${u.display_name}" (${u.reason})`);
  }
  console.log(`\n  Total Phase A updates: ${updates.length}\n`);

  return updates;
}

// ---------------------------------------------------------------------------
// Phase B: Append product type suffix
// ---------------------------------------------------------------------------

async function phaseB() {
  console.log('\n' + '='.repeat(70));
  console.log('  PHASE B: Append Product Type Suffix');
  console.log('='.repeat(70));

  // Fetch all active products with their category
  let query = `
    SELECT p.id, p.name, p.display_name, p.collection,
           c.name AS category_name, v.name AS vendor_name, v.code AS vendor_code
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.status = 'active'
  `;
  const params = [];
  if (VENDOR_FILTER) {
    params.push(VENDOR_FILTER.toUpperCase());
    query += ` AND UPPER(v.code) = $${params.length}`;
  }
  query += ' ORDER BY v.name, c.name, COALESCE(p.display_name, p.name)';

  const { rows: products } = await pool.query(query, params);
  console.log(`  Found ${products.length} active products to check.\n`);

  const updates = [];
  const stats = { appended: 0, alreadyHasType: 0, noCategory: 0, skippedCategory: 0 };

  for (const p of products) {
    if (LIMIT && updates.length >= LIMIT) break;

    const currentName = (p.display_name || p.name || '').trim();
    if (!currentName) continue;

    const suffix = getSuffixForCategory(p.category_name);
    if (!suffix) {
      if (!p.category_name) stats.noCategory++;
      else stats.skippedCategory++;
      continue;
    }

    if (nameAlreadyHasType(currentName, suffix)) {
      stats.alreadyHasType++;
      continue;
    }

    const newDisplayName = `${currentName} ${suffix}`;
    stats.appended++;
    updates.push({
      id: p.id,
      display_name: newDisplayName,
      oldDisplayName: currentName,
      category: p.category_name,
      vendor: p.vendor_name,
      suffix,
    });
  }

  // Print stats
  console.log('-'.repeat(70));
  console.log('  PHASE B STATS');
  console.log('-'.repeat(70));
  console.log(`  Suffix appended:     ${stats.appended}`);
  console.log(`  Already has type:    ${stats.alreadyHasType}`);
  console.log(`  No category:         ${stats.noCategory}`);
  console.log(`  Skipped category:    ${stats.skippedCategory}`);
  console.log();

  // Per-category breakdown
  const catCounts = {};
  for (const u of updates) {
    catCounts[u.category] = (catCounts[u.category] || 0) + 1;
  }
  console.log('-'.repeat(70));
  console.log('  PER-CATEGORY BREAKDOWN');
  console.log('-'.repeat(70));
  const catEntries = Object.entries(catCounts).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of catEntries) {
    const suffix = getSuffixForCategory(cat);
    console.log(`  ${cat.padEnd(30)} → "${suffix}"  (${count} products)`);
  }
  console.log();

  // Print samples
  console.log('-'.repeat(70));
  console.log('  PHASE B SAMPLES (up to 20)');
  console.log('-'.repeat(70));
  // Show variety across categories
  const shown = new Set();
  let count = 0;
  for (const u of updates) {
    if (count >= 20) break;
    if (shown.size < 10 && shown.has(u.category) && count > 5) continue;
    shown.add(u.category);
    console.log(`  [${u.vendor}] "${u.oldDisplayName}" → "${u.display_name}" (${u.category})`);
    count++;
  }
  console.log(`\n  Total Phase B updates: ${updates.length}\n`);

  return updates;
}

// ---------------------------------------------------------------------------
// Apply updates
// ---------------------------------------------------------------------------

async function applyUpdates(updates, phaseName) {
  if (!updates.length) {
    console.log(`  ${phaseName}: No updates to apply.`);
    return 0;
  }

  if (DRY_RUN) {
    console.log(`  ${phaseName}: ${updates.length} updates would be applied (DRY RUN).`);
    return 0;
  }

  console.log(`  ${phaseName}: Applying ${updates.length} updates...`);
  let applied = 0;

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const ids = batch.map(u => u.id);
    const names = batch.map(u => u.display_name);

    await pool.query(`
      UPDATE products
      SET display_name = batch.display_name,
          updated_at = NOW()
      FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS display_name) AS batch
      WHERE products.id = batch.id
    `, [ids, names]);

    applied += batch.length;
    if (applied % 500 === 0 || applied === updates.length) {
      console.log(`    Updated ${applied} / ${updates.length} products...`);
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(70));
  console.log('  FIX PRODUCT DISPLAY NAMES');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (will update DB)'}`);
  if (VENDOR_FILTER) console.log(`  Vendor filter: ${VENDOR_FILTER}`);
  if (PHASE_FILTER) console.log(`  Phase filter: ${PHASE_FILTER}`);
  if (LIMIT) console.log(`  Limit: ${LIMIT}`);
  console.log('='.repeat(70));

  let phaseAUpdates = [];
  let phaseBUpdates = [];

  // Phase A: Restore lost variant info
  if (!PHASE_FILTER || PHASE_FILTER === 'A') {
    phaseAUpdates = await phaseA();
  }

  // Apply Phase A before Phase B so Phase B sees the corrected display_names
  if (phaseAUpdates.length > 0) {
    const applied = await applyUpdates(phaseAUpdates, 'Phase A');
    if (applied > 0) {
      console.log(`  Phase A: ${applied} products updated.\n`);
    }
  }

  // Phase B: Append product type suffix
  if (!PHASE_FILTER || PHASE_FILTER === 'B') {
    phaseBUpdates = await phaseB();
  }

  if (phaseBUpdates.length > 0) {
    const applied = await applyUpdates(phaseBUpdates, 'Phase B');
    if (applied > 0) {
      console.log(`  Phase B: ${applied} products updated.\n`);
    }
  }

  // Final summary
  console.log('='.repeat(70));
  if (DRY_RUN) {
    console.log(`  DRY RUN COMPLETE — no changes made.`);
    console.log(`  Phase A would update: ${phaseAUpdates.length} products`);
    console.log(`  Phase B would update: ${phaseBUpdates.length} products`);
    console.log(`  Total: ${phaseAUpdates.length + phaseBUpdates.length} products`);
    console.log('  Remove --dry-run to apply.');
  } else {
    console.log(`  DONE`);
    console.log(`  Phase A updated: ${phaseAUpdates.length} products`);
    console.log(`  Phase B updated: ${phaseBUpdates.length} products`);
    console.log(`  Total: ${phaseAUpdates.length + phaseBUpdates.length} products`);
  }
  console.log('='.repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
