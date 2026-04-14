#!/usr/bin/env node
/**
 * Debug why Marble Attache products aren't matching Coveo per-color images
 */

const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres',
});

const COVEO_DOMAIN = 'www.daltile.com';
const COVEO_FIELDS = ['sku', 'seriesname', 'colornameenglish', 'productimageurl', 'primaryroomsceneurl', 'bodytype', 'producttype'];
const KNOWN_MATERIAL_SUFFIX_RE = /\s+Glass\s*$/i;

function norm(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function stripKnownMaterialSuffix(c) { return c ? (c.replace(KNOWN_MATERIAL_SUFFIX_RE, '').trim() || c) : c; }

function stripMaterialSuffix(color, material) {
  if (!color || !material) return color;
  const matLower = material.trim().toLowerCase();
  const colorLower = color.trim().toLowerCase();
  if (colorLower.endsWith(' ' + matLower)) {
    const stripped = color.trim().slice(0, -(matLower.length + 1)).trim();
    return stripped || color;
  }
  const matWords = matLower.split(/\s+/);
  if (matWords.length > 1) {
    const lastWord = matWords[matWords.length - 1];
    if (colorLower.endsWith(' ' + lastWord)) {
      const stripped = color.trim().slice(0, -(lastWord.length + 1)).trim();
      return stripped || color;
    }
  }
  return color;
}

function getField(result, fieldName) {
  const raw = result.raw || {};
  const val = raw[fieldName] ?? raw[fieldName.toLowerCase()] ?? null;
  if (val == null) return '';
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean).join(', ');
  return String(val).trim();
}

function isPlaceholderUrl(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes('placeholder') || lower.includes('no-series-image') ||
    lower.includes('no.series') || lower.includes('coming-soon');
}

function stripPreset(url) {
  if (!url) return url;
  return url.replace(/\?\$[A-Z_]+\$/, '');
}

async function queryCoveo(extraFilter, firstResult, numberOfResults) {
  const aq = `@sitetargethostname=="${COVEO_DOMAIN}" @sourcedisplayname==product${extraFilter}`;
  const resp = await fetch(`https://${COVEO_DOMAIN}/coveo/rest/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ q: '', aq, firstResult, numberOfResults, fieldsToInclude: COVEO_FIELDS }),
  });
  if (!resp.ok) throw new Error(`Coveo ${resp.status}`);
  return resp.json();
}

async function main() {
  console.log('\n=== MARBLE ATTACHE DEBUG ===\n');

  // Step 1: Find Marble Attache entries in Coveo
  console.log('--- Step 1: Coveo Marble Attache entries ---\n');
  const resp = await queryCoveo(' @seriesname=="Marble Attache"', 0, 200);
  const results = resp.results || [];
  console.log(`  Coveo returned ${results.length} entries for seriesname="Marble Attache"\n`);

  // Dump product types + colors for each
  console.log('  Breakdown by producttype:');
  const byType = {};
  for (const r of results) {
    const t = getField(r, 'producttype') || '(none)';
    byType[t] = (byType[t] || 0) + 1;
  }
  for (const [t, c] of Object.entries(byType)) console.log(`    ${t}: ${c}`);
  console.log('');

  console.log('  All raw (producttype, colornameenglish, has-image):');
  for (const r of results) {
    const t = getField(r, 'producttype');
    const c = getField(r, 'colornameenglish');
    const i = stripPreset(getField(r, 'productimageurl'));
    const has = i && !isPlaceholderUrl(i) ? 'Y' : 'N';
    console.log(`    [${has}] ${t} | "${c}" | ${i.slice(0, 80)}`);
  }
  console.log('');

  const coveoColors = new Map();
  for (const r of results) {
    const series = getField(r, 'seriesname');
    const rawColor = getField(r, 'colornameenglish');
    const material = getField(r, 'bodytype');
    const color = stripKnownMaterialSuffix(stripMaterialSuffix(rawColor, material));
    const prodImg = stripPreset(getField(r, 'productimageurl'));
    const prodType = getField(r, 'producttype');

    const validProd = prodImg && !isPlaceholderUrl(prodImg) ? prodImg : '';
    if (!validProd) continue;

    const key = `${norm(series)}|${norm(color)}`;
    if (!coveoColors.has(key)) {
      coveoColors.set(key, { series, rawColor, color, material, prodType, img: prodImg });
    }
  }
  console.log(`  Unique (series|color) keys with images: ${coveoColors.size}`);
  console.log(`  First 15 keys:`);
  let i = 0;
  for (const [k, v] of coveoColors) {
    if (i++ >= 15) break;
    console.log(`    ${k}`);
    console.log(`      raw="${v.rawColor}" material="${v.material}" type="${v.prodType}"`);
  }

  // Step 2: Get DB Marble Attache products
  console.log('\n--- Step 2: DB Marble Attache products ---\n');
  const dbRes = await pool.query(`
    SELECT p.id, p.name, p.collection,
           (SELECT sa.value FROM skus s JOIN sku_attributes sa ON sa.sku_id=s.id
              WHERE s.product_id=p.id AND s.status='active'
              AND sa.attribute_id=(SELECT id FROM attributes WHERE slug='color')
              LIMIT 1) as color
    FROM products p
    WHERE p.vendor_id=(SELECT id FROM vendors WHERE code='DAL') AND p.status='active'
      AND p.collection ILIKE 'Marble Attache%'
    ORDER BY p.name
  `);
  console.log(`  DB has ${dbRes.rows.length} Marble Attache products\n`);
  for (const p of dbRes.rows.slice(0, 10)) {
    const key = `${norm(p.collection)}|${norm(p.color)}`;
    const hit = coveoColors.get(key) ? 'HIT' : 'MISS';
    console.log(`  [${hit}] collection="${p.collection}" color="${p.color}" -> key="${key}"`);
  }

  // Step 3: Try different lookups
  console.log('\n--- Step 3: Testing different key strategies ---\n');
  const sample = dbRes.rows[0];
  if (sample) {
    console.log(`  Sample: "${sample.collection}" / "${sample.color}"`);
    const normCollection = norm(sample.collection);
    const normColor = norm(sample.color);
    console.log(`    normCollection="${normCollection}"`);
    console.log(`    normColor="${normColor}"`);
    console.log(`    key="${normCollection}|${normColor}"`);

    // List all coveo keys that contain this color
    console.log(`\n  Coveo keys containing "${normColor}":`);
    for (const [k] of coveoColors) {
      if (k.includes(normColor)) console.log(`    ${k}`);
    }

    // List all coveo keys that start with marble attache
    console.log(`\n  Coveo keys starting with "marble attache":`);
    let count = 0;
    for (const [k] of coveoColors) {
      if (k.startsWith('marble attache')) {
        console.log(`    ${k}`);
        if (++count >= 10) break;
      }
    }
  }

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); pool.end(); process.exit(1); });
