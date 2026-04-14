/**
 * Extract all file IDs from WPFD fileview and fetch details more efficiently.
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

  // Get page 1 to extract all file IDs from fileview
  const url = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1`;
  const resp = await fetch(url, {
    headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest', 'Referer': BASE + '/floor/' },
  });
  const data = await resp.json();

  console.log('fileview entries:', data.fileview.length);
  console.log('First 5:', JSON.stringify(data.fileview.slice(0, 5)));
  console.log('Last 5:', JSON.stringify(data.fileview.slice(-5)));

  const fileIds = data.fileview.map(f => f.id);
  console.log(`Total file IDs: ${fileIds.length}`);
  console.log('ID range:', Math.min(...fileIds), '-', Math.max(...fileIds));

  // Now try to get individual file details
  console.log('\n--- Testing individual file detail endpoint ---');
  const testIds = fileIds.slice(0, 5);

  for (const id of testIds) {
    // Try task=file.listing with id parameter
    const u1 = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=file.listing&id=${id}`;
    const r1 = await fetch(u1, {
      headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const d1 = await r1.text();
    console.log(`file.listing id=${id}: ${d1.length} bytes`);
    if (d1.length < 500) console.log('  ', d1);

    // Try task=file.display
    const u2 = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=file.display&id=${id}`;
    const r2 = await fetch(u2, {
      headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const d2 = await r2.text();
    console.log(`file.display id=${id}: ${d2.length} bytes`);
    if (d2.length < 500) console.log('  ', d2);
  }

  // Try WP REST API for attachments
  console.log('\n--- WP REST API attachments ---');
  const attResp = await fetch(`${BASE}/wp-json/wp/v2/media?include=${testIds.join(',')}&per_page=10`, {
    headers: { Cookie: cookies },
  });
  const attData = await attResp.json();
  console.log('Attachments found:', Array.isArray(attData) ? attData.length : 'not array');

  // Try WP REST API with the file IDs as post IDs
  console.log('\n--- Try WP REST API posts ---');
  for (const id of testIds.slice(0, 2)) {
    const r = await fetch(`${BASE}/wp-json/wp/v2/posts/${id}`, { headers: { Cookie: cookies } });
    const d = await r.json();
    console.log(`post ${id}: ${r.status} - ${d.title?.rendered || d.code || 'unknown'}`);
  }

  // Try the download URL directly (we know the format from earlier)
  console.log('\n--- Test download URL ---');
  // From earlier: linkdownload was "https://marketing-assets.rocatileusa.com/download/1938/tiles/10157/always_veincut_moka_f1_60x120.jpg"
  // The download URL encodes catid/catname/fileId/filename.ext
  // Try HEAD request on a known download URL
  const testUrl = 'https://marketing-assets.rocatileusa.com/download/1938/tiles/10157/always_veincut_moka_f1_60x120.jpg';
  const headResp = await fetch(testUrl, { method: 'HEAD', headers: { Cookie: cookies } });
  console.log(`Download URL test: ${headResp.status}, content-type: ${headResp.headers.get('content-type')}, size: ${headResp.headers.get('content-length')}`);

  // The real question: can we get file details (name, ext, download link) for all 8000+ IDs
  // without paginating through 1677 pages?
  // Let's try fetching in larger batches via different params
  console.log('\n--- Try requesting multiple pages worth ---');
  // Maybe WPFD supports a fileIds parameter?
  const u3 = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1&limit=50`;
  const r3 = await fetch(u3, {
    headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest' },
  });
  const d3 = await r3.json();
  console.log(`With limit=50: ${d3.files?.length} files`);

  // Try wpfd_number_per_page
  const u4 = `${BASE}/wp-admin/admin-ajax.php?juwpfisadmin=false&action=wpfd&task=files.display&id_category=51&page=1&number_per_page=100`;
  const r4 = await fetch(u4, {
    headers: { Cookie: cookies, 'X-Requested-With': 'XMLHttpRequest' },
  });
  const d4 = await r4.json();
  console.log(`With number_per_page=100: ${d4.files?.length} files`);
}
go().catch(console.error);
