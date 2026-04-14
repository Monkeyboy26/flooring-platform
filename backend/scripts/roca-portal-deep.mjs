/**
 * Deep exploration of Roca marketing-assets portal from host machine.
 * Looks for AJAX endpoints, lazy-loaded images, JS data, and downloadable ZIPs.
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

  // Follow redirect
  const loc = r2.headers.get('location');
  if (loc) {
    const r3 = await fetch(loc, { headers: { Cookie: cookieStr }, redirect: 'follow' });
    const cookies3 = r3.headers.getSetCookie ? r3.headers.getSetCookie() : [];
    for (const c of cookies3) cookieStr += '; ' + c.split(';')[0];
  }
  return cookieStr;
}

async function fetchPage(url, cookies) {
  const resp = await fetch(url, { headers: { Cookie: cookies, 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return null;
  return resp.text();
}

async function go() {
  const cookies = await login();
  console.log('Logged in\n');

  // 1. Fetch Floor page and analyze ALL image/asset references
  for (const pagePath of ['/floor/', '/wall/']) {
    console.log(`\n=== Analyzing ${pagePath} ===`);
    const html = await fetchPage(BASE + pagePath, cookies);
    if (!html) { console.log('Failed to fetch'); continue; }
    console.log('Page size:', html.length, 'bytes');

    // Look for ALL image references (not just /uploads/)
    const allImgs = new Set();

    // Standard src
    let m;
    const srcRe = /src="([^"]*\.(jpg|jpeg|png|webp|gif|svg)[^"]*)"/gi;
    while ((m = srcRe.exec(html)) !== null) allImgs.add(m[1]);

    // data-src (lazy loading)
    const dataSrcRe = /data-src="([^"]*\.(jpg|jpeg|png|webp|gif)[^"]*)"/gi;
    while ((m = dataSrcRe.exec(html)) !== null) allImgs.add(m[1]);

    // data-lazy-src
    const lazyRe = /data-lazy-src="([^"]*\.(jpg|jpeg|png|webp|gif)[^"]*)"/gi;
    while ((m = lazyRe.exec(html)) !== null) allImgs.add(m[1]);

    // srcset
    const srcsetRe = /srcset="([^"]*)"/gi;
    while ((m = srcsetRe.exec(html)) !== null) {
      const urls = m[1].split(',').map(s => s.trim().split(/\s+/)[0]);
      for (const u of urls) if (/\.(jpg|jpeg|png|webp)/i.test(u)) allImgs.add(u);
    }

    // background-image in style
    const bgRe = /background-image:\s*url\(['"]?([^'")]+\.(jpg|jpeg|png|webp))['"]?\)/gi;
    while ((m = bgRe.exec(html)) !== null) allImgs.add(m[1]);

    // Filter out icons/logos
    const productImgs = [...allImgs].filter(u => !u.includes('logo') && !u.includes('favicon') && !u.includes('icon') && !u.includes('gravatar'));
    console.log(`Total image refs: ${allImgs.size}, Product-like: ${productImgs.length}`);
    for (const img of productImgs.slice(0, 30)) console.log('  ' + img);

    // Look for AJAX/API endpoints in script tags
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    const ajaxUrls = new Set();
    const jsVars = [];
    while ((m = scriptRe.exec(html)) !== null) {
      const script = m[1];
      if (script.length < 10) continue;

      // Look for AJAX URLs
      const ajaxRe = /(?:url|ajax|fetch|endpoint|api)['":\s]+['"]([^'"]+)['"]/gi;
      let am;
      while ((am = ajaxRe.exec(script)) !== null) ajaxUrls.add(am[1]);

      // Look for WP AJAX
      if (script.includes('admin-ajax') || script.includes('wp_ajax') || script.includes('ajaxurl')) {
        jsVars.push('FOUND WP AJAX reference');
        // Extract ajaxurl
        const ajaxUrlMatch = script.match(/ajaxurl\s*[:=]\s*['"]([^'"]+)['"]/);
        if (ajaxUrlMatch) jsVars.push('ajaxurl: ' + ajaxUrlMatch[1]);
      }

      // Look for REST API nonce
      if (script.includes('wpApiSettings') || script.includes('wp_rest')) {
        const nonceMatch = script.match(/nonce['":\s]+['"]([^'"]+)['"]/);
        if (nonceMatch) jsVars.push('REST nonce: ' + nonceMatch[1]);
      }

      // Look for large data objects (product data embedded in JS)
      if (script.includes('products') || script.includes('collections') || script.includes('gallery')) {
        const preview = script.substring(0, 300).replace(/\n/g, ' ');
        jsVars.push('Data script: ' + preview);
      }
    }

    if (ajaxUrls.size) {
      console.log('\nAJAX/API URLs found:');
      for (const u of ajaxUrls) console.log('  ' + u);
    }
    if (jsVars.length) {
      console.log('\nJS vars/data:');
      for (const v of jsVars) console.log('  ' + v);
    }

    // Look for download links (ZIPs, PDFs)
    const dlRe = /href="([^"]*\.(zip|pdf|rar|7z)[^"]*)"/gi;
    const downloads = new Set();
    while ((m = dlRe.exec(html)) !== null) downloads.add(m[1]);
    if (downloads.size) {
      console.log('\nDownloadable files:');
      for (const d of downloads) console.log('  ' + d);
    }

    // Look for iframes
    const iframeRe = /<iframe[^>]*src="([^"]+)"/gi;
    while ((m = iframeRe.exec(html)) !== null) console.log('  iframe: ' + m[1]);
  }

  // 2. Try WP REST API with more endpoints
  console.log('\n=== WP REST API deep dive ===');

  // List all routes
  const routesJson = await fetchPage(BASE + '/wp-json/', cookies);
  if (routesJson) {
    try {
      const api = JSON.parse(routesJson);
      const routes = Object.keys(api.routes || {});
      console.log('Total API routes:', routes.length);
      // Show interesting ones
      const interesting = routes.filter(r =>
        !r.includes('/wp/v2/users') && !r.includes('/wp/v2/comments') &&
        !r.includes('/wp/v2/settings') && !r.includes('/oembed') &&
        (r.includes('product') || r.includes('project') || r.includes('collection') ||
         r.includes('gallery') || r.includes('image') || r.includes('asset') ||
         r.includes('download') || r.includes('floor') || r.includes('wall') ||
         r.includes('catalog') || r.includes('tile') || r.includes('wc') ||
         r.includes('media') || r.includes('attachment'))
      );
      console.log('Interesting routes:');
      for (const r of interesting) console.log('  ' + r);

      // Also show non-wp routes
      const custom = routes.filter(r => !r.startsWith('/wp/') && !r.startsWith('/oembed'));
      if (custom.length) {
        console.log('\nCustom (non-WP) routes:');
        for (const r of custom) console.log('  ' + r);
      }
    } catch(e) { console.log('Not JSON:', routesJson.substring(0, 200)); }
  }

  // 3. Try fetching ALL media pages
  console.log('\n=== All media ===');
  let totalMedia = 0;
  for (let page = 1; page <= 20; page++) {
    const resp = await fetch(BASE + `/wp-json/wp/v2/media?per_page=100&page=${page}`, {
      headers: { Cookie: cookies }
    });
    if (!resp.ok) break;
    const media = await resp.json();
    if (!media.length) break;
    totalMedia += media.length;
    for (const m of media) {
      const sizes = m.media_details?.sizes || {};
      const sizeNames = Object.keys(sizes);
      console.log(`  [${m.id}] ${m.title?.rendered || m.slug} (${sizeNames.join(',')}) → ${m.source_url}`);
    }
  }
  console.log('Total media items:', totalMedia);

  // 4. Try fetching all pages (not just posts)
  console.log('\n=== All Pages ===');
  const pagesResp = await fetch(BASE + '/wp-json/wp/v2/pages?per_page=100', {
    headers: { Cookie: cookies }
  });
  if (pagesResp.ok) {
    const pages = await pagesResp.json();
    console.log('Total pages:', pages.length);
    for (const p of pages) {
      console.log(`  [${p.id}] ${p.title?.rendered} → ${p.link} (${p.status})`);
    }
  }

  // 5. Try fetching posts
  console.log('\n=== Posts ===');
  const postsResp = await fetch(BASE + '/wp-json/wp/v2/posts?per_page=100', {
    headers: { Cookie: cookies }
  });
  if (postsResp.ok) {
    const posts = await postsResp.json();
    console.log('Posts:', posts.length);
    for (const p of posts.slice(0, 20)) {
      console.log(`  [${p.id}] ${p.title?.rendered} → ${p.link}`);
    }
  }

  // 6. Try common WP plugin endpoints
  console.log('\n=== Plugin endpoints ===');
  for (const ep of [
    '/wp-json/wp/v2/project?per_page=100',
    '/wp-json/wp/v2/portfolio?per_page=100',
    '/wp-json/wp/v2/gallery?per_page=100',
    '/wp-json/wp/v2/product?per_page=100',
    '/wp-json/wp/v2/download?per_page=100',
    '/wp-admin/admin-ajax.php?action=get_products',
    '/wp-admin/admin-ajax.php?action=get_downloads',
  ]) {
    const resp = await fetch(BASE + ep, { headers: { Cookie: cookies } });
    const text = await resp.text();
    const isJson = text.startsWith('[') || text.startsWith('{');
    if (resp.ok && isJson) {
      try {
        const data = JSON.parse(text);
        const count = Array.isArray(data) ? data.length : 'object';
        console.log(`  ${ep} → ${count} items`);
        if (Array.isArray(data) && data.length) {
          console.log('    Sample:', JSON.stringify(data[0]).substring(0, 200));
        }
      } catch { console.log(`  ${ep} → ${resp.status} (not parseable)`); }
    } else {
      console.log(`  ${ep} → ${resp.status} ${resp.ok ? '(HTML)' : ''}`);
    }
  }

  // 7. Check specific collection pages on the portal
  console.log('\n=== Collection-specific pages ===');
  for (const path of ['/category/floor/', '/category/wall/', '/category/all/', '/collections/', '/downloads/', '/resources/']) {
    const html = await fetchPage(BASE + path, cookies);
    if (html) {
      console.log(`  ${path}: ${html.length} bytes`);
      // Count images
      const imgCount = (html.match(/\.(jpg|jpeg|png|webp)/gi) || []).length;
      console.log(`    Image refs: ${imgCount}`);
    } else {
      console.log(`  ${path}: NOT FOUND`);
    }
  }
}

go().catch(console.error);
