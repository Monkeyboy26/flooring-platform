#!/usr/bin/env node
/**
 * Re-run Provenza DNav pricing overlay (Phase 4 + Phase 5).
 *
 * Uses the improved dnavToCollection matching with:
 * - Truncated pattern aliases (AFRICAN → African Plains)
 * - rawDescription line-2 extraction
 * - Color → collection reverse lookup
 *
 * Then propagates pricing + packaging to unpriced siblings.
 */

// This script imports the ESM scraper module, so we need to use dynamic import
async function main() {
  const { pool } = await import('../db.js');

  // Get vendor source
  const srcRes = await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'triwest-provenza'");
  const source = srcRes.rows[0];
  if (!source) { console.error('No vendor source found'); process.exit(1); }

  const vendor_id = source.vendor_id;
  const retailMarkup = (source.config || {}).retail_markup || 2.0;

  console.log('=== Phase 4: DNav Pricing Overlay ===');

  // Import scraper helpers
  const { triwestLogin } = await import('../scrapers/triwest-auth.js');
  const { searchByManufacturer } = await import('../scrapers/triwest-search.js');
  const { upsertPricing, upsertPackaging, upsertSkuAttribute, appendLog, addJobError, fuzzyMatch } = await import('../scrapers/base.js');

  // Import matching functions from the scraper
  const scraperModule = await import('../scrapers/triwest-provenza.js');

  // Create a scrape job for logging
  const jobRes = await pool.query(
    "INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1, 'running', CURRENT_TIMESTAMP) RETURNING *",
    [source.id]
  );
  const job = jobRes.rows[0];
  console.log('Job ID:', job.id);

  try {
    // Login to DNav
    console.log('Logging into DNav...');
    const { browser, page, cookies } = await triwestLogin(pool, job.id);

    // Search for PRO manufacturer
    console.log('Searching for PRO manufacturer...');
    const dnavRows = await searchByManufacturer(page, 'PRO', pool, job.id);
    console.log(`DNav returned ${dnavRows.length} rows`);

    await browser.close().catch(() => {});

    // Build SKU lookup from DB
    const skuResult = await pool.query(`
      SELECT s.id AS sku_id, s.product_id, s.variant_name, p.collection
      FROM skus s
      JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
        AND s.variant_type IS NULL
    `, [vendor_id]);

    // normalizeColor from the scraper
    function normalizeColor(c) {
      return c ? c.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    }
    function titleCase(s) {
      return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    const skuLookup = new Map();
    for (const row of skuResult.rows) {
      const coll = row.collection.replace('Provenza - ', '');
      if (!skuLookup.has(coll)) skuLookup.set(coll, new Map());
      skuLookup.get(coll).set(normalizeColor(row.variant_name), {
        sku_id: row.sku_id,
        product_id: row.product_id,
      });
    }

    // Inline the matching logic from the scraper
    // Import COLLECTION_MAP and helpers - they're not exported so we inline key parts
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

    // Color→Collection reverse map
    const COLOR_TO_COLLECTION = new Map();
    const PROVENZA_COLORS = {
      'Affinity': ['Contour','Delight','Intrigue','Journey','Liberation','Mellow','Silhouette','Acclaim','Celebration','Engage'],
      'African Plains': ['Raffia','Sahara Sun','Black River','Serengeti'],
      'Antico': ['Auburn','Chamboard','Heritage','Caribou','Relic','Clay'],
      'Cadeau': ['Aria','Cadence','Chapelle','Dolce','Ferro','Largo','Noir','Shimmer','Sonata','Verdun'],
      'Concorde Oak': ['Brushed Pearl','Cool Classic','French Revival','London Fog','Loyal Friend','Mystic Moon','Royal Crest','Smoked Amber','Warm Tribute','Willow Wisp'],
      'Dutch Masters': ['Bosch','Cleve','Escher','Gaspar','Hals','Klee','Leyster','Mondrian','Steen','Vermeer'],
      'First Impressions': ['High Style','One N Only','Pop Art','Cool Comfort','Real Deal','Cozy Cottage','Best Choice'],
      'Grand Pompeii': ['Apollo','Stabiane','Regina','Loreto','Nolana'],
      'Herringbone Reserve': ['Autumn Wheat','Stone Grey','Dovetail'],
      'Lighthouse Cove': ['Ivory White','Black Pearl','Frosty Taupe','Ruby Red'],
      'Lugano': ['Bella','Forma','Oro','Chiara','Felice','Genre'],
      'Mateus': ['Adora','Chateau','Enzo','Lido','Luxor','Maxime','Prado','Remy','Savoy','Trevi'],
      'Moda Living': ['At Ease','First Crush','Jet Set','Fly Away','True Story','Soul Mate','Soft Whisper','Finally Mine','Hang Ten','Sweet Talker'],
      'Moda Living Elite': ['Bravo','Diva','Foxy','Inspire','Vogue','Luxe','Jewel','Oasis','Soulful','Gala'],
      'Modern Rustic': ['Moonlit Pearl','Silver Lining','Oyster White'],
      'Modessa': ['Showtime','So Chic','Cover Story','High Life','Game On','Grandstand','Heartbreaker','Starling','Knockout','Morning Light'],
      'New Wave': ['Bashful Beige','Daring Doe','Great Escape','Lunar Glow','Modern Mink','Nest Egg','Night Owl','Playful Pony','Rare Earth','Timber Wolf'],
      'New York Loft': ['Canal Street','Park Place','Pier 55','Penn Station','West End','Carnegie Hall'],
      'Old World': ['Cocoa Powder','Toasted Sesame','Mount Bailey','Gray Rocks','Mink','Pearl Grey','Desert Haze','Fossil Stone','Warm Sand','Tortoise Shell'],
      'Opia': ['Brulee','Coterie','Curio','Destiny','Echo','Fontaine','Galerie','Maestro','Portico','Silo'],
      'Palais Royale': ['Amiens','Orleans','Riviera','Toulouse','Versailles'],
      'Pompeii': ['Vesuvius','Salina'],
      'Richmond': ['Stone Bridge','Flint Hill','Merrimac'],
      'Stonescape': ['Ancient Earth','Angel Trail','Desert View','Formation Grey','Lava Dome','Mountain Mist'],
      'Studio Moderno': ['Fellini','Cavalli'],
      'Tresor': ['Amour','Classique','Diamonte','Jolie','Lyon','Symphonie','Orsay','Rondo'],
      'Uptown Chic': ['Big Easy','Catwalk','Class Act','Double Dare','Jazz Singer','Naturally Yours','Posh Beige','Sassy Grey','Rock N Roll','Bold Ambition'],
      'Vitali': ['Corsica','Genova','Milano','Napoli','Rocca','Arezzo','Fabio','Galo','Lucca'],
      'Vitali Elite': ['Alba','Bronte','Carrara','Cori','Modena','Paterno','Sandrio','Trento'],
      'Volterra': ['Grotto','Pisa','Antica','Valori','Avellino','Lombardy','Mara','Novara','Ravina','Savona'],
      'Wall Chic': ['Bombshell','Devotion','Elegance','Euphoria','Fearless','Finesse','Harmony','Ingenue','Intuition','Sensation'],
    };
    for (const [coll, colors] of Object.entries(PROVENZA_COLORS)) {
      for (const color of colors) {
        if (!COLOR_TO_COLLECTION.has(color.toUpperCase())) COLOR_TO_COLLECTION.set(color.toUpperCase(), coll);
      }
    }

    function _matchColl(text) {
      if (!text) return null;
      let norm = text.toUpperCase()
        .replace(/\b(WPF-LVP|WPF|SPC-LVP|SPC|MAXCORE|LVP|LAMINATE)\b/g, '')
        .replace(/\s+COLLECTION$/i, '').replace(/\s+COLL$/i, '')
        .replace(/\b\d+MIL\b/g, '').replace(/\s+/g, ' ').trim();
      if (COLLECTION_MAP[norm]) return COLLECTION_MAP[norm];
      const sorted = Object.keys(COLLECTION_MAP).sort((a, b) => b.length - a.length);
      for (const k of sorted) { if (norm.startsWith(k)) return COLLECTION_MAP[k]; }
      for (const k of sorted) { if (k.length >= 5 && norm.includes(k)) return COLLECTION_MAP[k]; }
      return null;
    }

    function dnavToCollection(pattern, row) {
      let result = _matchColl(pattern);
      if (result) return result;
      if (row && row.rawDescription) {
        const lines = row.rawDescription.split(/\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
          const line2 = lines[1].replace(/\*[\d.]+/g, '').replace(/\d+\/?CT/gi, '')
            .replace(/XXX/g, '').replace(/COLL\b[\s."]*/gi, '').replace(/COLLECTION/gi, '').trim();
          result = _matchColl(line2);
          if (result) return result;
        }
      }
      if (row && row.color) {
        const coll = COLOR_TO_COLLECTION.get(row.color.toUpperCase());
        if (coll) return coll;
      }
      return null;
    }

    const ACCESSORY_RE = /\b(stair\s*nose|reducer|t[- ]?mold|bullnose|quarter\s*round|threshold|end\s*cap|overlap|flush\s*mount|baby\s*threshold|multi[- ]?purpose|transition|scotia|shoe\s*mold|cleaner|touch[- ]?up|repair\s*kit)/i;
    function isDnavAccessory(row) {
      const pattern = (row.pattern || '').toUpperCase();
      if (ACCESSORY_RE.test(pattern) || ACCESSORY_RE.test(row.rawDescription || '') || ACCESSORY_RE.test(row.productName || '')) return true;
      return false;
    }

    // Classify and match
    let matched = 0;
    let unmatched = 0;
    const unmatchedRows = [];

    for (const row of dnavRows) {
      if (isDnavAccessory(row)) continue; // skip accessories

      const coll = dnavToCollection(row.pattern, row);
      if (!coll) {
        unmatched++;
        unmatchedRows.push({ item: row.itemNumber, color: row.color, pattern: row.pattern, desc: (row.rawDescription || '').slice(0, 80) });
        continue;
      }

      const collMap = skuLookup.get(coll);
      if (!collMap) {
        unmatched++;
        unmatchedRows.push({ item: row.itemNumber, color: row.color, pattern: row.pattern, collection: coll, reason: 'no SKUs' });
        continue;
      }

      const normColor = normalizeColor(titleCase(row.color));
      let match = collMap.get(normColor);

      if (!match) {
        let bestScore = 0;
        for (const [key, entry] of collMap) {
          const score = fuzzyMatch(normColor, key);
          if (score > bestScore && score >= 0.7) {
            bestScore = score;
            match = entry;
          }
        }
      }

      if (!match) {
        unmatched++;
        unmatchedRows.push({ item: row.itemNumber, color: row.color, pattern: row.pattern, collection: coll, reason: 'color not found' });
        continue;
      }

      // Update vendor_sku
      await pool.query(
        "UPDATE skus SET vendor_sku = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND (vendor_sku IS NULL OR vendor_sku = '')",
        [match.sku_id, row.itemNumber]
      );

      // Upsert pricing
      if (row.sqftPrice) {
        await upsertPricing(pool, match.sku_id, {
          cost: row.sqftPrice,
          retail_price: parseFloat((row.sqftPrice * retailMarkup).toFixed(2)),
          price_basis: 'per_sqft',
        }, { jobId: job.id });
      }

      // Upsert packaging
      if (row.sqftPerBox) {
        await upsertPackaging(pool, match.sku_id, {
          sqft_per_box: row.sqftPerBox,
        }, { jobId: job.id });
      }

      // Size attribute
      if (row.size) {
        await upsertSkuAttribute(pool, match.sku_id, 'size', row.size);
      }

      matched++;
      console.log(`  ✓ ${row.itemNumber} ${row.color} → ${coll} (cost: $${row.sqftPrice}/sqft, box: ${row.sqftPerBox || '?'} sqft)`);
    }

    console.log(`\nDNav flooring matched: ${matched}, unmatched: ${unmatched}`);
    if (unmatchedRows.length > 0) {
      console.log('\nUnmatched rows:');
      for (const u of unmatchedRows) {
        console.log(`  ✗ ${u.item} ${u.color} pattern="${u.pattern}" ${u.collection ? 'coll=' + u.collection : ''} ${u.reason || ''}`);
      }
    }

    // === Phase 5: Propagation ===
    console.log('\n=== Phase 5: Price + Packaging Propagation ===');

    const unpricedResult = await pool.query(`
      SELECT s.id AS sku_id, p.collection, p.category_id
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
        AND s.variant_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM pricing pr WHERE pr.sku_id = s.id)
    `, [vendor_id]);

    console.log(`Unpriced flooring SKUs: ${unpricedResult.rows.length}`);

    // Also find SKUs missing packaging
    const unpackagedResult = await pool.query(`
      SELECT s.id AS sku_id, p.collection
      FROM skus s JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
        AND s.variant_type IS NULL
        AND NOT EXISTS (SELECT 1 FROM packaging pkg WHERE pkg.sku_id = s.id)
    `, [vendor_id]);

    console.log(`Unpackaged flooring SKUs: ${unpackagedResult.rows.length}`);

    // Collection price averages
    const collPrices = await pool.query(`
      SELECT p.collection, AVG(pr.retail_price) AS avg_retail, AVG(pr.cost) AS avg_cost
      FROM pricing pr JOIN skus s ON s.id = pr.sku_id JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%' AND s.variant_type IS NULL AND pr.retail_price > 0
      GROUP BY p.collection
    `, [vendor_id]);

    const collPriceMap = new Map();
    for (const r of collPrices.rows) {
      collPriceMap.set(r.collection, {
        avgRetail: parseFloat(parseFloat(r.avg_retail).toFixed(2)),
        avgCost: parseFloat(parseFloat(r.avg_cost).toFixed(2)),
      });
    }

    // Collection packaging
    const collPkg = await pool.query(`
      SELECT p.collection, pkg.sqft_per_box
      FROM packaging pkg JOIN skus s ON s.id = pkg.sku_id JOIN products p ON p.id = s.product_id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%' AND s.variant_type IS NULL AND pkg.sqft_per_box > 0
      GROUP BY p.collection, pkg.sqft_per_box
    `, [vendor_id]);

    const collPackMap = new Map();
    for (const r of collPkg.rows) {
      if (!collPackMap.has(r.collection)) collPackMap.set(r.collection, parseFloat(r.sqft_per_box));
    }

    console.log(`Collections with pricing: ${collPriceMap.size}`);
    console.log(`Collections with packaging: ${collPackMap.size}`);

    const DEFAULT_PRICES = { 'engineered-hardwood': 7.49, 'lvp-plank': 4.99, 'laminate': 3.99 };
    const catResult = await pool.query("SELECT id, slug FROM categories WHERE slug IN ('engineered-hardwood', 'lvp-plank', 'laminate')");
    const catMap = new Map();
    for (const r of catResult.rows) catMap.set(r.id, r.slug);

    let pricesPropagated = 0;
    let packagingPropagated = 0;

    for (const row of unpricedResult.rows) {
      let price = collPriceMap.get(row.collection);
      if (!price) {
        const catSlug = catMap.get(row.category_id) || 'engineered-hardwood';
        const def = DEFAULT_PRICES[catSlug] || DEFAULT_PRICES['engineered-hardwood'];
        price = { avgRetail: def, avgCost: parseFloat((def / retailMarkup).toFixed(2)) };
      }
      await upsertPricing(pool, row.sku_id, { cost: price.avgCost, retail_price: price.avgRetail, price_basis: 'per_sqft' }, { jobId: job.id });
      pricesPropagated++;
    }

    for (const row of unpackagedResult.rows) {
      const packSqft = collPackMap.get(row.collection);
      if (packSqft) {
        await upsertPackaging(pool, row.sku_id, { sqft_per_box: packSqft }, { jobId: job.id });
        packagingPropagated++;
      }
    }

    console.log(`\nPrices propagated: ${pricesPropagated}`);
    console.log(`Packaging propagated: ${packagingPropagated}`);

    // Final summary
    const summary = await pool.query(`
      SELECT p.collection,
        COUNT(s.id) AS skus,
        COUNT(CASE WHEN s.vendor_sku IS NOT NULL AND s.vendor_sku != '' THEN 1 END) AS with_vendor_sku,
        ROUND(AVG(pr.retail_price)::numeric, 2) AS avg_retail,
        MAX(pkg.sqft_per_box) AS sqft_per_box
      FROM products p
      JOIN skus s ON s.product_id = p.id AND s.variant_type IS NULL
      LEFT JOIN pricing pr ON pr.sku_id = s.id
      LEFT JOIN packaging pkg ON pkg.sku_id = s.id
      WHERE p.vendor_id = $1 AND p.collection LIKE 'Provenza%'
      GROUP BY p.collection
      ORDER BY p.collection
    `, [vendor_id]);

    console.log('\n=== Final Collection Summary ===');
    console.log('Collection                      | SKUs | DNav | Retail   | SqFt/Box');
    console.log('--------------------------------|------|------|----------|--------');
    for (const r of summary.rows) {
      const coll = r.collection.padEnd(32);
      const skus = String(r.skus).padStart(4);
      const dnav = String(r.with_vendor_sku).padStart(4);
      const retail = r.avg_retail ? ('$' + r.avg_retail).padStart(8) : '  N/A   ';
      const pkg = r.sqft_per_box ? String(r.sqft_per_box).padStart(6) : '   N/A';
      console.log(`${coll}|${skus} |${dnav} |${retail} |${pkg}`);
    }

    await pool.query("UPDATE scrape_jobs SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = $1", [job.id]);
    console.log('\nDone!');
  } catch (err) {
    await pool.query("UPDATE scrape_jobs SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $1", [job.id]);
    console.error('Error:', err.message);
    console.error(err.stack);
  }

  await pool.end();
  process.exit(0);
}

main();
