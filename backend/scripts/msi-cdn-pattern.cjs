#!/usr/bin/env node
/**
 * MSI CDN Pattern Matcher — Uses CDN URL patterns from correctly-imaged siblings
 * to construct and verify URLs for missing products.
 *
 * Strategy: For each series, analyze the CDN URL pattern of products that have
 * CORRECT images (verified by URL containing the series name), then apply that
 * same pattern with the missing product's color to construct candidate URLs.
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: 'localhost', database: 'flooring_pim', user: 'postgres', password: 'postgres'
});

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function headUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 8000 }, res => {
      resolve(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Extract color from product name (everything after the series, cleaned up)
function extractColor(displayName, series) {
  return displayName
    .replace(new RegExp('^' + series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
    .replace(/\s+\d{4}\s*/g, ' ')
    .replace(/\s+(Matte|Polished|Glossy|Honed|Lappato|Satin|R11|R10|R9)\s*.*$/i, '')
    .replace(/\s+(Bullnose|Bn|Mosaic|3d|Crown Molding)\s*.*$/i, '')
    .replace(/x\d+mm\s*$/i, '')
    .replace(/x\.\d+.*$/i, '')
    .replace(/Realex.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function saveImage(productId, url) {
  try {
    await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1, NULL, 'primary', $2, $2, 0)
      ON CONFLICT (product_id, asset_type, sort_order) WHERE sku_id IS NULL
      DO UPDATE SET url = EXCLUDED.url, original_url = EXCLUDED.original_url
    `, [productId, url]);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const { rows: [v] } = await pool.query("SELECT id FROM vendors WHERE code = 'MSI'");
  const vid = v.id;

  // Get all missing products
  const { rows: missing } = await pool.query(`
    SELECT p.id, p.display_name, c.name as category
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
      AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
    ORDER BY p.display_name
  `, [vid]);
  console.log(`Missing: ${missing.length} products\n`);

  // Known multi-word series prefixes (order matters: longest first)
  const MULTI_WORD_SERIES = [
    'Chateau Luna', 'Kaya Onda', 'Kaya Zermatta', 'Kaya Calacatta',
    'Traktion Stowe', 'Traktion Maven', 'Traktion Calypso',
    'Carolina Timber', 'Hd Blume', 'Hd Toucan', 'Hd Aura',
    'Gold Green', 'Hawaiian Sky', 'New Diana Reale',
    'Regallo Marquinanoir', 'Regallo Midnight Agate', 'Regallo Calacatta Isla',
    'Regallo Calacatta Marbella', 'Regallo Marquina Noir',
    'Snowdrift White', 'Thundercloud Grey', 'Travertino White',
    'Seashell Bianco', 'Dune Silk', 'Village Tildes',
    'Bellataj Amber', 'Bellataj Crystal', 'Bellataj Dune',
    'Murcia Alabaster', 'Murcia Clay', 'Murcia Dune',
    'Terranello Dune', 'Terranello Pearl', 'Terranello Cotto',
    'Terranello Ivory', 'Terranello Olive',
    'Valgrande Quercia', 'Valgrande Sequoia', 'Valgrande Clayborne',
    'Mattonella Giada', 'Mattonella Neve', 'Mattonella Carbone', 'Mattonella Cotto',
  ];

  function getSeries(name) {
    const nameLower = name.toLowerCase();
    for (const ms of MULTI_WORD_SERIES) {
      if (nameLower.startsWith(ms.toLowerCase())) return ms;
    }
    return name.split(/\s+/)[0];
  }

  // === Phase 1: Pattern-based CDN probe ===
  // For known series with correct CDN patterns, construct URLs
  console.log('=== Phase 1: Known CDN patterns ===');

  // Manually defined patterns based on analysis of correct sibling images
  const CDN = 'https://cdn.msisurfaces.com/images';

  const KNOWN_PATTERNS = {
    // Flamenco: colornames/{color}-2x18-glossy-flamenco.jpg
    'flamenco': (color) => [
      `${CDN}/colornames/${slugify(color)}-2x18-glossy-flamenco.jpg`,
      `${CDN}/colornames/${slugify(color)}-glossy-flamenco.jpg`,
      `${CDN}/colornames/${slugify(color)}-flamenco.jpg`,
    ],
    // Regallo: porcelainceramic/iso/{color}-iso.jpg
    'regallo': (color) => [
      `${CDN}/porcelainceramic/iso/${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-porcelain-iso.jpg`,
      `${CDN}/porcelainceramic/detail/${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/${slugify(color)}.jpg`,
    ],
    // Traktion: porcelainceramic/iso/{subseries}-{color}-12x24-iso.jpg
    'traktion': (color) => [
      `${CDN}/porcelainceramic/iso/${slugify(color)}-12x24-iso.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-porcelain-iso.jpg`,
      `${CDN}/porcelainceramic/detail/${slugify(color)}.jpg`,
    ],
    // Kaya: porcelainceramic/iso or hardscaping/detail
    'kaya': (color) => [
      `${CDN}/porcelainceramic/iso/${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-porcelain-iso.jpg`,
      `${CDN}/porcelainceramic/detail/${slugify(color)}.jpg`,
      `${CDN}/hardscaping/detail/${slugify(color)}-arterra-pavers-porcelain.jpg`,
      `${CDN}/porcelainceramic/iso/kaya-${slugify(color)}-iso.jpg`,
    ],
    // Watercolor: porcelainceramic/{color}-watercolor-porcelain.jpg
    'watercolor': (color) => [
      `${CDN}/porcelainceramic/${slugify(color)}-watercolor-porcelain.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-watercolor-iso.jpg`,
    ],
    // Bellataj: New series, try multiple patterns
    'bellataj': (color) => [
      `${CDN}/porcelainceramic/iso/bellataj-${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/detail/bellataj-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/bellataj-${slugify(color)}-porcelain.jpg`,
      `${CDN}/porcelainceramic/bellataj-${slugify(color)}.jpg`,
      `${CDN}/colornames/bellataj-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-bellataj-iso.jpg`,
    ],
    // Murcia: Try both murcia-color and just color
    'murcia': (color) => [
      `${CDN}/porcelainceramic/iso/murcia-${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/detail/murcia-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/murcia-${slugify(color)}-porcelain.jpg`,
      `${CDN}/porcelainceramic/murcia-${slugify(color)}.jpg`,
    ],
    // Terranello: Try terranello-color patterns
    'terranello': (color) => [
      `${CDN}/porcelainceramic/iso/terranello-${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/detail/terranello-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/terranello-${slugify(color)}-porcelain.jpg`,
      `${CDN}/porcelainceramic/terranello-${slugify(color)}.jpg`,
      `${CDN}/colornames/terranello-${slugify(color)}.jpg`,
    ],
    // Valgrande: porcelainceramic patterns
    'valgrande': (color) => [
      `${CDN}/porcelainceramic/iso/valgrande-${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/detail/valgrande-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/valgrande-${slugify(color)}-porcelain.jpg`,
      `${CDN}/porcelainceramic/valgrande-${slugify(color)}.jpg`,
    ],
    // Mattonella
    'mattonella': (color) => [
      `${CDN}/porcelainceramic/iso/mattonella-${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/detail/mattonella-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/mattonella-${slugify(color)}-porcelain.jpg`,
      `${CDN}/porcelainceramic/${slugify(color)}-mattonella-porcelain.jpg`,
      `${CDN}/colornames/${slugify(color)}-mattonella.jpg`,
    ],
    // Chateau Luna
    'chateau luna': (color) => [
      `${CDN}/porcelainceramic/iso/chateau-luna-${slugify(color)}-iso.jpg`,
      `${CDN}/porcelainceramic/iso/${slugify(color)}-chateau-luna-iso.jpg`,
      `${CDN}/porcelainceramic/detail/chateau-luna-${slugify(color)}.jpg`,
      `${CDN}/porcelainceramic/chateau-luna-${slugify(color)}-porcelain.jpg`,
    ],
    // Generic: Try series-color in all common patterns
    '_default': (series, color) => {
      const ss = slugify(series);
      const cs = slugify(color);
      const urls = [];
      const sections = ['porcelainceramic', 'colornames', 'naturalstone', 'mosaics', 'hardscaping', 'lvt'];
      const types = ['iso', 'detail', 'colornames', 'front'];
      for (const section of sections) {
        for (const type of types) {
          urls.push(`${CDN}/${section}/${type}/${ss}-${cs}-iso.jpg`);
          urls.push(`${CDN}/${section}/${type}/${ss}-${cs}.jpg`);
          urls.push(`${CDN}/${section}/${type}/${cs}-${ss}.jpg`);
        }
        urls.push(`${CDN}/${section}/${ss}-${cs}-porcelain.jpg`);
        urls.push(`${CDN}/${section}/${cs}-${ss}-porcelain.jpg`);
        urls.push(`${CDN}/${section}/${ss}-${cs}.jpg`);
      }
      return urls;
    },
  };

  let matched = 0;
  let probed = 0;
  const needsImage = new Set(missing.map(m => m.id));

  for (const m of missing) {
    if (!needsImage.has(m.id)) continue;

    const series = getSeries(m.display_name);
    const seriesKey = series.toLowerCase();
    const color = extractColor(m.display_name, series);

    if (!color || color.length < 2) continue;

    // Generate CDN URLs using known patterns
    let urls;
    if (KNOWN_PATTERNS[seriesKey]) {
      urls = KNOWN_PATTERNS[seriesKey](color);
    } else {
      urls = KNOWN_PATTERNS._default(series, color);
    }

    let found = false;
    for (const url of urls) {
      probed++;
      const result = await headUrl(url);
      if (result) {
        const saved = await saveImage(m.id, result);
        if (saved) {
          matched++;
          needsImage.delete(m.id);
          console.log(`  ✓ ${m.display_name} → ${result}`);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      // For specific known products, try hardcoded CDN paths
      const fullSlug = slugify(m.display_name
        .replace(/\s+\d{4}/g, '')
        .replace(/\s+(R11|R10|R9)\s*$/i, '')
        .replace(/\s+(Bullnose|Mosaic|3d|Crown Molding)\s*$/i, '')
        .replace(/x\d+mm$/i, '')
        .replace(/x\.\d+.*$/i, ''));

      const lastChance = [
        `${CDN}/porcelainceramic/iso/${fullSlug}-iso.jpg`,
        `${CDN}/porcelainceramic/detail/${fullSlug}.jpg`,
        `${CDN}/porcelainceramic/${fullSlug}-porcelain.jpg`,
        `${CDN}/colornames/${fullSlug}.jpg`,
        `${CDN}/porcelainceramic/${fullSlug}.jpg`,
        `${CDN}/naturalstone/detail/${fullSlug}.jpg`,
        `${CDN}/naturalstone/${fullSlug}.jpg`,
        `${CDN}/mosaics/detail/${fullSlug}.jpg`,
        `${CDN}/mosaics/${fullSlug}.jpg`,
      ];

      for (const url of lastChance) {
        probed++;
        const result = await headUrl(url);
        if (result) {
          const saved = await saveImage(m.id, result);
          if (saved) {
            matched++;
            needsImage.delete(m.id);
            console.log(`  ✓ ${m.display_name} → ${result} (last chance)`);
            found = true;
            break;
          }
        }
      }
    }
  }

  console.log(`\nPhase 1: ${matched} matched from ${probed} probes\n`);

  // === Phase 2: Delete wrong word-matcher images and replace ===
  // Find products that have images from wrong products (URL doesn't match product name)
  // and replace them with correct series-based images
  console.log('=== Phase 2: Fix wrong word-matcher images ===');

  const { rows: wrongImages } = await pool.query(`
    SELECT p.id, p.display_name, ma.url, ma.id as media_id,
      lower(split_part(p.display_name, ' ', 1)) as series_word
    FROM products p
    JOIN vendors v ON p.vendor_id = v.id
    JOIN media_assets ma ON ma.product_id = p.id AND ma.sort_order = 0
    WHERE v.code = 'MSI' AND p.status = 'active' AND p.is_active = true
      AND length(split_part(p.display_name, ' ', 1)) >= 5
      AND ma.url LIKE 'https://cdn.msisurfaces.com%'
      AND lower(ma.url) NOT LIKE '%' || lower(split_part(p.display_name, ' ', 1)) || '%'
      AND ma.url NOT LIKE '%/svg/%'
    ORDER BY p.display_name
  `);

  console.log(`Found ${wrongImages.length} products with potentially wrong images`);

  let fixed = 0;
  for (const wi of wrongImages) {
    const series = getSeries(wi.display_name);
    const seriesKey = series.toLowerCase();
    const color = extractColor(wi.display_name, series);

    if (!color || color.length < 2) continue;

    let urls;
    if (KNOWN_PATTERNS[seriesKey]) {
      urls = KNOWN_PATTERNS[seriesKey](color);
    } else {
      urls = KNOWN_PATTERNS._default(series, color);
    }

    for (const url of urls) {
      probed++;
      const result = await headUrl(url);
      if (result) {
        // Update the existing image with the correct URL
        try {
          await pool.query(
            'UPDATE media_assets SET url = $1, original_url = $1 WHERE id = $2',
            [result, wi.media_id]
          );
          fixed++;
          console.log(`  Fixed: ${wi.display_name} → ${result} (was: ${wi.url.split('/').pop()})`);
        } catch {}
        break;
      }
    }
  }

  console.log(`\nPhase 2: ${fixed} images fixed from ${wrongImages.length} wrong\n`);

  // === Final Stats ===
  const { rows: [stats] } = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as with_images
    FROM products p WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
  `, [vid]);
  console.log(`Coverage: ${stats.with_images}/${stats.total} (${(100 * stats.with_images / stats.total).toFixed(1)}%)`);

  // List remaining
  if (needsImage.size > 0 && needsImage.size <= 100) {
    console.log(`\nStill missing (${needsImage.size}):`);
    const { rows: stillMissing } = await pool.query(`
      SELECT p.display_name, c.name as category
      FROM products p LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.vendor_id = $1 AND p.status = 'active' AND p.is_active = true
        AND NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)
      ORDER BY c.name, p.display_name
    `, [vid]);
    for (const m of stillMissing) {
      console.log(`  [${m.category}] ${m.display_name}`);
    }
  }

  await pool.end();
})();
