#!/usr/bin/env node
/**
 * audit-daltile-products.cjs — Cross-reference our Daltile DB products against
 * Daltile's live Coveo catalog. Identifies:
 *   1. Ghost products (in our DB but not in Coveo)
 *   2. Duplicate products (same tile stored under multiple names)
 *   3. Orphan color products (individual color as product when parent has it as SKU)
 *   4. LVF accessory products that should be merged
 *   5. Products in Coveo we're missing
 *
 * Usage:
 *   node backend/scripts/audit-daltile-products.cjs
 *   node backend/scripts/audit-daltile-products.cjs --fix   # Deactivate ghosts & merge duplicates
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const FIX_MODE = process.argv.includes('--fix');
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();

// ─── Coveo ──────────────────────────────────────────────────────────────────

const COVEO_FIELDS = [
  'sku', 'seriesname', 'colornameenglish', 'colorcode',
  'producttype', 'sizemaindisplay', 'finish',
];

const PRODUCT_TYPE_SPLITS = [
  'Floor Tile', 'Floor Tile Trim', 'Floor Tile Deco',
  'Wall Tile', 'Wall Tile Trim', 'Wall Tile Deco',
  'Wall Bathroom Accessories',
  'Mosaic Tile', 'Mosaic Tile Trim', 'Mosaic Natural Stone Tile',
  'Stone Tile', 'Stone Tile Trim',
  'LVT Trim', 'LVT Plank', 'Luxury Vinyl Tile',
  'Porcelain Slab', 'Quartz Slab', 'Natural Stone Slab',
  'Quarry Tile', 'Quarry Tile Trim',
  'Windowsills-Thresholds',
];

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="www.daltile.com" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch('https://www.daltile.com/coveo/rest/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

async function fetchAllCoveo() {
  const probe = await queryCoveo('', 0, 0);
  const total = probe.totalCount || 0;
  console.log(`  Coveo total: ${total}`);

  const allResults = [];
  const seen = new Set();

  for (const pt of PRODUCT_TYPE_SPLITS) {
    const pProbe = await queryCoveo(` @producttype=="${pt}"`, 0, 0);
    const cnt = pProbe.totalCount || 0;
    if (cnt === 0) continue;

    let offset = 0;
    while (offset < cnt && offset < 5000) {
      const page = Math.min(1000, cnt - offset);
      const resp = await queryCoveo(` @producttype=="${pt}"`, offset, page);
      const batch = resp.results || [];
      if (batch.length === 0) break;
      for (const r of batch) {
        const raw = r.raw || {};
        const sku = String(raw.sku || '').trim().toUpperCase();
        const key = sku.split(/[;,]/).map(s => s.trim()).sort().join('|');
        if (key && !seen.has(key)) { seen.add(key); allResults.push(r); }
      }
      offset += batch.length;
      if (offset < cnt) await delay(150);
    }
  }

  // Catch-all
  const catchFilter = PRODUCT_TYPE_SPLITS.map(t => ` @producttype<>"${t}"`).join('');
  const catchProbe = await queryCoveo(catchFilter, 0, 0);
  if ((catchProbe.totalCount || 0) > 0) {
    let offset = 0;
    while (offset < catchProbe.totalCount && offset < 5000) {
      const resp = await queryCoveo(catchFilter, offset, Math.min(1000, catchProbe.totalCount - offset));
      const batch = resp.results || [];
      if (batch.length === 0) break;
      for (const r of batch) {
        const raw = r.raw || {};
        const sku = String(raw.sku || '').trim().toUpperCase();
        const key = sku.split(/[;,]/).map(s => s.trim()).sort().join('|');
        if (key && !seen.has(key)) { seen.add(key); allResults.push(r); }
      }
      offset += batch.length;
      if (offset < catchProbe.totalCount) await delay(150);
    }
  }

  return allResults;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(FIX_MODE ? '\n=== FIX MODE ===\n' : '\n=== AUDIT MODE ===\n');

  // Load DB data
  const vendorRes = await pool.query("SELECT id FROM vendors WHERE name ILIKE '%daltile%' LIMIT 1");
  if (vendorRes.rows.length === 0) { console.log('No Daltile vendor'); return; }
  const vendorId = vendorRes.rows[0].id;

  const productRes = await pool.query(`
    SELECT p.id, p.name, p.display_name, p.collection, p.status
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active'
    ORDER BY p.collection, p.name
  `, [vendorId]);
  const products = productRes.rows;

  const skuRes = await pool.query(`
    SELECT s.id as sku_id, s.product_id, s.vendor_sku, s.status
    FROM skus s JOIN products p ON p.id = s.product_id
    WHERE p.vendor_id = $1 AND p.status = 'active'
  `, [vendorId]);

  // Build lookup maps
  const skusByProduct = new Map();
  const allDbSkus = new Set();
  for (const s of skuRes.rows) {
    if (!s.vendor_sku) continue;
    const upper = s.vendor_sku.toUpperCase();
    allDbSkus.add(upper);
    if (!skusByProduct.has(s.product_id)) skusByProduct.set(s.product_id, []);
    skusByProduct.get(s.product_id).push({ ...s, upper });
  }

  console.log(`DB: ${products.length} products, ${allDbSkus.size} unique SKUs\n`);

  // Fetch Coveo
  console.log('Fetching Coveo catalog...');
  const coveoResults = await fetchAllCoveo();
  console.log(`  Fetched ${coveoResults.length} Coveo entries\n`);

  // Build Coveo indexes
  const coveoBysku = new Map();       // UPPER sku → coveo entry
  const coveoSeries = new Map();      // norm(series) → Set<colorcode>
  const coveoColorCodes = new Set();  // all known color codes
  const coveoSeriesNames = new Set(); // all series names
  const allCoveoSkus = new Set();

  for (const r of coveoResults) {
    const raw = r.raw || {};
    const skuStr = String(raw.sku || '').trim();
    const series = String(raw.seriesname || '').trim();
    const cc = String(raw.colorcode || '').trim().toUpperCase();

    if (skuStr) {
      for (const s of skuStr.split(/[;,]/)) {
        const u = s.trim().toUpperCase();
        if (u) { coveoBysku.set(u, raw); allCoveoSkus.add(u); }
      }
    }
    if (cc) coveoColorCodes.add(cc);
    if (series) {
      coveoSeriesNames.add(norm(series));
      const key = norm(series);
      if (!coveoSeries.has(key)) coveoSeries.set(key, new Set());
      if (cc) coveoSeries.get(key).add(cc);
    }
  }

  console.log(`Coveo indexes: ${coveoBysku.size} SKU keys, ${coveoSeriesNames.size} series, ${coveoColorCodes.size} color codes\n`);

  // ─── Analysis ───────────────────────────────────────────────────────────

  // 1. SKU-level cross-reference: which of our SKUs exist in Coveo?
  let skuMatchCount = 0, skuMissCount = 0;
  const unmatchedSkus = [];
  for (const sku of allDbSkus) {
    if (coveoBysku.has(sku)) {
      skuMatchCount++;
    } else {
      skuMissCount++;
      unmatchedSkus.push(sku);
    }
  }
  console.log('=== SKU Cross-Reference ===');
  console.log(`  Matched in Coveo: ${skuMatchCount} (${(skuMatchCount / allDbSkus.size * 100).toFixed(1)}%)`);
  console.log(`  Not in Coveo:     ${skuMissCount} (${(skuMissCount / allDbSkus.size * 100).toFixed(1)}%)\n`);

  // 2. Product-level: does each product have AT LEAST one SKU in Coveo?
  const productsCoveoMatch = [];
  const productsNoMatch = [];
  const productsSeriesMatch = [];

  for (const p of products) {
    const skus = skusByProduct.get(p.id) || [];
    const hasSkuMatch = skus.some(s => coveoBysku.has(s.upper));

    if (hasSkuMatch) {
      productsCoveoMatch.push(p);
    } else {
      // Try series-level match
      const seriesMatch = coveoSeriesNames.has(norm(p.collection));
      if (seriesMatch) {
        productsSeriesMatch.push(p);
      } else {
        productsNoMatch.push(p);
      }
    }
  }

  console.log('=== Product Validation ===');
  console.log(`  SKU match in Coveo:    ${productsCoveoMatch.length} products (${(productsCoveoMatch.length / products.length * 100).toFixed(1)}%)`);
  console.log(`  Series match only:     ${productsSeriesMatch.length} products (real series but SKUs not in Coveo)`);
  console.log(`  NO match (ghosts?):    ${productsNoMatch.length} products\n`);

  if (productsNoMatch.length > 0) {
    console.log('  Ghost candidates (collection not in Coveo):');
    // Group by collection
    const ghostByCollection = new Map();
    for (const p of productsNoMatch) {
      if (!ghostByCollection.has(p.collection)) ghostByCollection.set(p.collection, []);
      ghostByCollection.get(p.collection).push(p);
    }
    for (const [coll, prods] of [...ghostByCollection.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const skuCount = prods.reduce((sum, p) => sum + (skusByProduct.get(p.id) || []).length, 0);
      console.log(`    ${coll}: ${prods.length} products, ${skuCount} SKUs`);
      for (const p of prods.slice(0, 3)) {
        console.log(`      - ${p.name}`);
      }
      if (prods.length > 3) console.log(`      ... and ${prods.length - 3} more`);
    }
    console.log();
  }

  // 3. LVF products analysis
  const lvfProducts = products.filter(p => p.name.startsWith('Lvf '));
  console.log('=== LVF Accessory Products ===');
  console.log(`  Total: ${lvfProducts.length}`);

  // Group LVF by collection
  const lvfByCollection = new Map();
  for (const p of lvfProducts) {
    if (!lvfByCollection.has(p.collection)) lvfByCollection.set(p.collection, []);
    lvfByCollection.get(p.collection).push(p);
  }

  // Check if the same collection has non-LVF transition products
  let lvfMergeCandidates = 0;
  for (const [coll, lvfProds] of lvfByCollection) {
    // Find non-LVF transition products in same collection
    const nonLvfTransitions = products.filter(p =>
      p.collection === coll && !p.name.startsWith('Lvf ') &&
      /4-in-1|end cap|stair|qrtr|overlap|vslcap|vscap|vrdsn|vqrnd|extsn|slimt/i.test(p.name)
    );

    // Check if LVF SKU types overlap with non-LVF transition products
    if (nonLvfTransitions.length > 0) {
      const lvfSkuTypes = new Set();
      for (const p of lvfProds) {
        for (const s of (skusByProduct.get(p.id) || [])) {
          if (/RNDSTRD/i.test(s.upper)) lvfSkuTypes.add('round_stair_tread');
          else if (/SLIMT/i.test(s.upper)) lvfSkuTypes.add('slim_t');
          else if (/VSLCAP/i.test(s.upper)) lvfSkuTypes.add('end_cap');
          else if (/VQRND/i.test(s.upper)) lvfSkuTypes.add('quarter_round');
          else if (/VRDSN/i.test(s.upper)) lvfSkuTypes.add('stair_nose');
          else if (/EXTSN/i.test(s.upper)) lvfSkuTypes.add('extension');
          else if (/VSCAP/i.test(s.upper)) lvfSkuTypes.add('stair_cap');
          else lvfSkuTypes.add('other');
        }
      }
      lvfMergeCandidates += lvfProds.length;
    }
  }
  console.log(`  Merge candidates (LVF + non-LVF transitions exist): ${lvfMergeCandidates}`);

  // Count LVF with ONLY round stair treads (unique product not covered elsewhere)
  let lvfUniqueStairTreads = 0;
  let lvfWithMixedAccessories = 0;
  for (const p of lvfProducts) {
    const skus = skusByProduct.get(p.id) || [];
    const types = new Set(skus.map(s => {
      if (/RNDSTRD/i.test(s.upper)) return 'rst';
      if (/SLIMT/i.test(s.upper)) return 'slimt';
      if (/VSLCAP/i.test(s.upper)) return 'endcap';
      if (/VQRND/i.test(s.upper)) return 'qround';
      if (/VRDSN/i.test(s.upper)) return 'snose';
      if (/EXTSN/i.test(s.upper)) return 'extsn';
      if (/VSCAP/i.test(s.upper)) return 'scap';
      return 'other';
    }));
    if (types.size === 1 && types.has('rst')) lvfUniqueStairTreads++;
    else lvfWithMixedAccessories++;
  }
  console.log(`  LVF with only round stair treads: ${lvfUniqueStairTreads}`);
  console.log(`  LVF with mixed accessories: ${lvfWithMixedAccessories}\n`);

  // 4. Color-specific orphan products
  console.log('=== Color-Specific Orphan Products ===');
  const colorOrphans = [];
  const productsByCollection = new Map();
  for (const p of products) {
    if (!productsByCollection.has(p.collection)) productsByCollection.set(p.collection, []);
    productsByCollection.get(p.collection).push(p);
  }

  for (const p of products) {
    // Skip trim, transition, mosaic, LVF, PTS products
    if (/cv base|bn |stp ns|stair|cop |jolly|liner|chair|ogee|rope|shelf|sink|pencil|4-in-1|end cap|qrtr|overlap|vslcap|vscap|extsn|mm$|mm |mosaic|dm$|dm |xterior|paver|tread/i.test(p.name)) continue;
    if (p.name.startsWith('Lvf ') || p.name.startsWith('Pts ')) continue;

    const skus = skusByProduct.get(p.id) || [];
    if (skus.length > 2) continue; // Not a single-color product

    // Get color code prefix
    const codes = new Set(skus.map(s => s.upper.slice(0, 4)));

    // Find a parent product in same collection with more SKUs that covers these codes
    const siblings = productsByCollection.get(p.collection) || [];
    const parent = siblings.find(sib => {
      if (sib.id === p.id) return false;
      const sibSkus = skusByProduct.get(sib.id) || [];
      if (sibSkus.length <= skus.length) return false;
      const sibCodes = new Set(sibSkus.map(s => s.upper.slice(0, 4)));
      return [...codes].every(c => sibCodes.has(c));
    });

    if (parent) {
      const parentSkus = skusByProduct.get(parent.id) || [];
      // Check if the actual full SKU exists in parent too
      const skuOverlap = skus.filter(s => parentSkus.some(ps => ps.upper === s.upper));
      colorOrphans.push({
        product: p,
        parent,
        skuCount: skus.length,
        parentSkuCount: parentSkus.length,
        exactSkuOverlap: skuOverlap.length,
      });
    }
  }

  console.log(`  Total color orphans: ${colorOrphans.length}`);
  const exactDupes = colorOrphans.filter(o => o.exactSkuOverlap > 0);
  const codeOnlyDupes = colorOrphans.filter(o => o.exactSkuOverlap === 0);
  console.log(`  With exact SKU overlap (true duplicates): ${exactDupes.length}`);
  console.log(`  With color code overlap only: ${codeOnlyDupes.length}`);

  if (exactDupes.length > 0) {
    console.log('\n  True duplicates (exact SKU in both parent and orphan):');
    for (const d of exactDupes.slice(0, 15)) {
      console.log(`    ${d.product.collection} / "${d.product.name}" (${d.skuCount} SKU) → parent: "${d.parent.name}" (${d.parentSkuCount} SKUs)`);
    }
    if (exactDupes.length > 15) console.log(`    ... and ${exactDupes.length - 15} more`);
  }

  if (codeOnlyDupes.length > 0) {
    console.log('\n  Color code overlap (different item codes, same color):');
    for (const d of codeOnlyDupes.slice(0, 15)) {
      const skus = skusByProduct.get(d.product.id) || [];
      const parentSkus = skusByProduct.get(d.parent.id) || [];
      console.log(`    ${d.product.collection} / "${d.product.name}" (${skus.map(s => s.upper).join(', ')}) → parent: "${d.parent.name}" (${d.parentSkuCount} SKUs)`);
    }
    if (codeOnlyDupes.length > 15) console.log(`    ... and ${codeOnlyDupes.length - 15} more`);
  }
  console.log();

  // 5. PTS products
  const ptsProducts = products.filter(p => p.name.startsWith('Pts '));
  if (ptsProducts.length > 0) {
    console.log('=== PTS Professional Tile Solution Products ===');
    console.log(`  Total: ${ptsProducts.length}`);
    for (const p of ptsProducts) {
      const skus = skusByProduct.get(p.id) || [];
      console.log(`    "${p.name}" (${p.collection}) — ${skus.length} SKU(s): ${skus.map(s => s.upper).join(', ')}`);
    }
    console.log();
  }

  // 6. Products with suspicious names (vendor codes still in name)
  const suspiciousNames = products.filter(p => {
    const name = p.display_name || p.name;
    // Still has trailing vendor codes
    return /[A-Z][a-z]*\d{2,}[a-z0-9]*$/.test(name) ||
      /\b(Scl|Scr|S36|P36|P43|S43|A34|Pc36|Qcrl)\d/.test(name);
  });
  console.log(`=== Products with Vendor Codes in Name ===`);
  console.log(`  Total: ${suspiciousNames.length}\n`);

  // 7. Coveo SKUs not in our DB (what are we missing?)
  let coveoNotInDb = 0;
  const missingSeries = new Map();
  for (const [coveoSku, raw] of coveoBysku) {
    if (!allDbSkus.has(coveoSku)) {
      coveoNotInDb++;
      const series = String(raw.seriesname || 'Unknown').trim();
      if (!missingSeries.has(series)) missingSeries.set(series, 0);
      missingSeries.set(series, missingSeries.get(series) + 1);
    }
  }
  console.log('=== Coveo SKUs Missing from DB ===');
  console.log(`  Total: ${coveoNotInDb}`);
  const topMissing = [...missingSeries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [series, cnt] of topMissing) {
    console.log(`    ${series}: ${cnt} SKUs`);
  }
  console.log();

  // ─── Summary ──────────────────────────────────────────────────────────

  console.log('╔═══════════════════════════════════════════════════╗');
  console.log('║              AUDIT SUMMARY                       ║');
  console.log('╠═══════════════════════════════════════════════════╣');
  console.log(`║  Total products:              ${String(products.length).padStart(5)}              ║`);
  console.log(`║  Validated (SKU in Coveo):     ${String(productsCoveoMatch.length).padStart(5)}              ║`);
  console.log(`║  Series match only:            ${String(productsSeriesMatch.length).padStart(5)}              ║`);
  console.log(`║  Ghost candidates:             ${String(productsNoMatch.length).padStart(5)}              ║`);
  console.log(`║                                                   ║`);
  console.log(`║  LVF per-color accessories:    ${String(lvfProducts.length).padStart(5)}              ║`);
  console.log(`║  Color orphans (duplicates):   ${String(colorOrphans.length).padStart(5)}              ║`);
  console.log(`║    - Exact SKU overlap:        ${String(exactDupes.length).padStart(5)}              ║`);
  console.log(`║  PTS program products:         ${String(ptsProducts.length).padStart(5)}              ║`);
  console.log(`║  Vendor codes in name:         ${String(suspiciousNames.length).padStart(5)}              ║`);
  console.log(`║                                                   ║`);
  console.log(`║  Coveo SKUs not in our DB:     ${String(coveoNotInDb).padStart(5)}              ║`);
  console.log('╚═══════════════════════════════════════════════════╝');
  console.log();

  // ─── Fix Mode ─────────────────────────────────────────────────────────

  if (FIX_MODE) {
    console.log('--- Applying fixes ---\n');

    // Fix 1: Deactivate ghost products (collection not in Coveo at all)
    console.log(`Deactivating ${productsNoMatch.length} ghost products...`);
    let deactivated = 0;
    for (const p of productsNoMatch) {
      await pool.query("UPDATE products SET status = 'inactive' WHERE id = $1", [p.id]);
      await pool.query("UPDATE skus SET status = 'inactive' WHERE product_id = $1", [p.id]);
      deactivated++;
    }
    console.log(`  Deactivated ${deactivated} products\n`);

    // Fix 2: Merge LVF per-color products into collection-level accessory products
    // Strategy: group all LVF SKUs by collection + accessory type, then either
    // merge into existing non-LVF product or consolidate into one renamed product.
    console.log(`Consolidating ${lvfProducts.length} LVF per-color products...`);
    let skusMoved = 0, lvfDeactivated = 0, lvfRenamed = 0;

    function classifySkuType(vendorSku) {
      const u = vendorSku.toUpperCase();
      if (/RNDSTRD/i.test(u)) return 'Round Stair Tread';
      if (/SLIMT/i.test(u)) return '4-In-1 Transition';
      if (/VSLCAP/i.test(u)) return 'End Cap';
      if (/VQRND/i.test(u)) return 'Quarter Round';
      if (/VRDSN|VSNP/i.test(u)) return 'Stair Nose';
      if (/EXTSN/i.test(u)) return 'Stair Nose Extension';
      if (/VSCAP/i.test(u)) return 'Stair Cap';
      if (/4IN1/i.test(u)) return '4-In-1 Transition';
      return 'Accessory';
    }

    for (const [coll, lvfProds] of lvfByCollection) {
      // Group ALL LVF SKUs by accessory type across the collection
      const byType = new Map(); // type → [{ sku, sourceProduct }]
      for (const p of lvfProds) {
        for (const s of (skusByProduct.get(p.id) || [])) {
          const type = classifySkuType(s.upper);
          if (!byType.has(type)) byType.set(type, []);
          byType.get(type).push({ sku: s, sourceProduct: p });
        }
      }

      // For each accessory type, find or create a target product
      const usedAsTarget = new Set(); // product IDs we've repurposed as merge targets

      for (const [type, items] of byType) {
        // Look for an existing non-LVF product of this type in the same collection
        const existingTarget = products.find(p =>
          p.collection === coll && !p.name.startsWith('Lvf ') &&
          p.status === 'active' &&
          norm(p.name).includes(norm(type))
        );

        let targetId;
        if (existingTarget) {
          targetId = existingTarget.id;
          // Check existing SKUs from DB (not stale map) to avoid duplicates
          const dbSkus = await pool.query(
            "SELECT UPPER(vendor_sku) as u FROM skus WHERE product_id = $1",
            [targetId]
          );
          const existingSet = new Set(dbSkus.rows.map(r => r.u));

          for (const item of items) {
            if (!existingSet.has(item.sku.upper)) {
              await pool.query("UPDATE skus SET product_id = $1 WHERE id = $2",
                [targetId, item.sku.sku_id]);
              skusMoved++;
            } else {
              // Duplicate SKU — deactivate it
              await pool.query("UPDATE skus SET status = 'inactive' WHERE id = $1",
                [item.sku.sku_id]);
            }
          }
        } else {
          // No existing product — repurpose the first LVF product, rename it
          const keepProduct = items[0].sourceProduct;
          targetId = keepProduct.id;
          const newName = `${coll} ${type}`;

          if (!usedAsTarget.has(targetId)) {
            await pool.query(
              "UPDATE products SET name = $1, display_name = $1 WHERE id = $2",
              [newName, targetId]
            );
            usedAsTarget.add(targetId);
            lvfRenamed++;
          }

          // Move remaining SKUs of this type into the kept product
          const dbSkus = await pool.query(
            "SELECT UPPER(vendor_sku) as u FROM skus WHERE product_id = $1",
            [targetId]
          );
          const existingSet = new Set(dbSkus.rows.map(r => r.u));

          for (let i = 1; i < items.length; i++) {
            if (items[i].sourceProduct.id === targetId) continue; // Already there
            if (!existingSet.has(items[i].sku.upper)) {
              await pool.query("UPDATE skus SET product_id = $1 WHERE id = $2",
                [targetId, items[i].sku.sku_id]);
              existingSet.add(items[i].sku.upper);
              skusMoved++;
            } else {
              await pool.query("UPDATE skus SET status = 'inactive' WHERE id = $1",
                [items[i].sku.sku_id]);
            }
          }
        }
      }

      // Deactivate LVF products that lost all their SKUs (or were not repurposed)
      for (const p of lvfProds) {
        if (usedAsTarget.has(p.id)) continue; // This one was renamed, keep it
        const remaining = await pool.query(
          "SELECT COUNT(*) as cnt FROM skus WHERE product_id = $1 AND status = 'active'",
          [p.id]
        );
        if (parseInt(remaining.rows[0].cnt) === 0) {
          await pool.query("UPDATE products SET status = 'inactive' WHERE id = $1", [p.id]);
          lvfDeactivated++;
        }
      }
    }

    console.log(`  SKUs moved to merged products: ${skusMoved}`);
    console.log(`  LVF products renamed as merge targets: ${lvfRenamed}`);
    console.log(`  LVF products deactivated (empty): ${lvfDeactivated}\n`);

    // Refresh search vectors
    console.log('Refreshing search vectors...');
    await pool.query("SELECT refresh_search_vectors()");

    // Final report
    const finalCount = await pool.query(
      "SELECT COUNT(*) as cnt FROM products WHERE vendor_id = $1 AND status = 'active'",
      [vendorId]
    );
    const finalSkuCount = await pool.query(
      "SELECT COUNT(*) as cnt FROM skus s JOIN products p ON p.id = s.product_id WHERE p.vendor_id = $1 AND s.status = 'active'",
      [vendorId]
    );
    console.log(`\nFinal: ${finalCount.rows[0].cnt} active products (was ${products.length}), ${finalSkuCount.rows[0].cnt} active SKUs`);
    console.log(`  Removed: ${products.length - parseInt(finalCount.rows[0].cnt)} products\n`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end().finally(() => process.exit(1));
});
