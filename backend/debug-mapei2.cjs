const { Pool } = require('pg');

function extractBaseName(name) {
  let n = name.replace(/^Map\s+/i, '').trim();
  n = n.replace(/\s+\d+"?\s*x\s*\d+"?.*$/i, '');
  n = n.replace(/\s+\d+(\.\d+)?\s*(Lb|Gal|Oz|Pc|Roll|Sqft|Qt|Gm|Ft|Lf|Sf|Each).*$/i, '');
  n = n.replace(/\s+\d+sf\s+.*$/i, '');
  return n.trim();
}

function normalizeForMatch(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeImageUrl(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (!lower.includes('mapei.com') && !lower.includes('cdnmedia.mapei.com')) return null;
  if (lower.includes('logo') || lower.includes('icon') || lower.includes('bioblock')) return null;
  if (!lower.includes('products-images') && !lower.includes('product')) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  if (url.startsWith('http://')) url = url.replace('http://', 'https://');
  url = url.replace('https://www.mapei.com/images/', 'https://cdnmedia.mapei.com/images/');
  url = url.split('?')[0];
  return url;
}

async function main() {
  const pool = new Pool({ host: 'db', port: 5432, database: 'flooring_pim', user: 'postgres', password: 'postgres' });

  // Get DB product line names
  const products = await pool.query(`
    SELECT DISTINCT p.name
    FROM products p JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN media_assets ma ON ma.product_id = p.id
    WHERE v.code = 'DAL' AND p.collection = 'Mapei Corporation' AND ma.id IS NULL
    ORDER BY p.name
  `);

  const dbLines = new Map();
  for (const r of products.rows) {
    const base = extractBaseName(r.name);
    const key = normalizeForMatch(base);
    if (!dbLines.has(key)) dbLines.set(key, base);
  }

  console.log('=== DB Product Lines (' + dbLines.size + ') ===');
  for (const [k, v] of dbLines) console.log('  ' + JSON.stringify(k));

  // Crawl one category to show imageMap keys
  const resp = await fetch('https://mapeihome.com/flooranddecor/product-category/grouts/', {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  const html = await resp.text();

  console.log('\n=== ImageMap keys from grouts page ===');
  const cardRegex = /<a[^>]+href="([^"]*\/product\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = cardRegex.exec(html)) !== null) {
    const slugMatch = m[1].match(/\/product\/([^/]+)\/?$/);
    if (!slugMatch) continue;
    const name = normalizeForMatch(slugMatch[1].replace(/-/g, ' '));
    const imgUrl = normalizeImageUrl(m[2]);
    console.log('  ' + JSON.stringify(name) + ' -> ' + (imgUrl ? 'HAS IMAGE' : 'NO IMAGE'));
  }

  // Try matching
  console.log('\n=== Match attempts ===');
  // Build a small imageMap from this one page
  const imageMap = new Map();
  const cardRegex2 = /<a[^>]+href="([^"]*\/product\/[^"]+)"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*>/gi;
  while ((m = cardRegex2.exec(html)) !== null) {
    const slugMatch = m[1].match(/\/product\/([^/]+)\/?$/);
    if (!slugMatch) continue;
    const name = normalizeForMatch(slugMatch[1].replace(/-/g, ' '));
    const imgUrl = normalizeImageUrl(m[2]);
    if (imgUrl) imageMap.set(name, imgUrl);
  }

  for (const [dbKey] of dbLines) {
    // Direct
    if (imageMap.has(dbKey)) {
      console.log('  DIRECT: ' + dbKey);
      continue;
    }
    // With mapei prefix
    if (imageMap.has('mapei ' + dbKey)) {
      console.log('  MAPEI PREFIX: ' + dbKey + ' -> mapei ' + dbKey);
      continue;
    }
    // Fuzzy
    let found = false;
    for (const [imgKey] of imageMap) {
      if (imgKey.includes(dbKey) || dbKey.includes(imgKey)) {
        console.log('  FUZZY: ' + dbKey + ' <-> ' + imgKey);
        found = true;
        break;
      }
    }
    if (!found) {
      console.log('  MISS: ' + dbKey);
    }
  }

  await pool.end();
}
main().catch(e => console.error(e));
