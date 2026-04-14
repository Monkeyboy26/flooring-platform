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
  return cookieStr;
}

async function fetchJson(url, cookies) {
  const resp = await fetch(url, { headers: { Cookie: cookies } });
  if (!resp.ok) return null;
  return resp.json();
}

async function fetchHtml(url, cookies) {
  const resp = await fetch(url, { headers: { Cookie: cookies } });
  if (!resp.ok) return null;
  return resp.text();
}

async function go() {
  const cookies = await login();
  console.log('Logged in\n');

  // 1. Explore "project" custom post type
  console.log('=== Projects (custom post type) ===');
  const projects = await fetchJson(BASE + '/wp-json/wp/v2/project?per_page=100', cookies);
  if (projects) {
    console.log('Projects found:', projects.length);
    for (const p of projects.slice(0, 30)) {
      console.log(`  [${p.id}] ${p.title?.rendered} → ${p.link}`);
    }
  } else {
    console.log('Projects endpoint returned null');
  }

  // 2. Check WooCommerce products
  console.log('\n=== WooCommerce Products ===');
  const wcProducts = await fetchJson(BASE + '/wp-json/wc/v3/products?per_page=20', cookies);
  if (wcProducts) {
    console.log('WC Products:', wcProducts.length);
    for (const p of wcProducts.slice(0, 10)) {
      console.log(`  [${p.id}] ${p.name} → ${p.permalink}`);
      if (p.images?.length) {
        for (const img of p.images) console.log(`    img: ${img.src}`);
      }
    }
  } else {
    console.log('WooCommerce not accessible via REST');
  }

  // 3. Fetch Floor page content
  console.log('\n=== Floor Page ===');
  const floorHtml = await fetchHtml(BASE + '/floor/', cookies);
  if (floorHtml) {
    console.log('Floor page length:', floorHtml.length);
    // Extract links to product/project pages
    const links = new Set();
    const linkRe = /href="(https?:\/\/marketing-assets[^"]*(?:\/project\/|\/product\/|\/floor\/|\/collection)[^"]*)"/gi;
    let m;
    while ((m = linkRe.exec(floorHtml)) !== null) links.add(m[1]);
    console.log('Product/project links:', links.size);
    for (const l of [...links].slice(0, 20)) console.log('  ' + l);

    // Also extract any download/image links
    const dlLinks = new Set();
    const dlRe = /href="([^"]*\.(?:zip|jpg|jpeg|png|pdf)[^"]*)"/gi;
    while ((m = dlRe.exec(floorHtml)) !== null) dlLinks.add(m[1]);
    console.log('\nDownload links:', dlLinks.size);
    for (const l of [...dlLinks].slice(0, 20)) console.log('  ' + l);

    // Extract any image src
    const imgs = new Set();
    const imgRe = /src="([^"]*uploads[^"]*)"/gi;
    while ((m = imgRe.exec(floorHtml)) !== null) {
      if (!m[1].includes('logo') && !m[1].includes('favicon')) imgs.add(m[1]);
    }
    console.log('\nImages on page:', imgs.size);
    for (const i of [...imgs].slice(0, 20)) console.log('  ' + i);
  }

  // 4. Fetch Wall page content
  console.log('\n=== Wall Page ===');
  const wallHtml = await fetchHtml(BASE + '/wall/', cookies);
  if (wallHtml) {
    console.log('Wall page length:', wallHtml.length);
    const imgs = new Set();
    const imgRe = /src="([^"]*uploads[^"]*)"/gi;
    let m;
    while ((m = imgRe.exec(wallHtml)) !== null) {
      if (!m[1].includes('logo') && !m[1].includes('favicon')) imgs.add(m[1]);
    }
    console.log('Images:', imgs.size);
    for (const i of [...imgs].slice(0, 10)) console.log('  ' + i);
  }

  // 5. Try project taxonomy
  console.log('\n=== Project Taxonomies ===');
  for (const tax of ['project_category', 'project_tag', 'category', 'project-category']) {
    const taxResp = await fetchJson(BASE + `/wp-json/wp/v2/${tax}?per_page=50`, cookies);
    if (taxResp && Array.isArray(taxResp) && taxResp.length) {
      console.log(`${tax}:`);
      for (const t of taxResp) console.log(`  [${t.id}] ${t.name} (${t.count})`);
    }
  }

  // 6. List all media with higher per_page
  console.log('\n=== All Media (page 1-3) ===');
  for (let page = 1; page <= 3; page++) {
    const media = await fetchJson(BASE + `/wp-json/wp/v2/media?per_page=100&page=${page}`, cookies);
    if (!media || !media.length) break;
    console.log(`Page ${page}: ${media.length} items`);
    for (const m of media) {
      if (!m.source_url.includes('logo') && !m.source_url.includes('favicon') && !m.source_url.includes('placeholder')) {
        console.log(`  ${m.title?.rendered || m.slug} → ${m.source_url}`);
      }
    }
  }
}

go().catch(console.error);
