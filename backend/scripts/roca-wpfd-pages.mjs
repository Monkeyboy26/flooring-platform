/**
 * Fetch ALL files from Roca marketing portal via WPFD pagination.
 * The API returns all files at the root level with pagination.
 * 1,677 pages × 5 files/page ≈ 8,385 files total.
 * We'll extract image files and save their info for later matching.
 */
import { writeFileSync } from 'fs';

const BASE = 'https://marketing-assets.rocatileusa.com';

async function login() {
  const r1 = await fetch(BASE, { redirect: 'follow' });
  const cookies1 = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
  let cookieStr = cookies1.map(c => c.split(';')[0]).join('; ');
  const html = await r1.text();
  const csrfMatch = html.match(/name="CSRFToken-wppb"\s+(?:id="[^"]*"\s+)?value="([^"]*)"/);
  const wppbLogin = html.match(/name="wppb_login"\s+value="([^"]*)"/);
  const wpRef = html.match(/name="_wp_http_referer"\s+value="([^"]*)"/);
  const body = new URLSearchParams({
    log: 'RomaFlooring', pwd: 'Iluvlions910!', rememberme: 'forever',
    'wp-submit': 'Log In', redirect_to: BASE + '/',
    wppb_login: wppbLogin ? wppbLogin[1] : 'true',
    wppb_form_location: 'page', wppb_request_url: BASE + '/',
    'CSRFToken-wppb': csrfMatch ? csrfMatch[1] : '',
    '_wp_http_referer': wpRef ? wpRef[1] : '/',
    wppb_redirect_check: 'true',
  });
  const r2 = await fetch(BASE + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr },
    body: body.toString(), redirect: 'manual',
  });
  const cookies2 = r2.headers.getSetCookie ? r2.headers.getSetCookie() : [];
  for (const c of cookies2) cookieStr += '; ' + c.split(';')[0];
  const loc = r2.headers.get('location');
  if (loc) {
    const r3 = await fetch(loc, { headers: { Cookie: cookieStr }, redirect: 'follow' });
    const cookies3 = r3.headers.getSetCookie ? r3.headers.getSetCookie() : [];
    for (const c of cookies3) cookieStr += '; ' + c.split(';')[0];
  }
  return cookieStr;
}

async function fetchPage(cookies, page, sourcecat = 'all_0') {
  const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=${sourcecat}&page=${page}`;
  const resp = await fetch(url, {
    headers: {
      'Cookie': cookies,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': BASE + '/floor/',
    },
  });
  if (!resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
}

async function go() {
  const cookies = await login();
  console.log('Logged in\n');

  // Test pagination - fetch first few pages to verify it works
  console.log('=== Testing pagination ===');
  const allFiles = [];
  const imgExts = new Set(['jpg', 'jpeg', 'png', 'webp']);

  // First, get page 1 to confirm total pages
  const page1 = await fetchPage(cookies, 1);
  if (!page1) { console.log('Failed to fetch page 1'); return; }

  // Parse total pages from pagination HTML
  const totalPagesMatch = page1.pagination?.match(/data-page='(\d+)'[^>]*>\d[\d,]+<\/a>\s*\n\s*<a class='next/);
  const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1677;
  console.log(`Total pages: ${totalPages}`);
  console.log(`Files per page: ${page1.files?.length || 0}`);

  // Check page 1 and 2 to see if they have different files
  for (const f of (page1.files || [])) {
    allFiles.push({
      id: f.ID,
      title: f.post_title,
      ext: f.ext,
      catname: f.cattitle || f.catname,
      catid: f.catid,
      download: f.linkdownload,
      size: f.size,
    });
  }

  const page2 = await fetchPage(cookies, 2);
  if (page2?.files) {
    console.log(`Page 2 files: ${page2.files.length}`);
    for (const f of page2.files) {
      console.log(`  ${f.post_title}.${f.ext} [${f.cattitle}] → ${f.linkdownload?.substring(0, 80)}`);
      allFiles.push({
        id: f.ID,
        title: f.post_title,
        ext: f.ext,
        catname: f.cattitle || f.catname,
        catid: f.catid,
        download: f.linkdownload,
        size: f.size,
      });
    }
  }

  // Pages 3-10 to get a sample
  for (let p = 3; p <= 10; p++) {
    const data = await fetchPage(cookies, p);
    if (!data?.files?.length) break;
    for (const f of data.files) {
      allFiles.push({
        id: f.ID,
        title: f.post_title,
        ext: f.ext,
        catname: f.cattitle || f.catname,
        catid: f.catid,
        download: f.linkdownload,
        size: f.size,
      });
    }
  }

  console.log(`\nCollected ${allFiles.length} files from pages 1-10`);

  // Analyze the files
  const byCat = {};
  for (const f of allFiles) {
    if (!byCat[f.catname]) byCat[f.catname] = [];
    byCat[f.catname].push(f);
  }
  console.log('\nFiles by category:');
  for (const [cat, files] of Object.entries(byCat).sort((a,b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${cat}: ${files.length} files`);
    for (const f of files.slice(0, 2)) console.log(`    ${f.title}.${f.ext}`);
  }

  // Check if image files are named with collection_color pattern
  const imgFiles = allFiles.filter(f => imgExts.has(f.ext?.toLowerCase()));
  console.log(`\nImage files: ${imgFiles.length}/${allFiles.length}`);
  console.log('\nAll image filenames (first 50):');
  for (const f of imgFiles.slice(0, 50)) {
    console.log(`  [${f.catname}] ${f.title}.${f.ext}`);
  }

  // Now let's do a large batch: fetch pages 1-100 concurrently in batches of 10
  console.log('\n=== Fetching pages 1-200 (batch of 10) ===');
  const allImgs = [];
  const seenIds = new Set();

  for (let batch = 0; batch < 20; batch++) {
    const startPage = batch * 10 + 1;
    const promises = [];
    for (let p = startPage; p < startPage + 10 && p <= totalPages; p++) {
      promises.push(fetchPage(cookies, p));
    }
    const results = await Promise.all(promises);
    let batchCount = 0;
    for (const data of results) {
      if (!data?.files?.length) continue;
      for (const f of data.files) {
        if (seenIds.has(f.ID)) continue;
        seenIds.add(f.ID);
        if (imgExts.has(f.ext?.toLowerCase())) {
          allImgs.push({
            id: f.ID,
            title: f.post_title,
            ext: f.ext,
            catname: f.cattitle || f.catname,
            catid: f.catid,
            download: f.linkdownload,
          });
          batchCount++;
        }
      }
    }
    process.stdout.write(`  Pages ${startPage}-${startPage+9}: ${batchCount} new images (total: ${allImgs.length})\n`);
    if (batchCount === 0) break;
  }

  console.log(`\nTotal unique images from pages 1-200: ${allImgs.length}`);

  // Group by category name
  const imgByCat = {};
  for (const f of allImgs) {
    if (!imgByCat[f.catname]) imgByCat[f.catname] = [];
    imgByCat[f.catname].push(f);
  }
  console.log('\nImage categories:');
  for (const [cat, files] of Object.entries(imgByCat).sort((a,b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${cat}: ${files.length} images`);
    for (const f of files.slice(0, 3)) console.log(`    ${f.title}`);
    if (files.length > 3) console.log(`    ... and ${files.length - 3} more`);
  }

  // Save all image data for the scraper to use
  writeFileSync('backend/data/roca-portal-images.json', JSON.stringify(allImgs, null, 2));
  console.log('\nSaved image data to backend/data/roca-portal-images.json');
}

go().catch(console.error);
