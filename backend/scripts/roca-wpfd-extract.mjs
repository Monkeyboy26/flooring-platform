/**
 * Extract all image files from Roca's WPFD categories and map to DB products.
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

  const ajaxUrl = BASE + '/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd';

  // Fetch files for a known category to understand the structure
  const resp = await fetch(`${ajaxUrl}&task=files.display&id_category=230`, {
    headers: { 'Cookie': cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
  });
  const data = await resp.json();

  console.log('Response keys:', Object.keys(data));

  if (data.files) {
    console.log(`Total files: ${data.files.length}`);

    // Show first 5 files in detail
    for (const f of data.files.slice(0, 5)) {
      console.log('\n--- File ---');
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === 'string' && v.length > 200) console.log(`  ${k}: ${v.substring(0, 200)}...`);
        else console.log(`  ${k}: ${JSON.stringify(v)}`);
      }
    }

    // Count by ext
    const byExt = {};
    for (const f of data.files) {
      byExt[f.ext] = (byExt[f.ext] || 0) + 1;
    }
    console.log('\nFiles by extension:', byExt);

    // Count by category
    const byCat = {};
    for (const f of data.files) {
      const key = f.cattitle || f.catname || 'unknown';
      byCat[key] = (byCat[key] || 0) + 1;
    }
    console.log('\nFiles by category:');
    for (const [cat, count] of Object.entries(byCat).sort((a,b) => b[1]-a[1])) {
      console.log(`  ${cat}: ${count}`);
    }

    // Show image files and their download links
    const imgFiles = data.files.filter(f => ['jpg', 'jpeg', 'png', 'webp'].includes(f.ext?.toLowerCase()));
    console.log(`\nImage files: ${imgFiles.length}`);

    // Group images by category
    const imgByCat = {};
    for (const f of imgFiles) {
      const cat = f.cattitle || f.catname || 'unknown';
      if (!imgByCat[cat]) imgByCat[cat] = [];
      imgByCat[cat].push(f);
    }
    console.log('\nImage files by category:');
    for (const [cat, files] of Object.entries(imgByCat).sort((a,b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${cat}: ${files.length} images`);
      for (const f of files.slice(0, 3)) {
        console.log(`    ${f.post_title} → ${f.linkdownload ? f.linkdownload.substring(0, 120) : 'no link'}`);
      }
      if (files.length > 3) console.log(`    ... and ${files.length - 3} more`);
    }
  }

  if (data.categories) {
    console.log(`\nSubcategories: ${data.categories.length}`);
    for (const c of data.categories) {
      console.log(`  [${c.term_id}] ${c.name} (${c.slug})`);
    }
  }
}

go().catch(console.error);
