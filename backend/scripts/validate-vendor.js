#!/usr/bin/env node

/**
 * Vendor Data Quality Validator
 *
 * Usage:
 *   node backend/scripts/validate-vendor.js --vendor "Shaw"
 *   node backend/scripts/validate-vendor.js --vendor "MSI" --json
 *   node backend/scripts/validate-vendor.js --vendor "Bedrosians" --fix
 *   node backend/scripts/validate-vendor.js --vendor "Shaw" --check-urls
 */

import pg from 'pg';
import { parseArgs } from 'node:util';

// ==================== CLI Argument Parsing ====================

const { values: args } = parseArgs({
  options: {
    vendor: { type: 'string' },
    fix: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'check-urls': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (args.help || !args.vendor) {
  console.log(`
Vendor Data Quality Validator

Usage:
  node backend/scripts/validate-vendor.js --vendor "VendorName"

Flags:
  --vendor "Name"    Vendor name to validate (required, case-insensitive partial match)
  --fix              Auto-fix trivial issues (e.g., set missing sell_by to 'sqft')
  --json             Output results as JSON
  --check-urls       HEAD-request a sample of image URLs to check for broken links
  --help             Show this help
  `);
  process.exit(0);
}

// ==================== DB Connection ====================

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: 5432,
  database: 'flooring_pim',
  user: 'postgres',
  password: 'postgres',
});

// ==================== Color Helpers ====================

const colors = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const SEVERITY_COLORS = {
  ERROR: colors.red,
  WARNING: colors.yellow,
  INFO: colors.cyan,
};

// ==================== Checks ====================

async function findVendor(vendorName) {
  const result = await pool.query(
    `SELECT id, name, code FROM vendors WHERE LOWER(name) LIKE $1 ORDER BY name LIMIT 1`,
    [`%${vendorName.toLowerCase()}%`]
  );
  return result.rows[0] || null;
}

async function runChecks(vendorId, vendorName) {
  const results = [];

  // 1. Products with no SKUs
  const noSkus = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    LEFT JOIN skus s ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.id IS NULL
  `, [vendorId]);
  results.push({
    check: 'Products with no SKUs',
    severity: 'ERROR',
    count: noSkus.rowCount,
    items: noSkus.rows.map(r => ({ id: r.id, name: r.name, collection: r.collection })),
  });

  // 2. SKUs with no pricing
  const noPricing = await pool.query(`
    SELECT s.id, s.internal_sku, s.vendor_sku, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND pr.sku_id IS NULL
  `, [vendorId]);
  results.push({
    check: 'SKUs with no pricing',
    severity: 'ERROR',
    count: noPricing.rowCount,
    items: noPricing.rows.slice(0, 20).map(r => ({ id: r.id, sku: r.internal_sku, product: r.product_name })),
  });

  // 3. SKUs with no primary image
  const noImage = await pool.query(`
    SELECT s.id, s.internal_sku, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN media_assets ma ON (ma.sku_id = s.id OR (ma.product_id = p.id AND ma.sku_id IS NULL)) AND ma.asset_type = 'primary'
    WHERE p.vendor_id = $1 AND ma.id IS NULL
  `, [vendorId]);
  results.push({
    check: 'SKUs with no primary image',
    severity: 'WARNING',
    count: noImage.rowCount,
    items: noImage.rows.slice(0, 20).map(r => ({ id: r.id, sku: r.internal_sku, product: r.product_name })),
  });

  // 4. Products with no description
  const noDesc = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1
      AND (p.description_short IS NULL OR p.description_short = '')
      AND (p.description_long IS NULL OR p.description_long = '')
  `, [vendorId]);
  results.push({
    check: 'Products with no description',
    severity: 'WARNING',
    count: noDesc.rowCount,
    items: noDesc.rows.slice(0, 20).map(r => ({ id: r.id, name: r.name, collection: r.collection })),
  });

  // 5. SKUs with no packaging
  const noPkg = await pool.query(`
    SELECT s.id, s.internal_sku, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    WHERE p.vendor_id = $1 AND pk.sku_id IS NULL
  `, [vendorId]);
  results.push({
    check: 'SKUs with no packaging',
    severity: 'WARNING',
    count: noPkg.rowCount,
    items: noPkg.rows.slice(0, 20).map(r => ({ id: r.id, sku: r.internal_sku, product: r.product_name })),
  });

  // 6. SKUs with zero attributes
  const noAttrs = await pool.query(`
    SELECT s.id, s.internal_sku, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    WHERE p.vendor_id = $1
    GROUP BY s.id, s.internal_sku, p.name
    HAVING COUNT(sa.attribute_id) = 0
  `, [vendorId]);
  results.push({
    check: 'SKUs with zero attributes',
    severity: 'WARNING',
    count: noAttrs.rowCount,
    items: noAttrs.rows.slice(0, 20).map(r => ({ id: r.id, sku: r.internal_sku, product: r.product_name })),
  });

  // 7. Duplicate internal_skus
  const dupes = await pool.query(`
    SELECT s.internal_sku, COUNT(*)::int as cnt
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
    GROUP BY s.internal_sku
    HAVING COUNT(*) > 1
  `, [vendorId]);
  results.push({
    check: 'Duplicate internal_skus',
    severity: 'ERROR',
    count: dupes.rowCount,
    items: dupes.rows.map(r => ({ sku: r.internal_sku, count: r.cnt })),
  });

  // 8. Suspicious pricing
  const badPrices = await pool.query(`
    SELECT s.id, s.internal_sku, pr.retail_price, pr.cost, p.name as product_name
    FROM pricing pr
    JOIN skus s ON pr.sku_id = s.id
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1
      AND (pr.retail_price < 0.10 OR pr.retail_price > 500 OR pr.cost > pr.retail_price)
  `, [vendorId]);
  results.push({
    check: 'Suspicious pricing (< $0.10, > $500, or cost > retail)',
    severity: 'WARNING',
    count: badPrices.rowCount,
    items: badPrices.rows.slice(0, 20).map(r => ({
      id: r.id, sku: r.internal_sku, product: r.product_name,
      retail: parseFloat(r.retail_price), cost: parseFloat(r.cost),
    })),
  });

  // 9. Missing sell_by
  const noSellBy = await pool.query(`
    SELECT s.id, s.internal_sku, p.name as product_name
    FROM skus s
    JOIN products p ON s.product_id = p.id
    WHERE p.vendor_id = $1 AND s.sell_by IS NULL
  `, [vendorId]);
  results.push({
    check: 'SKUs with missing sell_by',
    severity: 'WARNING',
    count: noSellBy.rowCount,
    items: noSellBy.rows.slice(0, 20).map(r => ({ id: r.id, sku: r.internal_sku, product: r.product_name })),
  });

  // 10. Missing category
  const noCat = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1 AND p.category_id IS NULL
  `, [vendorId]);
  results.push({
    check: 'Products with no category',
    severity: 'WARNING',
    count: noCat.rowCount,
    items: noCat.rows.slice(0, 20).map(r => ({ id: r.id, name: r.name, collection: r.collection })),
  });

  // 11. Draft products
  const drafts = await pool.query(`
    SELECT p.id, p.name, p.collection
    FROM products p
    WHERE p.vendor_id = $1 AND p.status = 'draft'
  `, [vendorId]);
  results.push({
    check: 'Products still in draft status',
    severity: 'INFO',
    count: drafts.rowCount,
    items: drafts.rows.slice(0, 10).map(r => ({ id: r.id, name: r.name, collection: r.collection })),
  });

  return results;
}

// ==================== URL Check ====================

async function checkImageUrls(vendorId) {
  const sample = await pool.query(`
    SELECT ma.id, ma.url
    FROM media_assets ma
    JOIN products p ON ma.product_id = p.id
    WHERE p.vendor_id = $1 AND ma.url LIKE 'http%'
    ORDER BY RANDOM()
    LIMIT 25
  `, [vendorId]);

  if (sample.rowCount === 0) return { check: 'Broken image URLs', severity: 'INFO', count: 0, items: [], note: 'No HTTP image URLs found' };

  const broken = [];
  for (const row of sample.rows) {
    try {
      const resp = await fetch(row.url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
      if (!resp.ok) broken.push({ id: row.id, url: row.url, status: resp.status });
    } catch (err) {
      broken.push({ id: row.id, url: row.url, status: err.message });
    }
  }

  return {
    check: `Broken image URLs (sampled ${sample.rowCount})`,
    severity: broken.length > 0 ? 'ERROR' : 'INFO',
    count: broken.length,
    items: broken,
  };
}

// ==================== Auto-Fix ====================

async function autoFix(vendorId) {
  const fixes = [];

  // Fix missing sell_by → default to 'sqft'
  const sellByResult = await pool.query(`
    UPDATE skus s SET sell_by = 'sqft'
    FROM products p
    WHERE s.product_id = p.id AND p.vendor_id = $1 AND s.sell_by IS NULL
    RETURNING s.id
  `, [vendorId]);
  if (sellByResult.rowCount > 0) {
    fixes.push(`Set sell_by = 'sqft' on ${sellByResult.rowCount} SKUs`);
  }

  return fixes;
}

// ==================== Summary Stats ====================

async function getSummaryStats(vendorId) {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM products WHERE vendor_id = $1) as total_products,
      (SELECT COUNT(*)::int FROM skus s JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1) as total_skus,
      (SELECT COUNT(*)::int FROM pricing pr JOIN skus s ON pr.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1) as skus_with_pricing,
      (SELECT COUNT(DISTINCT COALESCE(ma.sku_id, ma.product_id))::int FROM media_assets ma JOIN products p ON ma.product_id = p.id WHERE p.vendor_id = $1 AND ma.asset_type = 'primary') as items_with_primary_image,
      (SELECT COUNT(*)::int FROM packaging pk JOIN skus s ON pk.sku_id = s.id JOIN products p ON s.product_id = p.id WHERE p.vendor_id = $1) as skus_with_packaging
  `, [vendorId]);
  return result.rows[0];
}

// ==================== Output ====================

function printResults(vendorName, stats, results, fixes) {
  console.log('');
  console.log(colors.bold(`  Vendor Data Quality Report: ${vendorName}`));
  console.log(colors.dim('  ' + '─'.repeat(50)));
  console.log('');

  // Summary stats
  console.log(`  ${colors.bold('Summary')}`);
  console.log(`  Total Products:        ${stats.total_products}`);
  console.log(`  Total SKUs:            ${stats.total_skus}`);
  if (stats.total_skus > 0) {
    const pricePct = ((stats.skus_with_pricing / stats.total_skus) * 100).toFixed(1);
    const imagePct = ((stats.items_with_primary_image / stats.total_skus) * 100).toFixed(1);
    const pkgPct = ((stats.skus_with_packaging / stats.total_skus) * 100).toFixed(1);
    console.log(`  Pricing Coverage:      ${colorPct(pricePct)}%`);
    console.log(`  Image Coverage:        ${colorPct(imagePct)}%`);
    console.log(`  Packaging Coverage:    ${colorPct(pkgPct)}%`);
  }
  console.log('');

  // Check results
  let errors = 0, warnings = 0, infos = 0;
  for (const r of results) {
    const colorFn = SEVERITY_COLORS[r.severity] || colors.dim;
    const badge = colorFn(`[${r.severity}]`);
    const countStr = r.count > 0 ? colors.bold(String(r.count)) : colors.green('0');
    console.log(`  ${badge} ${r.check}: ${countStr}`);

    if (r.count > 0 && r.items.length > 0 && r.severity !== 'INFO') {
      const show = r.items.slice(0, 5);
      for (const item of show) {
        const desc = item.sku || item.name || item.internal_sku || JSON.stringify(item);
        console.log(colors.dim(`         → ${desc}`));
      }
      if (r.items.length > 5) {
        console.log(colors.dim(`         ... and ${r.items.length - 5} more`));
      }
    }

    if (r.severity === 'ERROR') errors += r.count;
    else if (r.severity === 'WARNING') warnings += r.count;
    else infos += r.count;
  }

  console.log('');
  console.log(colors.dim('  ' + '─'.repeat(50)));
  console.log(`  ${colors.red(`${errors} errors`)}  ${colors.yellow(`${warnings} warnings`)}  ${colors.cyan(`${infos} info`)}`);

  // Fixes applied
  if (fixes && fixes.length > 0) {
    console.log('');
    console.log(colors.green('  Fixes applied:'));
    for (const fix of fixes) {
      console.log(colors.green(`    ✓ ${fix}`));
    }
  }

  console.log('');
  return errors;
}

function colorPct(pct) {
  const n = parseFloat(pct);
  if (n >= 90) return colors.green(pct);
  if (n >= 60) return colors.yellow(pct);
  return colors.red(pct);
}

// ==================== Main ====================

async function main() {
  try {
    const vendor = await findVendor(args.vendor);
    if (!vendor) {
      console.error(`\nVendor "${args.vendor}" not found. Available vendors:`);
      const all = await pool.query('SELECT name, code FROM vendors ORDER BY name');
      for (const v of all.rows) console.error(`  - ${v.name} (${v.code})`);
      process.exit(1);
    }

    const results = await runChecks(vendor.id, vendor.name);

    if (args['check-urls']) {
      const urlResult = await checkImageUrls(vendor.id);
      results.push(urlResult);
    }

    let fixes = [];
    if (args.fix) {
      fixes = await autoFix(vendor.id);
    }

    const stats = await getSummaryStats(vendor.id);

    if (args.json) {
      console.log(JSON.stringify({
        vendor: { id: vendor.id, name: vendor.name, code: vendor.code },
        stats,
        results: results.map(r => ({ check: r.check, severity: r.severity, count: r.count, items: r.items })),
        fixes,
      }, null, 2));
    } else {
      const errorCount = printResults(vendor.name, stats, results, fixes);
      process.exit(errorCount > 0 ? 1 : 0);
    }
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(2);
  } finally {
    await pool.end();
  }
}

main();
