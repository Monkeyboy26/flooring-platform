import fs from 'fs';
import path from 'path';

let LOGO_DATA_URI = '';
try {
  const logoPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'assets', 'logo', 'roma-transparent.png');
  const logoBuffer = fs.readFileSync(logoPath);
  LOGO_DATA_URI = `data:image/png;base64,${logoBuffer.toString('base64')}`;
} catch (e) {
  console.warn('Logo file not found — PDFs will render without logo');
}

export { LOGO_DATA_URI };

export function itemDescriptionCell(collection, color, variant) {
  const sub = [color, variant].filter(Boolean).join(' \u00B7 ');
  if (!collection && !sub) return '\u2014';
  let html = collection ? `<span class="item-name">${collection}</span>` : '';
  if (sub) html += `<div class="item-detail">${sub}</div>`;
  return html;
}

export function getDocumentBaseCSS() {
  return `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Inter:wght@300;400;500;600&display=swap');

    * { box-sizing: border-box; }

    body {
      font-family: 'Inter', -apple-system, Arial, sans-serif;
      margin: 0; padding: 0;
      color: #1c1917; font-size: 12.5px; line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    .page {
      padding: 0;
    }

    /* ---- Header ---- */
    .header {
      display: flex; justify-content: space-between; align-items: flex-start;
      padding-bottom: 1.25rem; margin-bottom: 1.5rem;
      border-bottom: 2px solid #a87935;
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .header-logo { width: 52px; height: 52px; object-fit: contain; }
    .company-name {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 1.5rem; font-weight: 400; letter-spacing: 0.02em;
      color: #1c1917; margin: 0 0 3px;
    }
    .company-info { font-size: 0.6875rem; color: #78716c; line-height: 1.65; }

    .header-right { text-align: right; }
    .doc-type {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 1.625rem; font-weight: 400; color: #1c1917;
      letter-spacing: 0.01em; margin: 0;
    }

    /* ---- Document Meta Banner ---- */
    .doc-banner {
      display: flex; justify-content: space-between; align-items: center;
      background: #faf8f6; border: 1px solid #e7e5e4;
      padding: 0.875rem 1.25rem; margin-bottom: 1.5rem;
    }
    .doc-banner-left { display: flex; gap: 2rem; align-items: center; }
    .doc-banner .meta-group { }
    .meta-label {
      font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #a87935; font-weight: 500; margin: 0 0 1px;
    }
    .meta-value {
      font-size: 0.9375rem; font-weight: 600; color: #1c1917; margin: 0;
    }
    .meta-value-sm {
      font-size: 0.8125rem; font-weight: 500; color: #44403c; margin: 0;
    }

    /* ---- Info Blocks ---- */
    .info-row {
      display: flex; gap: 1.5rem; margin-bottom: 1.5rem;
    }
    .info-card {
      flex: 1; padding: 0.875rem 1rem;
      background: #faf8f6; border: 1px solid #e7e5e4;
    }
    .info-card h3 {
      font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #a87935; font-weight: 500; margin: 0 0 0.4rem;
    }
    .info-card p {
      margin: 0; font-size: 0.8125rem; color: #44403c; line-height: 1.6;
    }
    .info-card strong { color: #1c1917; font-weight: 600; }

    /* ---- Tables ---- */
    table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
    thead th {
      background: #1c1917; color: #ffffff;
      padding: 0.5rem 0.75rem; text-align: left;
      font-size: 0.625rem; font-weight: 500;
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    thead th:first-child { padding-left: 0.875rem; }
    thead th:last-child { padding-right: 0.875rem; }
    tbody td {
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #f0ede8;
      font-size: 0.8125rem; color: #44403c;
      vertical-align: top;
    }
    tbody td:first-child { padding-left: 0.875rem; }
    tbody td:last-child { padding-right: 0.875rem; }
    tbody tr:nth-child(even) td { background: #fdfcfb; }
    tbody tr:last-child td { border-bottom: 2px solid #e7e5e4; }

    .item-name { font-weight: 500; color: #1c1917; }
    .item-detail { font-size: 0.6875rem; color: #78716c; margin-top: 1px; }

    .text-right { text-align: right; }
    .text-center { text-align: center; }
    .text-muted { color: #78716c; }
    .text-small { font-size: 0.75rem; }

    /* ---- Totals ---- */
    .totals-wrapper {
      display: flex; justify-content: flex-end; margin-top: 0.25rem; margin-bottom: 1.5rem;
    }
    .totals-box {
      width: 280px;
    }
    .totals-line {
      display: flex; justify-content: space-between;
      padding: 0.3rem 0; font-size: 0.8125rem; color: #44403c;
    }
    .totals-line.subtotal {
      border-top: 1px solid #e7e5e4; padding-top: 0.5rem; margin-top: 0.25rem;
    }
    .totals-line.grand-total {
      border-top: 2px solid #1c1917; padding-top: 0.6rem; margin-top: 0.4rem;
      font-size: 0.9375rem; font-weight: 600; color: #1c1917;
    }
    .totals-line.balance-due {
      border-top: 1px solid #ecdcc0; margin-top: 0.35rem; padding-top: 0.5rem;
      font-weight: 700; font-size: 0.9375rem; color: #1c1917;
    }
    .totals-line.balance-due span:first-child {
      color: #a87935; font-weight: 600;
    }
    .totals-line.paid-full {
      font-weight: 500; color: #16a34a;
    }
    .totals-line .discount { color: #16a34a; }

    /* ---- Section Headers ---- */
    .section-title {
      font-size: 0.6875rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.12em; color: #a87935;
      margin: 1.75rem 0 0.625rem; padding-bottom: 0.375rem;
      border-bottom: 1px solid #e7e5e4;
    }

    /* ---- Notes ---- */
    .notes-block {
      margin-top: 1.25rem; padding: 0.875rem 1rem;
      background: #faf8f6; border: 1px solid #e7e5e4;
    }
    .notes-block h4 {
      font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #a87935; font-weight: 500; margin: 0 0 0.4rem;
    }
    .notes-block p, .notes-block div {
      margin: 0; font-size: 0.8125rem; color: #44403c; line-height: 1.6;
    }

    /* ---- Badges ---- */
    .badge {
      display: inline-block; padding: 2px 8px;
      font-size: 0.5625rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.05em;
      border-radius: 2px; vertical-align: middle;
    }
    .badge-draft { background: #f5f5f4; color: #78716c; }
    .badge-pending { background: #fef3c7; color: #92400e; }
    .badge-confirmed { background: #dbeafe; color: #1e40af; }
    .badge-sent { background: #dbeafe; color: #1e40af; }
    .badge-revised { background: #fef3c7; color: #92400e; }
    .badge-fulfilled { background: #dcfce7; color: #166534; }
    .badge-paid { background: #dcfce7; color: #166534; }
    .badge-cancelled { background: #fee2e2; color: #991b1b; }
    .badge-void { background: #fee2e2; color: #991b1b; }
    .badge-overdue { background: #fee2e2; color: #991b1b; }
    .badge-partial { background: #fef3c7; color: #92400e; }
    .badge-valid { background: #dcfce7; color: #166534; }
    .badge-expired { background: #fee2e2; color: #991b1b; }

    /* ---- Footer ---- */
    .doc-footer {
      margin-top: 2.5rem; padding-top: 0.875rem;
      border-top: 2px solid #a87935;
      display: flex; justify-content: space-between; align-items: flex-end;
    }
    .doc-footer-left {
      font-size: 0.625rem; color: #a8a29e; line-height: 1.6;
    }
    .doc-footer-right {
      text-align: right;
    }
    .doc-footer-brand {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 0.875rem; font-weight: 400; letter-spacing: 0.08em;
      color: #a87935; margin: 0;
    }
    .doc-footer-sub {
      font-size: 0.5625rem; color: #a8a29e; margin: 2px 0 0;
      letter-spacing: 0.02em;
    }

    /* ---- Approval/Signature ---- */
    .approval-line {
      margin-top: 1rem; font-size: 0.75rem; color: #78716c;
    }

    /* ---- Terms ---- */
    .terms {
      margin-top: 1.25rem; font-size: 0.6875rem; color: #a8a29e; line-height: 1.6;
    }
    .terms p { margin: 0 0 0.15rem; }

    /* Legacy compat */
    .info-block { margin-bottom: 1.5rem; padding: 0.875rem 1rem; background: #faf8f6; border: 1px solid #e7e5e4; }
    .info-block h3 { font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em; color: #a87935; font-weight: 500; margin: 0 0 0.4rem; }
    .info-columns { display: flex; gap: 1.5rem; margin-bottom: 1.5rem; }
    .info-columns .info-block { flex: 1; }
  `;
}

export function getDocumentHeader(title) {
  const logoImg = LOGO_DATA_URI ? `<img src="${LOGO_DATA_URI}" class="header-logo" alt="Roma Flooring Designs"/>` : '';
  return `
    <div class="header">
      <div class="header-left">
        ${logoImg}
        <div>
          <p class="company-name">Roma Flooring Designs</p>
          <div class="company-info">
            1440 S. State College Blvd #6M, Anaheim, CA 92806<br/>
            (714) 999-0009 &nbsp;&middot;&nbsp; Sales@romaflooringdesigns.com
          </div>
        </div>
      </div>
      <div class="header-right">
        <p class="doc-type">${title}</p>
      </div>
    </div>
  `;
}

export function getDocumentFooter(terms) {
  return `
    ${terms ? `<div class="terms">${terms}</div>` : ''}
    <div class="doc-footer">
      <div class="doc-footer-left">
        License #830966 &nbsp;&middot;&nbsp; www.romaflooringdesigns.com
      </div>
      <div class="doc-footer-right">
        <p class="doc-footer-brand">ROMA FLOORING DESIGNS</p>
      </div>
    </div>
  `;
}

export async function generatePDF(html, filename, req, res, options = {}) {
  // Preview mode: return HTML directly for iframe rendering
  if (req.query.preview === 'true') {
    res.set('Content-Type', 'text/html');
    return res.send(html);
  }
  const defaultMargin = { top: '0.6in', bottom: '0.6in', left: '0.65in', right: '0.65in' };
  const margin = options.margin || defaultMargin;
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    // If a straggling asset keeps the network busy past the timeout, render
    // with whatever has loaded rather than degrading to raw HTML.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 })
      .catch(err => console.warn('generatePDF: assets still loading at timeout, rendering anyway:', err.message));
    const pdf = await page.pdf({ format: 'Letter', margin });
    await browser.close();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(pdf);
  } catch (pdfErr) {
    // Fallback: return HTML if Puppeteer unavailable
    console.error('generatePDF fell back to HTML:', pdfErr.message);
    res.set('Content-Type', 'text/html');
    res.send(html);
  }
}

export async function generatePDFBuffer(html, options = {}) {
  const defaultMargin = { top: '0.6in', bottom: '0.6in', left: '0.65in', right: '0.65in' };
  const margin = options.margin || defaultMargin;
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 })
    .catch(err => console.warn('generatePDFBuffer: assets still loading at timeout, rendering anyway:', err.message));
  const pdf = await page.pdf({ format: 'Letter', margin });
  await browser.close();
  return Buffer.from(pdf);
}

export async function generatePOHtml(pool, poId) {
  const po = await pool.query(`
    SELECT po.*,
      v.name as vendor_name, v.code as vendor_code, v.email as vendor_email, v.edi_config,
      COALESCE(sa.first_name || ' ' || sa.last_name, sr_a.first_name || ' ' || sr_a.last_name) as approved_by_name,
      COALESCE(sa.email, sr_a.email) as approver_email,
      o.order_number, o.sales_rep_id,
      sr_b.first_name || ' ' || sr_b.last_name as buyer_name,
      sr_b.email as buyer_email
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    LEFT JOIN staff_accounts sa ON sa.id = po.approved_by
    LEFT JOIN sales_reps sr_a ON sr_a.id = po.approved_by
    LEFT JOIN orders o ON o.id = po.order_id
    LEFT JOIN sales_reps sr_b ON sr_b.id = o.sales_rep_id
    WHERE po.id = $1
  `, [poId]);
  if (!po.rows.length) return null;
  const p = po.rows[0];

  const items = await pool.query(`
    SELECT poi.*, ma.url as primary_image, sk.internal_sku
    FROM purchase_order_items poi
    LEFT JOIN skus sk ON sk.id = poi.sku_id
    LEFT JOIN media_assets ma ON ma.sku_id = poi.sku_id AND ma.asset_type = 'primary'
    WHERE poi.purchase_order_id = $1 ORDER BY poi.created_at
  `, [poId]);

  // -- Derived values --
  const buyerName = p.buyer_name || p.approved_by_name || '\u2014';
  const buyerEmail = p.buyer_email || p.approver_email || '';

  const fmtDate = (d) => {
    if (!d) return '\u2014';
    const dt = new Date(d);
    return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };
  const fmtShortDate = (d) => {
    if (!d) return '\u2014';
    const dt = new Date(d);
    const m = dt.toLocaleDateString('en-US', { month: 'short' });
    const day = dt.getDate();
    const yr = dt.getFullYear();
    const h = dt.getHours();
    const min = dt.getMinutes().toString().padStart(2, '0');
    const ampm = h >= 12 ? 'p' : 'a';
    const h12 = h % 12 || 12;
    return `${m} ${day}, ${yr} &middot; ${h12}:${min}${ampm}`;
  };

  const statusDotClass = {
    draft: 'dot-draft', sent: 'dot-sent', acknowledged: 'dot-ack',
    fulfilled: 'dot-fulfilled', cancelled: 'dot-cancelled'
  }[p.status] || 'dot-draft';
  const statusLabel = (p.status || 'draft').toUpperCase();

  const ediConfig = p.edi_config || {};
  const ediId = ediConfig.receiver_id || '';
  const shipTo = p.ship_to || 'Roma Anaheim Warehouse\n1440 S. State College Blvd\nAnaheim, CA 92806';
  const shipLines = shipTo.split('\n');

  const ink = '#1c1917';
  const muted = '#8a7e68';
  const accent = '#a87935';
  const warm = '#d8cdb6';
  const cool = '#c4bba5';
  const mono = "ui-monospace, monospace";
  const serif = "'Cormorant Garamond', 'Times New Roman', serif";
  const sans = "'Inter', system-ui, sans-serif";
  const subtotal = parseFloat(p.subtotal || 0);

  // Approved stamp: show when PO has been approved/sent
  const showApprovedStamp = ['sent', 'acknowledged', 'fulfilled'].includes(p.status);
  const stampLabel = p.status === 'acknowledged' ? 'Acknowledged' : 'Approved &amp; sent';

  const html = `<!DOCTYPE html><html><head>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
    <style>
    :root{
      --roma-serif:${serif};
      --roma-sans:${sans};
      --ink:${ink};--muted:${muted};--accent:${accent};--warm:${warm};--cool:${cool};
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{margin:0;padding:0;height:100%}
    body{font-family:var(--roma-sans);color:var(--ink);font-size:11px;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
    ol{margin:0;padding-left:14px;display:grid;gap:4px}
    </style>
    <script>document.fonts&&document.fonts.ready.then(function(){})</script>
    </head><body>
    <div style="width:100%;height:100%;background:#fff;color:${ink};font-family:${sans};padding:48px 56px 40px;box-sizing:border-box;display:grid;grid-template-rows:auto auto auto 1fr auto;gap:0;font-size:11px">

      <!-- HEADER -->
      <div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid ${ink}22">
        <div>
          <div style="font:300 36px/1 ${serif};letter-spacing:-0.014em;color:${ink}">Roma</div>
          <div style="margin-top:4px;font:500 8px/1 ${mono};letter-spacing:0.22em;text-transform:uppercase;color:${muted}">Flooring &middot; Surfaces &middot; Since 1999</div>
          <div style="margin-top:14px;font:400 10px/1.5 ${sans};color:${ink}cc">
            Roma Flooring Designs, Inc.<br>
            1440 S. State College Blvd, Anaheim, CA 92806<br>
            (714) 999-0009 &middot; orders@romaflooringdesigns.com<br>
            CSLB #874621
          </div>
        </div>
        <div style="text-align:right;min-width:240px">
          <div style="font:500 9px/1 ${mono};letter-spacing:0.22em;text-transform:uppercase;color:${muted}">Purchase order</div>
          <div style="font:300 30px/1 ${serif};letter-spacing:-0.014em;color:${ink};margin-top:6px">${p.po_number}</div>
          <div style="margin-top:12px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 ${sans};text-align:left">
            <span style="color:${muted}">Issued</span>
            <span style="color:${ink};text-align:right">${fmtDate(p.created_at)}</span>
            ${p.expected_delivery ? `<span style="color:${muted}">Expected</span><span style="color:${ink};text-align:right">${fmtDate(p.expected_delivery)}</span>` : ''}
            ${p.order_number ? `<span style="color:${muted}">Customer ref</span><span style="color:${ink};text-align:right">${p.order_number}</span>` : ''}
            <span style="color:${muted}">Revision</span>
            <span style="color:${ink};text-align:right">${p.revision || 0}</span>
            <span style="color:${muted}">Status</span>
            <span style="color:${accent};text-align:right;font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase">&#9679; ${statusLabel}</span>
          </div>
        </div>
      </div>

      <!-- APPROVED STAMP -->
      <div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:4px;border-bottom:1px solid ${ink}11">
        <div style="font:500 9px/1.4 ${sans};letter-spacing:0.06em;color:${ink}cc">
          This purchase order is binding upon vendor acknowledgment. Reference <strong style="color:${ink}">${p.po_number}</strong> on all packing slips, invoices, BOLs, and shipping documents. Vendor to confirm via X12 855 or email reply within 1 business day. Pricing locked at the costs below; any change requires Roma&rsquo;s written approval.
        </div>
        ${showApprovedStamp ? `<div style="display:flex;align-items:center;gap:0;padding:8px 14px;border:1.5px solid ${accent};color:${accent};font:500 11px/1 ${mono};letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg)">${stampLabel}</div>` : ''}
      </div>

      <!-- BUYER / VENDOR / SHIP-TO -->
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:16px 0 20px;border-bottom:1px solid ${ink}22">
        <div>
          <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Buyer</div>
          <div style="font:500 11px/1.2 ${sans};color:${ink}">${buyerName}</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">
            Sales rep<br>${buyerEmail}
            ${p.approved_by_name ? `<br><br><span style="color:${muted}">Approved by</span><br>${p.approved_by_name}<br>${fmtShortDate(p.approved_at)}` : ''}
          </div>
        </div>
        <div>
          <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Sold by &middot; ${p.vendor_code}</div>
          <div style="font:500 11px/1.2 ${sans};color:${ink}">${p.vendor_name}</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">
            ${p.vendor_email || ''}
          </div>
        </div>
        <div>
          <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Ship to</div>
          <div style="font:500 11px/1.2 ${sans};color:${ink}">${shipLines[0] || ''}</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}cc;margin-top:4px">${shipLines.slice(1).join('<br>')}</div>
          <div style="margin-top:8px;padding:6px 10px;background:${warm};font:500 9px/1.4 ${mono};letter-spacing:0.14em;text-transform:uppercase;color:${ink};display:inline-block">&#9679; Receiving &middot; Mon&ndash;Fri &middot; 7a&ndash;4p PT</div>
          <div style="font:400 10px/1.5 ${sans};color:${ink}99;margin-top:6px">28&rsquo; truck max &middot; forklift on-site</div>
          ${ediId ? `<div style="margin-top:10px;font:400 10px/1.5 ${sans};color:${muted}">EDI: <span style="color:${ink}">${ediId}</span></div>` : ''}
        </div>
      </div>

      <!-- LINE ITEMS -->
      <div style="padding-top:18px">
        <div style="display:grid;grid-template-columns:28px 110px 1fr 70px 60px 80px 110px;gap:10px;padding:0 0 10px;border-bottom:1px solid ${ink}33;font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase;color:${muted}">
          <span>Ln</span><span>Vendor SKU</span><span>Description</span>
          <span style="text-align:right">Qty</span><span>UOM</span>
          <span style="text-align:right">Unit cost</span><span style="text-align:right">Line subtotal</span>
        </div>
        ${items.rows.map((it, idx) => {
          const ln = String(idx + 1).padStart(2, '0');
          const vsku = it.vendor_sku || '\u2014';
          const rsku = it.internal_sku ? `Roma ${it.internal_sku}` : '';
          const imgHtml = it.primary_image
            ? `<img src="${it.primary_image}" style="width:32px;height:32px;object-fit:cover;flex-shrink:0;border:0.5px solid ${ink}22" />`
            : '';
          const desc = it.product_name || it.description || '\u2014';
          const dyeLot = it.dye_lot || '\u2014';
          const uom = (it.sell_by || 'unit').toUpperCase();
          const cost = parseFloat(it.cost || 0).toFixed(2);
          const sub = parseFloat(it.subtotal || 0).toFixed(2);
          const isLast = idx === items.rows.length - 1;
          return `<div style="display:grid;grid-template-columns:28px 110px 1fr 70px 60px 80px 110px;gap:10px;padding:12px 0;border-bottom:${isLast ? 'none' : `1px solid ${ink}11`};align-items:flex-start">
            <span style="font:400 11px/1.4 ${serif};color:${muted}">${ln}</span>
            <div>
              <div style="font:500 10px/1.2 ${mono};color:${ink};letter-spacing:0.04em">${vsku}</div>
              ${rsku ? `<div style="font:400 9px/1.4 ${sans};color:${muted};margin-top:2px">${rsku}</div>` : ''}
            </div>
            <div style="display:flex;gap:10px;align-items:flex-start">
              ${imgHtml}
              <div>
                <div style="font:500 11px/1.3 ${sans};color:${ink};letter-spacing:-0.004em">${desc}</div>
                <div style="font:500 9px/1.4 ${mono};letter-spacing:0.12em;color:${muted};text-transform:uppercase;margin-top:3px">Dye lot: ${dyeLot}</div>
              </div>
            </div>
            <div style="text-align:right;font:400 12px/1.2 ${serif};color:${ink};letter-spacing:-0.005em">${it.qty}</div>
            <div style="font:500 9px/1.4 ${mono};color:${muted};text-transform:uppercase">${uom}</div>
            <div style="text-align:right;font:400 11px/1.2 ${serif};color:${ink};letter-spacing:-0.005em">$${cost}</div>
            <div style="text-align:right;font:500 12px/1.2 ${serif};color:${ink};letter-spacing:-0.005em">$${sub}</div>
          </div>`;
        }).join('')}
      </div>

      <!-- TERMS + TOTALS + SIGNATURES + FOOTER (5th grid row) -->
      <div>
        <div style="display:grid;grid-template-columns:1fr 220px;gap:28px;margin-top:12px">
          <div style="padding-top:4px;font:400 9.5px/1.55 ${sans};color:${ink}cc">
            <div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:8px">Terms</div>
            <ol>
              <li>Freight + tax to be billed via 810 invoice (AP bill); not included on this PO.</li>
              <li>Vendor to confirm receipt and acknowledge via X12 855 EDI or email reply within 1 business day.</li>
              <li>Substitutions require Roma written approval before fulfillment.</li>
              <li>Reference PO number on all packing slips, invoices, and shipping documents.</li>
            </ol>
            ${p.notes ? `<div style="font:500 9px/1 ${mono};letter-spacing:0.2em;text-transform:uppercase;color:${muted};margin-bottom:6px;margin-top:14px">Notes to vendor</div><div style="font-style:italic">${p.notes}</div>` : ''}
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Lines</span><span style="color:${ink}">${items.rows.length}</span></div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Subtotal</span><span style="color:${ink}">$${subtotal.toFixed(2)}</span></div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Freight</span><span style="color:${muted};font-style:italic">By vendor invoice</span></div>
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;font:400 10px/1.3 ${sans}"><span style="color:${ink}99">Tax</span><span style="color:${muted};font-style:italic">By vendor invoice</span></div>
            <div style="margin-top:8px;padding-top:8px;border-top:1.5px solid ${ink};display:flex;justify-content:space-between;align-items:baseline">
              <span style="font:500 10px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase;color:${ink}">PO total &middot; USD</span>
              <span style="font:300 26px/1 ${serif};letter-spacing:-0.012em;color:${ink}">$${subtotal.toFixed(2)}</span>
            </div>
            <div style="margin-top:4px;font:500 9px/1 ${mono};letter-spacing:0.14em;color:${muted};text-transform:uppercase;text-align:right">Materials only &middot; Freight + tax billed on 810</div>
          </div>
        </div>

        <!-- SIGNATURES -->
        <div style="margin-top:22px;display:grid;grid-template-columns:1fr 1fr;gap:36px">
          <div>
            <div style="border-bottom:1px solid ${ink}66;padding-bottom:4px;font:400 12px/1 ${serif};color:${ink};font-style:italic">${p.approved_by_name || '\u2014'}</div>
            <div style="font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase;color:${muted};margin-top:6px">Roma &middot; Approver${p.approved_at ? ` &middot; ${fmtShortDate(p.approved_at)}` : ''}</div>
          </div>
          <div>
            <div style="border-bottom:1px solid ${ink}66;padding-bottom:4px;font:400 12px/1 ${serif};color:${muted}">&mdash;</div>
            <div style="font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase;color:${muted};margin-top:6px">Vendor acknowledgment &middot; expected within 1 business day</div>
          </div>
        </div>

        <!-- FOOTER -->
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid ${ink}22;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 ${sans};color:${muted}">
          <span>Roma Flooring Designs, Inc. &middot; 1440 S. State College Blvd &middot; Anaheim, CA 92806 &middot; CSLB #874621</span>
          <span style="font:500 9px/1 ${mono};letter-spacing:0.18em;text-transform:uppercase">${p.po_number} &middot; Rev ${p.revision || 0} &middot; Page 1 / 1</span>
        </div>
      </div>
    </div>
  </body></html>`;

  return { html, po: p, items: items.rows };
}

// Shared quote document — used by the rep, trade, and customer PDF endpooints.
// Implements the "Quote PDF.html" design from the Roma Claude Design project:
// editorial letterhead, greeting band with validity stamp, three info cards,
// swatch-led line items, terms + totals columns, and signature lines.
// Design fictions adapted to real data: real license number, real status,
// promo discount (not the mocked trade line), no invented return policy.
// `q` is the quote row, optionally enriched with rep_name / rep_email /
// company_name (trade). Items may carry primary_image for the swatches.
export function generateQuoteHtml(q, items) {
  const money = (n) => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(q.created_at);
  const validUntil = longDate(q.expires_at);
  const isExpired = q.expires_at && new Date(q.expires_at) < new Date();
  const isPickup = q.delivery_method === 'pickup';
  const quoteNumber = q.quote_number || 'Q-' + String(q.id).substring(0, 8).toUpperCase();

  const statusLabel = isExpired ? 'Expired'
    : q.status === 'converted' ? 'Converted · Order'
    : q.status === 'accepted' ? 'Accepted'
    : q.status === 'sent' ? 'Open · Sent'
    : 'Draft';

  const validityDays = q.expires_at
    ? Math.max(1, Math.round((new Date(q.expires_at) - new Date(q.created_at)) / 86400000))
    : 10;
  const stampText = isExpired ? 'Expired' : `Valid ${validityDays} days`;

  const customerFirst = (q.customer_name || '').trim().split(/\s+/)[0] || 'Hello';
  const repFirst = (q.rep_name || '').trim().split(/\s+/)[0];
  const greeting = `${customerFirst} — here's the quote ${repFirst ? repFirst + ' prepared' : 'we prepared'} for you on ${issued}. ` +
    (isExpired
      ? `This pricing expired on <span style="color:var(--ink);font-weight:500;">${validUntil}</span> — call the showroom and we'll refresh it.`
      : validUntil
        ? `Pricing is locked in through <span style="color:var(--ink);font-weight:500;">${validUntil}</span>.`
        : 'Pricing is locked in for 10 days from the date of issue.');

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const rowsHtml = items.map((i, idx) => {
    const isUnit = i.sell_by === 'unit';
    const qty = i.num_boxes || i.quantity || 1;
    const name = i.product_name || i.collection || '—';
    const suffix = [...new Set([i.color, i.variant_name].filter(Boolean))].filter(v => v !== name).join(' · ');
    const skuLine = [...new Set([
      i.vendor_sku ? 'SKU ' + i.vendor_sku : null,
      i.collection && i.collection !== name ? i.collection : null,
      i.vendor_name
    ].filter(Boolean))].join(' · ');
    const sqft = parseFloat(i.sqft_needed || 0);
    const perBox = !isUnit && sqft > 0 && qty > 0 ? sqft / qty : null;
    const isFree = i.is_sample && parseFloat(i.subtotal || 0) === 0;
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    // Swatch images go through the local resize proxy (small, disk-cached) so
    // Puppeteer isn't left waiting on full-size vendor CDN downloads.
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
        ${i.is_sample ? `<div style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.12em;color:var(--muted);margin-top:4px;text-transform:uppercase;">Sample</div>` : ''}
      </div>
      <div class="num">${isUnit || !sqft ? '—' : sqft.toFixed(1) + ' sf'}${perBox ? `<div class="numsub">${perBox.toFixed(1)} sf / box</div>` : ''}</div>
      <div class="num">${qty}<div class="numsub">${isUnit ? (qty === 1 ? 'unit' : 'units') : (qty === 1 ? 'box' : 'boxes')}</div></div>
      <div class="num">${isFree ? 'Free' : money(i.unit_price) + (isUnit ? '/ea' : '/sf')}</div>
      <div class="line-total">${isFree ? 'Free' : money(i.subtotal)}</div>
    </div>`;
  }).join('');

  const shipAddress = [
    q.shipping_address_line1,
    q.shipping_address_line2,
    q.shipping_city ? `${q.shipping_city}, ${q.shipping_state || ''} ${q.shipping_zip || ''}` : null
  ].filter(Boolean).join('<br />');

  const deliveryCard = isPickup
    ? `<div>
        <div class="mono" style="margin-bottom:8px;">Delivery</div>
        <div style="font:500 11px/1.2 var(--sans);">Showroom pickup</div>
        <div class="small" style="margin-top:4px;">1440 S. State College Blvd Suite 6M<br />Anaheim, CA 92806<br />We'll call when your order is ready.</div>
        <div style="margin-top:8px;padding:6px 10px;background:var(--warm);font:500 9px/1.4 ui-monospace,monospace;letter-spacing:0.14em;text-transform:uppercase;display:inline-block;">● Anaheim showroom</div>
      </div>`
    : `<div>
        <div class="mono" style="margin-bottom:8px;">Delivery</div>
        <div style="font:500 11px/1.2 var(--sans);">Local delivery</div>
        <div class="small" style="margin-top:4px;">${shipAddress || 'Address to be confirmed'}<br />Scheduled after order confirmation</div>
      </div>`;

  const accountCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Roma account</div>
      <div style="font:500 11px/1.2 var(--sans);">${q.customer_name || ''}${q.company_name ? ' · Trade Pro' : ''}</div>
      <div class="small" style="margin-top:4px;">${q.company_name ? q.company_name + '<br />' : ''}${q.rep_name ? `<span style="color:var(--muted);">Your rep</span><br />${q.rep_name}${q.rep_email ? '<br />' + q.rep_email : ''}<br />(714) 999-0009` : '(714) 999-0009'}</div>
    </div>`;

  const totalsRows = [
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Subtotal · materials</span><span>${money(q.subtotal)}</span></div>`,
    parseFloat(q.discount_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Discount${q.promo_code ? ' · ' + q.promo_code : ''}</span><span style="color:var(--accent);">−${money(q.discount_amount)}</span></div>` : '',
    parseFloat(q.shipping || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Shipping</span><span>${money(q.shipping)}</span></div>` : '',
    parseFloat(q.tax || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sales tax</span><span>${money(q.tax)}</span></div>` : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 86px 70px 80px 84px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="font:300 36px/1 var(--serif);letter-spacing:-0.014em;">Roma</div>
<div class="mono" style="font-size:8px;letter-spacing:0.22em;margin-top:4px;">Flooring · Surfaces · Anaheim</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Quote</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${quoteNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
<span style="color:var(--muted);">Valid until</span><span style="text-align:right;">${validUntil || '10 days from issue'}</span>
${q.rep_name ? `<span style="color:var(--muted);">Prepared by</span><span style="text-align:right;">${q.rep_name}</span>` : ''}
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${isExpired ? 'var(--muted)' : 'var(--accent)'};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:8px;border-bottom:1px solid #1c191711;align-items:center;">
<div style="font:500 9px/1.4 var(--sans);letter-spacing:0.06em;color:#1c1917cc;">
${greeting}
</div>
<div style="padding:8px 14px;border:1.5px solid ${isExpired ? 'var(--muted)' : 'var(--accent)'};color:${isExpired ? 'var(--muted)' : 'var(--accent)'};font:500 11px/1 ui-monospace,monospace;letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg);">${stampText}</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Prepared for</div>
<div style="font:500 11px/1.2 var(--sans);">${q.customer_name || ''}</div>
<div class="small" style="margin-top:4px;">${[q.customer_email, q.phone].filter(Boolean).join('<br />')}</div>
</div>
${deliveryCard}
${accountCard}
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Description</span><span style="text-align:right;">Coverage</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Unit</span><span style="text-align:right;">Line total</span>
</div>
${rowsHtml}
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
${q.notes ? `<div class="mono" style="margin-bottom:8px;">Notes</div><div style="margin-bottom:14px;white-space:pre-wrap;">${q.notes}</div>` : ''}
<div class="mono" style="margin-bottom:8px;">How to confirm</div>
<div style="margin-bottom:10px;">
<span style="color:var(--muted);">Online</span>&nbsp;&nbsp;<span style="color:var(--ink);">romaflooringdesigns.com/account — your quotes live under Account · Quotes</span><br />
<span style="color:var(--muted);">Showroom</span>&nbsp;&nbsp;<span style="color:var(--ink);">(714) 999-0009 · 1440 S. State College Blvd #6M, Anaheim</span><br />
<span style="color:var(--muted);">Email</span>&nbsp;&nbsp;<span style="color:var(--ink);">Reply to your quote email${q.rep_email ? ' or write ' + q.rep_email : ''}</span>
</div>
<div class="mono" style="margin-bottom:8px;margin-top:14px;">Terms &amp; validity</div>
<div>${validUntil ? `Pricing valid through ${validUntil}` : 'Pricing valid for 10 days from the date of issue'}; prices are subject to change after expiry. Natural stone and wood vary by lot — final selections are approved at the showroom or from delivered samples. Subject to California sales tax. Roma Flooring Designs · License #830966.</div>
</div>
<div>
${totalsRows}
<div style="margin-top:8px;padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">Quote total · USD</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${money(q.total)}</span>
</div>
${validUntil ? `<div class="mono" style="color:${isExpired ? 'var(--muted)' : 'var(--accent)'};text-align:right;margin-top:6px;letter-spacing:0.16em;">● ${isExpired ? 'Expired' : 'Valid until'} ${validUntil}</div>` : ''}
</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:26px;">
<div><div style="border-bottom:0.5px solid var(--ink);height:26px;"></div><div class="mono" style="margin-top:5px;letter-spacing:0.16em;">Customer acceptance · date</div></div>
<div><div style="border-bottom:0.5px solid var(--ink);height:26px;"></div><div class="mono" style="margin-top:5px;letter-spacing:0.16em;">Roma Flooring Designs · date</div></div>
</div>

<div style="margin-top:18px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Quote ${quoteNumber}</span>
</div>

</body>
</html>`;
}

// Shared order invoice document — same editorial system as generateQuoteHtml
// (letterhead, greeting band with status stamp, three info cards, swatch-led
// line items, terms + totals columns), adapted for an invoice: Bill To / Ship
// To, an Amount Paid line, and an emphasized Balance Due. `o` is the order row;
// items may carry primary_image (swatch), vendor_sku / vendor_name / collection.
export function generateOrderInvoiceDoc(o, items) {
  const money = (n) => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const longDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : null;
  const issued = longDate(o.created_at);
  const isPickup = o.delivery_method === 'pickup';
  const orderNumber = o.order_number || 'RD-' + String(o.id).substring(0, 8).toUpperCase();

  const total = parseFloat(o.total || 0);
  const amountPaid = parseFloat(o.amount_paid || 0);
  const balanceDue = parseFloat((total - amountPaid).toFixed(2));
  const hasBalance = balanceDue > 0.01;

  const statusLabel = hasBalance ? 'Balance Due' : 'Paid';
  const stampText = hasBalance ? 'Balance Due' : 'Paid in full';
  const stampColor = hasBalance ? 'var(--accent)' : '#3f7a4f';

  const customerFirst = (o.customer_name || '').trim().split(/\s+/)[0] || 'Hello';
  const greeting = hasBalance
    ? `${customerFirst} — here's your invoice for order ${orderNumber}, issued ${issued}. A balance of <span style="color:var(--ink);font-weight:500;">${money(balanceDue)}</span> remains — payment details are below.`
    : `${customerFirst} — here's your invoice for order ${orderNumber}, issued ${issued}. This order is <span style="color:var(--ink);font-weight:500;">paid in full</span>. Thank you.`;

  const SWATCH_FALLBACKS = [
    'linear-gradient(135deg,#caa97f,#7a5635)',
    'linear-gradient(135deg,#ebe7df,#a8a59e)',
    'linear-gradient(135deg,#e7e3db,#b0aca4)',
    'linear-gradient(135deg,#a89074,#5e4a36)',
  ];

  const rowsHtml = items.map((i, idx) => {
    const isUnit = i.sell_by === 'unit';
    const qty = i.num_boxes || i.quantity || 1;
    const name = i.product_name || i.collection || '—';
    const suffix = [...new Set([i.color, i.variant_name].filter(Boolean))].filter(v => v !== name).join(' · ');
    const skuLine = [...new Set([
      i.vendor_sku ? 'SKU ' + i.vendor_sku : null,
      i.collection && i.collection !== name ? i.collection : null,
      i.vendor_name
    ].filter(Boolean))].join(' · ');
    const sqft = parseFloat(i.sqft_needed || 0);
    const perBox = !isUnit && sqft > 0 && qty > 0 ? sqft / qty : null;
    const isFree = i.is_sample && parseFloat(i.subtotal || 0) === 0;
    const gradient = SWATCH_FALLBACKS[idx % SWATCH_FALLBACKS.length];
    const swatchSrc = i.primary_image
      ? `http://localhost:${process.env.PORT || 3001}/api/img?url=${encodeURIComponent(i.primary_image)}&w=64&f=jpeg`
      : null;
    const swatch = swatchSrc
      ? `<div class="swatch" style="background:${gradient};overflow:hidden;"><img src="${swatchSrc}" style="width:100%;height:100%;object-fit:cover;display:block;" /></div>`
      : `<div class="swatch" style="background:${gradient};"></div>`;
    return `<div class="grid-row keep" style="padding:12px 0;${idx < items.length - 1 ? 'border-bottom:1px solid #1c191711;' : ''}">
      ${swatch}
      <div>
        <div style="font:500 11px/1.2 var(--sans);letter-spacing:-0.004em;">${name}${suffix ? ` <span style="color:var(--muted);font-weight:400;">· ${suffix}</span>` : ''}</div>
        ${skuLine ? `<div style="font:400 9px/1.5 var(--sans);color:#1c191799;margin-top:3px;">${skuLine}</div>` : ''}
        ${i.is_sample ? `<div style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.12em;color:var(--muted);margin-top:4px;text-transform:uppercase;">Sample</div>` : ''}
      </div>
      <div class="num">${isUnit || !sqft ? '—' : sqft.toFixed(1) + ' sf'}${perBox ? `<div class="numsub">${perBox.toFixed(1)} sf / box</div>` : ''}</div>
      <div class="num">${qty}<div class="numsub">${isUnit ? (qty === 1 ? 'unit' : 'units') : (qty === 1 ? 'box' : 'boxes')}</div></div>
      <div class="num">${isFree ? 'Free' : money(i.unit_price) + (isUnit ? '/ea' : '/sf')}</div>
      <div class="line-total">${isFree ? 'Free' : money(i.subtotal)}</div>
    </div>`;
  }).join('');

  const shipAddress = [
    o.shipping_address_line1,
    o.shipping_address_line2,
    o.shipping_city ? `${o.shipping_city}, ${o.shipping_state || ''} ${o.shipping_zip || ''}` : null
  ].filter(Boolean).join('<br />');

  const deliveryCard = isPickup
    ? `<div>
        <div class="mono" style="margin-bottom:8px;">Ship to</div>
        <div style="font:500 11px/1.2 var(--sans);">Showroom pickup</div>
        <div class="small" style="margin-top:4px;">1440 S. State College Blvd Suite 6M<br />Anaheim, CA 92806</div>
        <div style="margin-top:8px;padding:6px 10px;background:var(--warm);font:500 9px/1.4 ui-monospace,monospace;letter-spacing:0.14em;text-transform:uppercase;display:inline-block;">● Anaheim showroom</div>
      </div>`
    : `<div>
        <div class="mono" style="margin-bottom:8px;">Ship to</div>
        <div style="font:500 11px/1.2 var(--sans);">${o.customer_name || 'Local delivery'}</div>
        <div class="small" style="margin-top:4px;">${shipAddress || 'Address to be confirmed'}</div>
      </div>`;

  const accountCard = `<div>
      <div class="mono" style="margin-bottom:8px;">Roma account</div>
      <div style="font:500 11px/1.2 var(--sans);">${o.customer_name || ''}${o.company_name ? ' · Trade Pro' : ''}</div>
      <div class="small" style="margin-top:4px;">${o.company_name ? o.company_name + '<br />' : ''}${o.rep_name ? `<span style="color:var(--muted);">Your rep</span><br />${o.rep_name}${o.rep_email ? '<br />' + o.rep_email : ''}<br />(714) 999-0009` : '(714) 999-0009'}</div>
    </div>`;

  const totalsRows = [
    `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Subtotal · materials</span><span>${money(o.subtotal)}</span></div>`,
    parseFloat(o.discount_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Discount${o.promo_code ? ' · ' + o.promo_code : ''}</span><span style="color:var(--accent);">−${money(o.discount_amount)}</span></div>` : '',
    parseFloat(o.shipping || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Shipping${o.shipping_method ? ' · ' + (o.shipping_method === 'ltl_freight' ? 'LTL Freight' : 'Parcel') : ''}</span><span>${money(o.shipping)}</span></div>` : '',
    parseFloat(o.sample_shipping || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sample shipping</span><span>${money(o.sample_shipping)}</span></div>` : '',
    parseFloat(o.tax_amount || 0) > 0
      ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font:400 10px/1.4 var(--sans);border-bottom:1px solid #1c191711;"><span style="color:var(--muted);">Sales tax</span><span>${money(o.tax_amount)}</span></div>` : '',
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&display=swap');
:root{--serif:'Cormorant Garamond','Times New Roman',serif;--sans:'Inter',system-ui,sans-serif;--ink:#1c1917;--accent:#a87935;--muted:#8a7e68;--warm:#d8cdb6}
*{box-sizing:border-box}
body{font-family:var(--sans);color:var(--ink);margin:0;background:#fff}
@media screen{body{padding:48px 56px;max-width:816px;margin:0 auto}}
.mono{font:500 9px/1 ui-monospace,monospace;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted)}
.small{font:400 10px/1.5 var(--sans);color:#1c1917cc}
.grid-row{display:grid;grid-template-columns:32px 1fr 86px 70px 80px 84px;gap:12px;align-items:flex-start}
.swatch{width:32px;height:32px;border:0.5px solid #1c191733}
.num{text-align:right;font:400 11px/1.2 var(--sans)}
.numsub{font:400 9px/1.4 var(--sans);color:var(--muted);margin-top:2px}
.line-total{text-align:right;font:500 12px/1.2 var(--serif)}
.keep{break-inside:avoid;orphans:3;widows:3}
</style>
</head>
<body>

<div style="display:grid;grid-template-columns:1fr auto;gap:36px;padding-bottom:20px;border-bottom:1px solid #1c191722;">
<div>
<div style="font:300 36px/1 var(--serif);letter-spacing:-0.014em;">Roma</div>
<div class="mono" style="font-size:8px;letter-spacing:0.22em;margin-top:4px;">Flooring · Surfaces · Anaheim</div>
<div class="small" style="margin-top:14px;">Roma Flooring Designs, Inc.<br />1440 S. State College Blvd #6M, Anaheim, CA 92806<br />(714) 999-0009 · Sales@romaflooringdesigns.com<br />License #830966</div>
</div>
<div style="text-align:right;min-width:220px;">
<div class="mono" style="letter-spacing:0.22em;">Invoice</div>
<div style="font:300 32px/1 var(--serif);letter-spacing:-0.014em;margin-top:6px;">${orderNumber}</div>
<div style="margin-top:14px;display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font:400 10px/1.4 var(--sans);text-align:left;">
<span style="color:var(--muted);">Issued</span><span style="text-align:right;">${issued}</span>
${o.po_number ? `<span style="color:var(--muted);">PO ref</span><span style="text-align:right;">${o.po_number}</span>` : ''}
<span style="color:var(--muted);">Status</span><span class="mono" style="color:${stampColor};text-align:right;letter-spacing:0.18em;">● ${statusLabel}</span>
</div>
</div>
</div>

<div style="display:grid;grid-template-columns:1fr auto;gap:24px;padding:14px 0;margin-bottom:8px;border-bottom:1px solid #1c191711;align-items:center;">
<div style="font:500 9px/1.4 var(--sans);letter-spacing:0.06em;color:#1c1917cc;">
${greeting}
</div>
<div style="padding:8px 14px;border:1.5px solid ${stampColor};color:${stampColor};font:500 11px/1 ui-monospace,monospace;letter-spacing:0.32em;text-transform:uppercase;transform:rotate(-2deg);white-space:nowrap;">${stampText}</div>
</div>

<div class="keep" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px;padding:14px 0 22px;border-bottom:1px solid #1c191722;">
<div>
<div class="mono" style="margin-bottom:8px;">Bill to</div>
<div style="font:500 11px/1.2 var(--sans);">${o.customer_name || ''}</div>
<div class="small" style="margin-top:4px;">${[o.customer_email, o.phone].filter(Boolean).join('<br />')}</div>
</div>
${deliveryCard}
${accountCard}
</div>

<div style="padding-top:18px;">
<div class="grid-row" style="padding-bottom:10px;border-bottom:1px solid #1c191733;font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);">
<span></span><span>Description</span><span style="text-align:right;">Coverage</span><span style="text-align:right;">Qty</span><span style="text-align:right;">Unit</span><span style="text-align:right;">Line total</span>
</div>
${rowsHtml}
</div>

<div class="keep" style="display:grid;grid-template-columns:1fr 240px;gap:32px;margin-top:14px;border-top:1px solid #1c191733;padding-top:14px;">
<div style="padding-top:4px;" class="small">
${o.notes ? `<div class="mono" style="margin-bottom:8px;">Notes</div><div style="margin-bottom:14px;white-space:pre-wrap;">${o.notes}</div>` : ''}
<div class="mono" style="margin-bottom:8px;">How to pay</div>
<div style="margin-bottom:10px;">
<span style="color:var(--muted);">Online</span>&nbsp;&nbsp;<span style="color:var(--ink);">romaflooringdesigns.com/account — pay under Account · Orders</span><br />
<span style="color:var(--muted);">Showroom</span>&nbsp;&nbsp;<span style="color:var(--ink);">(714) 999-0009 · 1440 S. State College Blvd #6M, Anaheim</span><br />
<span style="color:var(--muted);">Email</span>&nbsp;&nbsp;<span style="color:var(--ink);">Reply to your invoice email${o.rep_email ? ' or write ' + o.rep_email : ''}</span>
</div>
<div class="mono" style="margin-bottom:8px;margin-top:14px;">Terms</div>
<div>Payment is due on receipt unless otherwise agreed. Natural stone and wood vary by lot — final selections are approved at the showroom or from delivered samples. Subject to California sales tax. Roma Flooring Designs · License #830966.</div>
</div>
<div>
${totalsRows}
<div style="margin-top:8px;padding-top:8px;border-top:1.5px solid var(--ink);display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:var(--ink);letter-spacing:0.18em;">Total · USD</span>
<span style="font:300 28px/1 var(--serif);letter-spacing:-0.012em;">${money(total)}</span>
</div>
<div style="display:flex;justify-content:space-between;padding:8px 0 0;font:400 10px/1.4 var(--sans);"><span style="color:var(--muted);">Amount paid</span><span>${amountPaid > 0 ? '−' + money(amountPaid) : money(0)}</span></div>
<div style="margin-top:6px;padding-top:8px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:baseline;">
<span class="mono" style="color:${stampColor};letter-spacing:0.18em;">Balance due</span>
<span style="font:400 22px/1 var(--serif);letter-spacing:-0.012em;color:var(--ink);">${money(hasBalance ? balanceDue : 0)}</span>
</div>
</div>
</div>

<div style="margin-top:26px;padding-top:12px;border-top:1px solid #1c191722;display:flex;justify-content:space-between;align-items:center;font:400 9px/1.4 var(--sans);color:var(--muted);">
<span>Roma Flooring Designs, Inc. · 1440 S. State College Blvd #6M · Anaheim, CA 92806 · License #830966</span>
<span style="font:500 9px/1 ui-monospace,monospace;letter-spacing:0.18em;text-transform:uppercase;">Invoice ${orderNumber}</span>
</div>

</body>
</html>`;
}

// Showroom sample labels — Avery 5163 sheet layout (2"×4" labels, 2 columns × 5 rows,
// 10 per US Letter page). Each label states the product/collection name, this tile's
// color/variant, a compact "also available" summary (colors/sizes + accessories), and a
// QR code linking to the SKU's storefront detail page. `labels` is an array of
// { productName, collection, variantLabel, vendorName, colorsCount, sizesCount,
//   accessories[], internalSku, qrDataUri }. The QR is passed in as a data URI (built
// server-side) so Puppeteer renders it offline without a network round-trip.
// Print at 100% (no scaling) onto Avery 5163 stock; call generatePDF with zero margins.
export function generateLabelSheetHtml(labels) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const renderLabel = (l) => {
    const rawName = String(l.productName || l.collection || '—');
    const vendor = String(l.vendorName || '');
    // Drop a redundant leading vendor name from the title (e.g. "Daltile Choice
    // Calm Beige" → "Choice Calm Beige") since the vendor shows as the eyebrow.
    let title = rawName;
    if (vendor && title.toLowerCase().startsWith(vendor.toLowerCase() + ' ')) {
      title = title.slice(vendor.length).trim();
    }
    const variant = esc(l.variantLabel || '');
    const acc = (l.accessories || []).filter(Boolean);
    const colors = (l.colors || []).filter(Boolean);
    const sizes = (l.sizes || []).filter(Boolean);
    const sku = esc(l.internalSku || '');

    // "Available" lists the options that actually vary (colors and/or sizes),
    // followed by the accessories that pair with the line.
    const variantParts = [];
    if (colors.length > 1) variantParts.push(...colors);
    if (sizes.length > 1) variantParts.push(...sizes);
    const variantList = variantParts.join(' · ');

    const availBody = [];
    if (variantList) availBody.push(`<div class="l-availv">${esc(variantList)}</div>`);
    if (acc.length) availBody.push(`<div class="l-availv l-availacc">+ ${esc(acc.join(', '))}</div>`);

    return `
      <div class="label">
        <div class="l-body">
          ${vendor ? `<div class="l-eyebrow">${esc(vendor)}</div>` : ''}
          <div class="l-title">${esc(title)}</div>
          ${variant ? `<div class="l-variant">${variant}</div>` : ''}
          ${availBody.length ? `<div class="l-rule"></div><div class="l-availk">Available</div>${availBody.join('')}` : ''}
        </div>
        <div class="l-qr">
          <div class="l-qrbox"><img src="${l.qrDataUri}" alt="Scan for product details" /></div>
          ${sku ? `<div class="l-sku">${sku}</div>` : ''}
          <div class="l-scan">Scan · details &amp; pricing</div>
        </div>
        <div class="l-foot">
          <span class="l-brand">Roma Flooring Designs</span>
          <span class="l-web">romaflooringdesigns.com</span>
        </div>
      </div>`;
  };

  const pages = [];
  for (let i = 0; i < labels.length; i += 10) pages.push(labels.slice(i, i + 10));
  const pagesHtml = pages.map((pg, idx) => `
    <div class="sheet${idx < pages.length - 1 ? ' brk' : ''}">
      <div class="grid">${pg.map(renderLabel).join('')}</div>
    </div>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, Arial, sans-serif; color: #1c1917; -webkit-font-smoothing: antialiased; }
  .sheet { width: 8.5in; height: 11in; padding: 0.5in 0.15625in; }
  .sheet.brk { page-break-after: always; }
  .grid { display: grid; grid-template-columns: 4in 4in; column-gap: 0.1875in; row-gap: 0; }
  .label { position: relative; width: 4in; height: 2in; padding: 0.17in 0.18in 0.30in; display: flex; gap: 0.16in; overflow: hidden; }
  .l-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .l-eyebrow { font-size: 6.5pt; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: #a87935; }
  .l-title { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 600; font-size: 18.5pt; line-height: 1.0; letter-spacing: 0.004em; color: #1c1917; margin-top: 2px; max-height: 0.55in; overflow: hidden; }
  .l-variant { font-size: 9.5pt; font-weight: 500; color: #57534e; margin-top: 4px; }
  .l-rule { width: 64%; height: 1px; background: linear-gradient(90deg, #a87935, rgba(200,169,126,0.25) 70%, transparent); margin: 7px 0 5px; }
  .l-availk { font-size: 6.3pt; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; color: #a87935; margin-bottom: 2px; }
  .l-availv { font-size: 7pt; line-height: 1.32; color: #57534e; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .l-availacc { color: #8a817a; margin-top: 1px; }
  .l-qr { width: 0.98in; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; text-align: center; }
  .l-qrbox { padding: 3.5px; border: 0.75px solid #ddd6c9; background: #fff; }
  .l-qr img { width: 0.78in; height: 0.78in; display: block; }
  .l-sku { font-family: ui-monospace, 'SF Mono', monospace; font-size: 6pt; font-weight: 600; letter-spacing: 0.02em; color: #44403c; margin-top: 4px; word-break: break-all; }
  .l-scan { font-size: 5.3pt; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase; color: #a87935; margin-top: 3px; }
  .l-foot { position: absolute; left: 0.18in; right: 0.18in; bottom: 0.11in; display: flex; justify-content: space-between; align-items: baseline; border-top: 0.5px solid #ece7dd; padding-top: 3px; }
  .l-brand { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 8pt; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; color: #a87935; }
  .l-web { font-size: 5.6pt; font-weight: 500; letter-spacing: 0.07em; text-transform: uppercase; color: #b3a89a; }
  </style></head><body>${pagesHtml}</body></html>`;
}
