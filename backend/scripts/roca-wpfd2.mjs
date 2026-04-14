/**
 * Query WPFD categories using the correct AJAX format from the portal.
 * The WPFD plugin uses: admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=XXX
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

  // Get Floor page to extract WPFD config
  const floorHtml = await (await fetch(BASE + '/floor/', { headers: { Cookie: cookies } })).text();

  // Extract full wpfdparams
  const wpfdParamsMatch = floorHtml.match(/var wpfdparams\s*=\s*(\{[^;]+\});/);
  if (wpfdParamsMatch) {
    try {
      const params = JSON.parse(wpfdParamsMatch[1]);
      console.log('WPFD params:');
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string' && v.length > 100) console.log(`  ${k}: ${v.substring(0, 100)}...`);
        else console.log(`  ${k}: ${v}`);
      }
    } catch(e) { console.log('Could not parse wpfdparams'); }
  }

  // Extract wpfdfrontend
  const wpfdFrontMatch = floorHtml.match(/var wpfdfrontend\s*=\s*(\{[^;]+\});/);
  if (wpfdFrontMatch) {
    try {
      const params = JSON.parse(wpfdFrontMatch[1]);
      console.log('\nWPFD frontend:');
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string' && v.length > 100) console.log(`  ${k}: ${v.substring(0, 100)}...`);
        else console.log(`  ${k}: ${JSON.stringify(v)}`);
      }
    } catch(e) { console.log('Could not parse wpfdfrontend'); }
  }

  // Extract all data-idcat values with their context (to see category names)
  const idcatRe = /data-idcat="(\d+)"[^>]*>([^<]*)</gi;
  let m;
  const catNames = new Map();
  while ((m = idcatRe.exec(floorHtml)) !== null) {
    if (m[2].trim()) catNames.set(m[1], m[2].trim());
  }

  // Also try extracting from title/text after the link
  const catLinkRe = /data-idcat="(\d+)"[^>]*>[^<]*<[^>]*>([^<]+)/gi;
  while ((m = catLinkRe.exec(floorHtml)) !== null) {
    if (m[2].trim() && !catNames.has(m[1])) catNames.set(m[1], m[2].trim());
  }

  console.log('\nCategory IDs and names:');
  for (const [id, name] of [...catNames].sort((a,b) => a[0]-b[0])) {
    console.log(`  [${id}] ${name}`);
  }

  // The WPFD AJAX URL format from the JS config
  const ajaxBase = BASE + '/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd';

  // Try different task types with real category IDs
  const testCats = [...catNames.keys()].slice(0, 5);
  if (!testCats.length) testCats.push('51', '230', '56');

  console.log('\n=== Testing WPFD AJAX with different tasks ===');
  for (const task of ['files.display', 'categories.display', 'file.download', 'category.listCategoriesAndFiles', 'file.listing']) {
    for (const catId of testCats.slice(0, 2)) {
      // GET request (matching the WPFD JS behavior)
      const url = `${ajaxBase}&task=${task}&id_category=${catId}`;
      const resp = await fetch(url, {
        headers: {
          'Cookie': cookies,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': BASE + '/floor/',
        },
      });
      const text = await resp.text();
      if (text.length > 60 || !text.includes('permission')) {
        console.log(`\n  task=${task}&cat=${catId}: ${resp.status}, ${text.length} bytes`);
        console.log('  Response:', text.substring(0, 500));
      }
    }
  }

  // Also try POST
  console.log('\n=== POST requests ===');
  for (const catId of testCats.slice(0, 3)) {
    const resp = await fetch(ajaxBase, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': BASE + '/floor/',
      },
      body: `task=files.display&id_category=${catId}`,
    });
    const text = await resp.text();
    console.log(`  POST cat=${catId}: ${resp.status}, ${text.length} bytes`);
    if (text.length > 60) {
      // Try parse as JSON
      try {
        const data = JSON.parse(text);
        if (data.files) {
          console.log(`    Files: ${data.files.length}`);
          for (const f of data.files.slice(0, 5)) {
            console.log(`    - ${f.post_title || f.title} (${f.ext}) → ${f.linkdownload || f.link || ''}`);
          }
        }
        if (data.categories) {
          console.log(`    Subcategories: ${data.categories.length}`);
          for (const c of data.categories.slice(0, 10)) {
            console.log(`    - [${c.term_id || c.id}] ${c.name}`);
          }
        }
      } catch {
        console.log('    (Not JSON) Preview:', text.substring(0, 300));
      }
    } else {
      console.log('    Response:', text);
    }
  }

  // Try with the full AJAX URL pattern observed
  console.log('\n=== Full URL format ===');
  for (const catId of testCats.slice(0, 3)) {
    const url = `${ajaxBase}&task=files.display&id_category=${catId}&juwpfisadmin=0`;
    const resp = await fetch(url, {
      headers: { 'Cookie': cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
    });
    const text = await resp.text();
    console.log(`  Full format cat=${catId}: ${resp.status}, ${text.length} bytes`);
    if (text.length > 60) console.log('  Preview:', text.substring(0, 500));
  }
}

go().catch(console.error);
