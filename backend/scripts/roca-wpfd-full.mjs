/**
 * Full WPFD category tree exploration + file listing for Roca marketing portal.
 * Maps subcategories to products and extracts download URLs.
 */
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

async function fetchWPFD(cookies, catId) {
  const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=${catId}`;
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

  // Known parent category IDs from Floor page
  const parentCats = {
    51: 'ROOT?', 230: 'ABACO', 56: 'ABBEY', 62: 'AGATA', 329: 'ALASKA',
    332: 'ATHEA', 338: 'ATHOS', 347: 'ALLURE', 350: 'AVENUE',
    357: 'BALTIC', 359: 'BIANCO VENATINO', 361: 'BOHEME', 381: 'BLOCK',
    426: 'BRECCIA', 427: 'CALACATA', 464: 'CARRARA', 477: 'CASABLANCA',
    527: 'COLONIAL', 540: 'CONCRETE', 558: 'CRYSTAL', 562: 'DERBY',
    658: 'DOWNTOWN', 719: 'ESSENCE', 742: 'EVERGLADE',
  };

  // First, understand the category tree: check the `category` field in response
  console.log('=== Understanding category structure ===');
  const testData = await fetchWPFD(cookies, 230); // ABACO
  if (testData) {
    console.log('Category info:', JSON.stringify(testData.category, null, 2));
    console.log('Pagination:', JSON.stringify(testData.pagination));
  }

  // Try fetching a range of subcategory IDs around the known ones
  // The tiles subcat was 1938 — try nearby IDs
  console.log('\n=== Scanning subcategory IDs 1930-1960 ===');
  for (let id = 1930; id <= 1960; id++) {
    const data = await fetchWPFD(cookies, id);
    if (data && data.files && data.files.length > 0) {
      const imgFiles = data.files.filter(f => ['jpg','jpeg','png','webp'].includes(f.ext?.toLowerCase()));
      console.log(`  [${id}] ${data.category?.name || '?'}: ${data.files.length} files (${imgFiles.length} images)`);
      if (imgFiles.length) {
        console.log(`    Sample: ${imgFiles[0].post_title}`);
      }
    } else if (data && data.category) {
      console.log(`  [${id}] ${data.category?.name || '?'}: 0 files`);
    }
  }

  // Try a broader scan: IDs 50-100 to find lower-range categories
  console.log('\n=== Scanning IDs 50-100 ===');
  for (let id = 50; id <= 100; id++) {
    const data = await fetchWPFD(cookies, id);
    if (data && data.category) {
      const fileCount = data.files?.length || 0;
      if (fileCount > 0 || data.category.name) {
        console.log(`  [${id}] ${data.category.name || '?'}: ${fileCount} files`);
      }
    }
  }

  // Try scanning 200-400
  console.log('\n=== Scanning IDs 200-350 ===');
  for (let id = 200; id <= 350; id++) {
    const data = await fetchWPFD(cookies, id);
    if (data && data.files && data.files.length > 0) {
      console.log(`  [${id}] ${data.category?.name || '?'}: ${data.files.length} files`);
      if (data.files.length <= 3) {
        for (const f of data.files) console.log(`    - ${f.post_title}.${f.ext} → ${f.linkdownload}`);
      }
    } else if (data && data.category?.name) {
      // Has name but no files - it's a parent category
      // Check for subcategories in the response
    }
  }

  // Also try the WP taxonomy API for wpfd categories
  console.log('\n=== WP REST API for WPFD taxonomy ===');
  for (const tax of ['wpfd-category', 'wpfd_category', 'wp_file_download_category']) {
    const resp = await fetch(`${BASE}/wp-json/wp/v2/${tax}?per_page=100`, {
      headers: { Cookie: cookies },
    });
    if (resp.ok) {
      const items = await resp.json();
      console.log(`${tax}: ${items.length} items`);
      for (const item of items.slice(0, 20)) {
        console.log(`  [${item.id}] ${item.name} (parent: ${item.parent}, count: ${item.count})`);
      }
    } else {
      console.log(`${tax}: ${resp.status}`);
    }
  }

  // Check WP REST API for the wpfd-file post type
  console.log('\n=== WP REST API for WPFD post types ===');
  for (const pt of ['wpfd-file', 'wpfd_file', 'attachment']) {
    const resp = await fetch(`${BASE}/wp-json/wp/v2/${pt}?per_page=20`, {
      headers: { Cookie: cookies },
    });
    if (resp.ok) {
      const items = await resp.json();
      console.log(`${pt}: ${items.length} items`);
      for (const item of items.slice(0, 5)) {
        console.log(`  [${item.id}] ${item.title?.rendered || item.slug}`);
      }
    } else {
      console.log(`${pt}: ${resp.status}`);
    }
  }
}

go().catch(console.error);
