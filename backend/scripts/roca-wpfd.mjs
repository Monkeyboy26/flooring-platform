/**
 * Explore Roca marketing portal's WP File Download (WPFD) plugin.
 * The Floor/Wall pages use WPFD to serve downloadable file packages.
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

async function go() {
  const cookies = await login();
  console.log('Logged in\n');

  // First, get the Floor page HTML and extract WPFD category/shortcode data
  const floorHtml = await (await fetch(BASE + '/floor/', { headers: { Cookie: cookies } })).text();

  // Look for wpfd shortcodes, category IDs, and JavaScript configuration
  console.log('=== WPFD Data in Floor page ===');

  // Find wpfd shortcodes [wpfd_category id="XXX"]
  const shortcodeRe = /\[wpfd_category\s+[^\]]*id="?(\d+)"?[^\]]*\]/gi;
  let m;
  const categoryIds = new Set();
  while ((m = shortcodeRe.exec(floorHtml)) !== null) {
    categoryIds.add(m[1]);
    console.log('Shortcode category:', m[0]);
  }

  // Find data-category, data-id, wpfd-category-* attributes
  const dataCatRe = /data-category[_-]?(?:id)?="?(\d+)"?/gi;
  while ((m = dataCatRe.exec(floorHtml)) !== null) categoryIds.add(m[1]);

  const wpfdIdRe = /wpfd[-_]category[-_](\d+)/gi;
  while ((m = wpfdIdRe.exec(floorHtml)) !== null) categoryIds.add(m[1]);

  // Also look for wpfd in class names
  const wpfdClassRe = /class="[^"]*wpfd[^"]*"/gi;
  const wpfdClasses = new Set();
  while ((m = wpfdClassRe.exec(floorHtml)) !== null) wpfdClasses.add(m[0]);
  console.log('\nWPFD CSS classes:', wpfdClasses.size);
  for (const c of wpfdClasses) console.log('  ' + c);

  // Look for wpfd nonce
  const nonceRe = /wpfd[_-]?nonce['":\s]+['"]([^'"]+)['"]/gi;
  while ((m = nonceRe.exec(floorHtml)) !== null) console.log('WPFD nonce:', m[1]);

  // Look for any wpfd configuration objects in scripts
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = scriptRe.exec(floorHtml)) !== null) {
    const script = m[1];
    if (script.includes('wpfd') || script.includes('WPFD')) {
      // Extract relevant parts
      const lines = script.split('\n');
      for (const line of lines) {
        if (line.includes('wpfd') || line.includes('WPFD') || line.includes('category')) {
          console.log('  JS: ' + line.trim().substring(0, 200));
        }
      }
    }
  }

  // Look for any data-idcat, data-catid, or similar
  const allDataAttrsRe = /data-[a-z]+="[^"]*"/gi;
  const dataAttrs = new Map();
  while ((m = allDataAttrsRe.exec(floorHtml)) !== null) {
    const [attr] = m[0].split('=');
    if (!dataAttrs.has(attr)) dataAttrs.set(attr, 0);
    dataAttrs.set(attr, dataAttrs.get(attr) + 1);
  }
  console.log('\nData attributes frequency:');
  for (const [attr, count] of [...dataAttrs].sort((a,b) => b[1]-a[1]).slice(0, 30)) {
    console.log(`  ${attr}: ${count}`);
  }

  // Find category IDs from the HTML more broadly
  const idcatRe = /(?:idcat|id_category|categoryid|cat_id|catid)["':=\s]+["']?(\d+)/gi;
  while ((m = idcatRe.exec(floorHtml)) !== null) categoryIds.add(m[1]);

  console.log('\nFound category IDs:', [...categoryIds]);

  // Try WPFD AJAX endpoint with various actions
  console.log('\n=== WPFD AJAX Calls ===');

  // Get nonce from page first
  const nonceMatch = floorHtml.match(/["']wpfd_nonce["']\s*:\s*["']([^"']+)["']/);
  const nonce = nonceMatch ? nonceMatch[1] : '';
  console.log('Nonce:', nonce);

  // Also check for WP nonce
  const wpNonceMatch = floorHtml.match(/["']_wpnonce["']\s*:\s*["']([^"']+)["']/);
  const wpNonce = wpNonceMatch ? wpNonceMatch[1] : '';

  // Try listing categories via AJAX
  for (const action of ['wpfd', 'wpfd_category', 'wpfd_files', 'wpfd_file', 'wpfd_search']) {
    const resp = await fetch(BASE + '/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        action,
        wpfd_nonce: nonce,
        _wpnonce: wpNonce,
      }).toString(),
    });
    const text = await resp.text();
    console.log(`\n  action=${action}: status=${resp.status}, length=${text.length}`);
    if (text.length < 2000) console.log('  Response:', text.substring(0, 500));
    else console.log('  Response (first 500):', text.substring(0, 500));
  }

  // Try getting files for specific categories (try IDs 1-20)
  console.log('\n=== Try fetching WPFD categories by ID ===');
  for (let catId = 1; catId <= 30; catId++) {
    const resp = await fetch(BASE + '/wp-admin/admin-ajax.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        action: 'wpfd',
        task: 'files.display',
        id_category: catId.toString(),
        wpfd_nonce: nonce,
      }).toString(),
    });
    const text = await resp.text();
    if (text.length > 10 && text !== '0' && !text.includes('error')) {
      console.log(`  Category ${catId}: ${text.length} bytes`);
      // Try to parse as JSON
      try {
        const data = JSON.parse(text);
        if (data.files?.length) {
          console.log(`    Files: ${data.files.length}`);
          for (const f of data.files.slice(0, 5)) {
            console.log(`    - ${f.title || f.post_title} → ${f.linkdownload || f.link || ''}`);
          }
        }
        if (data.categories?.length) {
          console.log(`    Subcategories: ${data.categories.length}`);
          for (const c of data.categories.slice(0, 10)) {
            console.log(`    - [${c.term_id || c.id}] ${c.name}`);
          }
        }
      } catch {
        // Might be HTML
        if (text.includes('wpfd_file_link')) {
          const links = new Set();
          const linkRe = /href="([^"]*)"[^>]*class="[^"]*wpfd_file_link/gi;
          let lm;
          while ((lm = linkRe.exec(text)) !== null) links.add(lm[1]);
          console.log(`    Download links: ${links.size}`);
          for (const l of [...links].slice(0, 3)) console.log(`    - ${l}`);
        }
      }
    }
  }

  // Also try the REST-style WPFD endpoint
  console.log('\n=== WPFD REST endpoints ===');
  for (const ep of [
    '/wp-json/wpfd/v1/files',
    '/wp-json/wpfd/v1/categories',
    '/?wpfd_action=files&category_id=1',
    '/?wpfd_file_download=1',
  ]) {
    const resp = await fetch(BASE + ep, { headers: { Cookie: cookies } });
    console.log(`  ${ep}: ${resp.status} (${(await resp.text()).length} bytes)`);
  }

  // Extract ALL shortcode category IDs from all pages
  console.log('\n=== Checking Wall, Evolux, Dune, BIM pages ===');
  for (const path of ['/wall/', '/evolux/', '/dune/', '/bim-image/']) {
    const html = await (await fetch(BASE + path, { headers: { Cookie: cookies } })).text();
    if (!html || html.length < 100) { console.log(`  ${path}: NOT FOUND`); continue; }
    console.log(`  ${path}: ${html.length} bytes`);

    // Count wpfd references
    const wpfdCount = (html.match(/wpfd/gi) || []).length;
    console.log(`    WPFD references: ${wpfdCount}`);

    // Extract category IDs
    const cats = new Set();
    const catRe = /id_category['":\s=]+['"]?(\d+)/gi;
    while ((m = catRe.exec(html)) !== null) cats.add(m[1]);
    const catRe2 = /wpfd[-_]category[-_](\d+)/gi;
    while ((m = catRe2.exec(html)) !== null) cats.add(m[1]);
    const catRe3 = /data-category="(\d+)"/gi;
    while ((m = catRe3.exec(html)) !== null) cats.add(m[1]);
    if (cats.size) console.log(`    Category IDs: ${[...cats].join(', ')}`);
  }
}

go().catch(console.error);
