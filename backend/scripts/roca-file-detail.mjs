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

  // Fetch file details for a few IDs
  for (const id of [10157, 10158, 5532, 5536, 8000]) {
    const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=file.display&id=${id}`;
    const resp = await fetch(url, {
      headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const text = await resp.text();
    console.log(`\nFile ${id}:`);
    try {
      const data = JSON.parse(text);
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.log('Raw:', text.substring(0, 500));
    }
  }

  // Also try getting page 1 and page 500 to see different file data
  console.log('\n\n=== Page comparisons ===');
  for (const page of [1, 100, 500, 1000, 1677]) {
    const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=${page}`;
    const resp = await fetch(url, {
      headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const data = await resp.json();
    console.log(`\nPage ${page}: ${data.files?.length} files`);
    for (const f of (data.files || [])) {
      console.log(`  [${f.ID}] ${f.post_title}.${f.ext} [${f.cattitle}/${f.catid}] → ${f.linkdownload?.substring(0, 100)}`);
    }
  }
}
go().catch(console.error);
