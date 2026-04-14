import pg from 'pg';
const pool = new pg.Pool({ host: process.env.DB_HOST||'localhost', port:5432, database:'flooring_pim', user:'postgres', password:'postgres' });

function normalizeForMatch(str) {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const BASE_URL = 'https://rocatileusa.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function go() {
  // Get slugs
  const resp = await fetch(BASE_URL + '/category/all', { headers: { 'User-Agent': UA } });
  const html = await resp.text();
  const slugs = new Set();
  const regex = /href="\/collections\/([^"]+)"/gi;
  let m;
  while ((m = regex.exec(html)) !== null) slugs.add(m[1].replace(/\/$/, ''));
  const slugArr = [...slugs];
  console.log('Total slugs found:', slugArr.length);
  console.log('First 15 slugs:', slugArr.slice(0, 15));

  // Get DB collections
  const res = await pool.query("SELECT DISTINCT collection FROM products WHERE vendor_id = (SELECT id FROM vendors WHERE code='ROCA') ORDER BY collection");
  const dbCols = res.rows.map(r => r.collection);
  console.log('\nTotal DB collections:', dbCols.length);
  console.log('First 15 DB collections:', dbCols.slice(0, 15));

  // Test matching
  console.log('\nMatching test:');
  for (const slug of slugArr.slice(0, 10)) {
    const ns = normalizeForMatch(slug);
    const match = dbCols.find(c => {
      const nc = normalizeForMatch(c);
      return nc === ns || ns.includes(nc) || nc.includes(ns);
    });
    console.log(`  slug="${slug}" norm="${ns}" -> ${match || 'NO MATCH'}`);
  }

  // Fetch abaco page
  console.log('\n--- Abaco page test ---');
  const testResp = await fetch(BASE_URL + '/collections/abaco', { headers: { 'User-Agent': UA } });
  const testHtml = await testResp.text();
  console.log('Page length:', testHtml.length);

  // Check for images
  const imgRegex = /<img[^>]*src="([^"]*upload[^"]*)"[^>]*/gi;
  let imgs = [];
  while ((m = imgRegex.exec(testHtml)) !== null) imgs.push(m[1]);
  console.log('Upload images found:', imgs.length);
  for (const img of imgs.slice(0, 10)) console.log('  ' + img);

  // Check for h3 tags
  const h3Regex = /<h3[^>]*>([^<]+)<\/h3>/gi;
  let h3s = [];
  while ((m = h3Regex.exec(testHtml)) !== null) h3s.push(m[1].trim());
  console.log('H3 tags:', h3s.slice(0, 10));

  // Check pairings: img followed by h3
  const pairRegex = /<img\s+[^>]*src="(\/uploads\/[^"]+)"[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>/gi;
  let pairs = [];
  while ((m = pairRegex.exec(testHtml)) !== null) pairs.push({ img: m[1], color: m[2].trim() });
  console.log('\nImage+H3 pairs:', pairs.length);
  for (const p of pairs.slice(0, 5)) console.log(`  ${p.color} -> ${p.img}`);

  // Show a snippet of the HTML around the first /uploads/ image
  const firstImgIdx = testHtml.indexOf('/uploads/');
  if (firstImgIdx > -1) {
    console.log('\nHTML around first upload image:');
    console.log(testHtml.substring(Math.max(0, firstImgIdx - 200), firstImgIdx + 200));
  }

  await pool.end();
}

go().catch(err => { console.error(err); process.exit(1); });
