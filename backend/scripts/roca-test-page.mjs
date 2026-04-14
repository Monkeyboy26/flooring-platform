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

  // Test pages 1-5 with category 51
  for (const catId of ['51', '230', 'all_0']) {
    for (let page = 1; page <= 3; page++) {
      const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=${catId}&page=${page}`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);
        const resp = await fetch(url, {
          headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const data = await resp.json();
        const files = data.files || [];
        console.log(`cat=${catId} page=${page}: ${files.length} files${files.length ? `, first: ${files[0].post_title}` : ''}`);
        if (page === 1 && data.pagination) {
          const totalMatch = data.pagination.match(/data-page='(\d+)'[^>]*>[\d,]+<\/a>\s*\n\s*<a class='next/);
          if (totalMatch) console.log(`  Total pages: ${totalMatch[1]}`);
        }
      } catch(e) { console.log(`cat=${catId} page=${page}: ERROR ${e.message}`); }
    }
    console.log();
  }
}
go().catch(console.error);
