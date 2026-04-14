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
  for (const c of (r2.headers.getSetCookie ? r2.headers.getSetCookie() : []))
    cookieStr += '; ' + c.split(';')[0];
  const loc = r2.headers.get('location');
  if (loc) {
    const r3 = await fetch(loc, { headers: { Cookie: cookieStr }, redirect: 'follow' });
    for (const c of (r3.headers.getSetCookie ? r3.headers.getSetCookie() : []))
      cookieStr += '; ' + c.split(';')[0];
  }
  return cookieStr;
}
async function go() {
  const cookies = await login();
  console.log('Logged in');

  // Fetch page 1 raw and check actual response structure
  const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1`;
  const resp = await fetch(url, {
    headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
  });
  const text = await resp.text();
  console.log('Response length:', text.length);

  const data = JSON.parse(text);
  console.log('Keys:', Object.keys(data));
  console.log('files count:', data.files?.length);
  console.log('category:', JSON.stringify(data.category)?.substring(0, 200));
  console.log('pagination length:', data.pagination?.length);
  console.log('fileview type:', typeof data.fileview);
  if (typeof data.fileview === 'string') {
    console.log('fileview preview:', data.fileview.substring(0, 500));
  } else {
    console.log('fileview:', JSON.stringify(data.fileview)?.substring(0, 500));
  }
  console.log('notify_file_changes:', data.notify_file_changes);

  // Check size of each part
  console.log('\nSize breakdown:');
  for (const [k, v] of Object.entries(data)) {
    console.log(`  ${k}: ${JSON.stringify(v).length} bytes`);
  }

  // Try increasing per_page or limit
  console.log('\n--- Try with per_page param ---');
  for (const pp of [50, 100]) {
    const url2 = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1&per_page=${pp}&limit=${pp}`;
    const resp2 = await fetch(url2, {
      headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
    });
    const data2 = await resp2.json();
    console.log(`per_page=${pp}: ${data2.files?.length} files, response: ${JSON.stringify(data2).length} bytes`);
  }

  // Try accessing file list for specific subcategory
  console.log('\n--- Try specific WPFD subcategories ---');
  // From the data, files had catid: 1938 (TILES). Let's try that
  for (const catId of ['1938', '1939', '1940', '1941', '1942']) {
    const url3 = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=${catId}&page=1`;
    const resp3 = await fetch(url3, {
      headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
    });
    const data3 = await resp3.json();
    const catName = data3.category?.name;
    const total = data3.pagination?.match(/data-page='(\d+)'[^>]*>[\d,]+<\/a>\s*\n\s*<a class='next/);
    console.log(`cat=${catId} (${catName}): ${data3.files?.length} files, total pages: ${total?.[1] || '?'}`);
    if (data3.files?.length) {
      for (const f of data3.files.slice(0, 2)) console.log(`  ${f.post_title}.${f.ext} [${f.cattitle}]`);
    }
  }

  // Try getting ALL subcategory IDs
  console.log('\n--- Floor page subcategory exploration ---');
  const floorHtml = await (await fetch(BASE + '/floor/', { headers: { Cookie: cookies } })).text();
  const allIdcats = new Set();
  const idcatRe = /data-idcat="(\d+)"/g;
  let m2;
  while ((m2 = idcatRe.exec(floorHtml)) !== null) allIdcats.add(m2[1]);
  console.log('All data-idcat values:', [...allIdcats].sort((a,b) => parseInt(a)-parseInt(b)).join(', '));
  console.log('Count:', allIdcats.size);
}
go().catch(console.error);
