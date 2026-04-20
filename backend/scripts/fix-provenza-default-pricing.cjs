#!/usr/bin/env node
/**
 * Fix default-priced Provenza collections by:
 * 1. Logging into DNav and extracting pricing for unmatched collections
 * 2. Applying collection-level pricing to ALL SKUs (not just color-matched ones)
 * 3. Propagating packaging from DNav to collection siblings
 */
async function main() {
  const { pool } = await import('../db.js');
  const { triwestLogin } = await import('../scrapers/triwest-auth.js');
  const { searchByManufacturer } = await import('../scrapers/triwest-search.js');
  const { upsertPricing, upsertPackaging } = await import('../scrapers/base.js');

  const srcRes = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'triwest-provenza'");
  const source = srcRes.rows[0];
  const vendor_id = source.vendor_id;
  const retailMarkup = (source.config || {}).retail_markup || 2.0;

  // Find collections still at default pricing ($7.49, $4.99, $3.99)
  const defaultPriced = await pool.query(`
    SELECT DISTINCT p.collection
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.variant_type IS NULL
    JOIN pricing pr ON pr.sku_id = s.id
    WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
      AND pr.retail_price IN (7.49, 4.99, 3.99)
      AND NOT EXISTS (
        SELECT 1 FROM skus s2
        JOIN pricing pr2 ON pr2.sku_id = s2.id
        WHERE s2.product_id = p.id AND s2.variant_type IS NULL
          AND pr2.retail_price NOT IN (7.49, 4.99, 3.99)
      )
    ORDER BY p.collection
  `, [vendor_id]);

  const defaultCollections = defaultPriced.rows.map(r => r.collection);
  console.log(`Collections still at default pricing (${defaultCollections.length}):`);
  for (const c of defaultCollections) console.log(`  - ${c}`);

  // Login to DNav
  console.log('\nLogging into DNav...');
  const { browser, page } = await triwestLogin(pool, null);
  console.log('Searching for PRO manufacturer...');
  const dnavRows = await searchByManufacturer(page, 'PRO', pool, null);
  console.log(`DNav returned ${dnavRows.length} rows`);
  await browser.close().catch(() => {});

  // Collection matching - inline COLLECTION_MAP
  const COLLECTION_MAP = {
    'AFFINITY': 'Affinity', 'AFRICAN PLAINS': 'African Plains', 'AFRICAN': 'African Plains',
    'ANTICO': 'Antico', 'CADEAU': 'Cadeau', 'CONCORDE OAK': 'Concorde Oak', 'CONCORDE': 'Concorde Oak',
    'DUTCH MASTERS': 'Dutch Masters', 'EUROPEAN OAK 4MM': 'Dutch Masters',
    'FIRST IMPRESSIONS': 'First Impressions', 'FIRST IMP': 'First Impressions',
    'GRAND POMPEII': 'Grand Pompeii', 'GRAND POM': 'Grand Pompeii',
    'HERRINGBONE RESERVE': 'Herringbone Reserve', 'HERRINGBONE CUSTOM': 'Herringbone Custom',
    'LIGHTHOUSE COVE': 'Lighthouse Cove', 'LIGHTHOUS': 'Lighthouse Cove',
    'LUGANO': 'Lugano', 'MATEUS': 'Mateus',
    'MODA LIVING ELITE': 'Moda Living Elite', 'MODA LIVING': 'Moda Living',
    'MODERN RUSTIC': 'Modern Rustic', 'MODESSA': 'Modessa',
    'NEW WAVE': 'New Wave', 'NEW YORK LOFT': 'New York Loft', 'NYC LOFT': 'New York Loft',
    'OLD WORLD': 'Old World', 'OPIA': 'Opia',
    'PALAIS ROYALE': 'Palais Royale', 'PALAIS RO': 'Palais Royale',
    'POMPEII': 'Pompeii', 'RICHMOND': 'Richmond',
    'STONESCAPE': 'Stonescape', 'STONESCAT': 'Stonescape',
    'STUDIO MODERNO': 'Studio Moderno', 'STUDIO MO': 'Studio Moderno',
    'TRESOR': 'Tresor', 'UPTOWN CHIC': 'Uptown Chic', 'UPTOWN CH': 'Uptown Chic',
    'VITALI ELITE': 'Vitali Elite', 'VITALI EL': 'Vitali Elite',
    'VITALI': 'Vitali', 'VOLTERRA': 'Volterra', 'WALL CHIC': 'Wall Chic',
  };

  function matchColl(text) {
    if (!text) return null;
    let norm = text.toUpperCase()
      .replace(/\b(WPF-LVP|WPF|SPC-LVP|SPC|MAXCORE|LVP|LAMINATE)\b/g, '')
      .replace(/\s+COLLECTION$/i, '').replace(/\s+COLL\.?$/i, '')
      .replace(/\b\d+MIL\b/g, '').replace(/\d+"?\s*$/g, '')
      .replace(/\s+/g, ' ').trim();
    if (COLLECTION_MAP[norm]) return COLLECTION_MAP[norm];
    const sorted = Object.keys(COLLECTION_MAP).sort((a, b) => b.length - a.length);
    for (const k of sorted) { if (norm.startsWith(k)) return COLLECTION_MAP[k]; }
    for (const k of sorted) { if (k.length >= 5 && norm.includes(k)) return COLLECTION_MAP[k]; }
    return null;
  }

  function dnavToCollection(pattern, row) {
    let result = matchColl(pattern);
    if (result) return result;
    if (row && row.rawDescription) {
      const lines = row.rawDescription.split(/\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        const line2 = lines[1].replace(/\*[\d.]+/g, '').replace(/\d+\/?CT/gi, '')
          .replace(/XXX/g, '').replace(/COLL\b[\s."]*/gi, '').replace(/COLLECTION/gi, '').trim();
        result = matchColl(line2);
        if (result) return result;
      }
    }
    return null;
  }

  // Skip accessories
  const ACCESSORY_RE = /\b(stair\s*nose|reducer|t[- ]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[- ]?purpose|transition|scotia|shoe\s*mold|cleaner|touch[- ]?up|repair\s*kit|stain|oil\s*refresh|maintenance|custom\s*mold|fabricated|color\s*set|profile|kit)\b/i;

  // Collect pricing per default-priced collection from DNav
  // Key insight: we don't need color matching — just collection-level pricing
  const collectionPricing = new Map(); // collection → { cost, retail, sqftPerBox }

  const defaultCollShort = new Set(defaultCollections.map(c => c.replace('Provenza - ', '')));

  for (const row of dnavRows) {
    // Skip obvious accessories
    const combined = `${row.pattern || ''} ${row.productName || ''} ${row.rawDescription || ''}`;
    if (ACCESSORY_RE.test(combined)) continue;

    const coll = dnavToCollection(row.pattern, row);
    if (!coll) continue;
    if (!defaultCollShort.has(coll)) continue; // only care about default-priced collections

    // Skip if no pricing
    if (!row.sqftPrice || row.sqftPrice <= 0) continue;

    const fullColl = `Provenza - ${coll}`;
    if (!collectionPricing.has(fullColl)) {
      collectionPricing.set(fullColl, {
        cost: row.sqftPrice,
        retail: parseFloat((row.sqftPrice * retailMarkup).toFixed(2)),
        sqftPerBox: row.sqftPerBox || null,
        source: `${row.itemNumber} ${row.color}`,
      });
      console.log(`\n  Found DNav pricing for ${coll}: $${row.sqftPrice}/sqft cost → $${(row.sqftPrice * retailMarkup).toFixed(2)} retail (from ${row.itemNumber} ${row.color}, box: ${row.sqftPerBox || '?'} sqft)`);
    }
  }

  console.log(`\nDNav pricing found for ${collectionPricing.size} of ${defaultCollections.length} default collections`);

  // Apply pricing to ALL SKUs in matched collections
  let updated = 0;
  let packaged = 0;

  for (const [collection, pricing] of collectionPricing) {
    const skus = await pool.query(`
      SELECT s.id AS sku_id
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.collection = $1 AND s.variant_type IS NULL
    `, [collection]);

    for (const sku of skus.rows) {
      await upsertPricing(pool, sku.sku_id, {
        cost: pricing.cost,
        retail_price: pricing.retail,
        price_basis: 'per_sqft',
      }, {});
      updated++;

      if (pricing.sqftPerBox) {
        await upsertPackaging(pool, sku.sku_id, { sqft_per_box: pricing.sqftPerBox }, {});
        packaged++;
      }
    }
    console.log(`  ${collection}: updated ${skus.rows.length} SKUs → $${pricing.retail}/sqft, ${pricing.sqftPerBox || 'N/A'} sqft/box`);
  }

  // Report remaining default-priced collections
  const stillDefault = defaultCollections.filter(c => !collectionPricing.has(c));
  if (stillDefault.length > 0) {
    console.log(`\nCollections with NO DNav pricing available (${stillDefault.length}):`);
    for (const c of stillDefault) {
      console.log(`  - ${c} (keeping default price)`);
    }
  }

  // Final summary
  const summary = await pool.query(`
    SELECT p.collection,
      COUNT(s.id) AS skus,
      ROUND(AVG(pr.retail_price)::numeric, 2) AS avg_retail,
      MAX(pkg.sqft_per_box) AS sqft_per_box
    FROM products p
    JOIN skus s ON s.product_id = p.id AND s.variant_type IS NULL
    LEFT JOIN pricing pr ON pr.sku_id = s.id
    LEFT JOIN packaging pkg ON pkg.sku_id = s.id
    WHERE p.collection = ANY($1::text[])
    GROUP BY p.collection ORDER BY p.collection
  `, [defaultCollections]);

  console.log('\n=== Updated Collections ===');
  console.log('Collection                      | SKUs | Retail   | SqFt/Box');
  console.log('--------------------------------|------|----------|--------');
  for (const r of summary.rows) {
    const coll = r.collection.padEnd(32);
    const skus = String(r.skus).padStart(4);
    const retail = r.avg_retail ? ('$' + r.avg_retail).padStart(8) : '  N/A   ';
    const pkg = r.sqft_per_box ? String(r.sqft_per_box).padStart(6) : '   N/A';
    console.log(`${coll}|${skus} |${retail} |${pkg}`);
  }

  console.log(`\nDone: ${updated} SKUs re-priced, ${packaged} packaging records added`);

  await pool.end();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
