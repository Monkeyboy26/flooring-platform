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
      border-bottom: 2px solid #c8a97e;
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
      color: #a8a29e; font-weight: 500; margin: 0 0 1px;
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
      color: #a8a29e; font-weight: 500; margin: 0 0 0.4rem;
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
      font-weight: 600; color: #b91c1c;
    }
    .totals-line.paid-full {
      font-weight: 500; color: #16a34a;
    }
    .totals-line .discount { color: #16a34a; }

    /* ---- Section Headers ---- */
    .section-title {
      font-size: 0.6875rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: #78716c;
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
      color: #a8a29e; font-weight: 500; margin: 0 0 0.4rem;
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
      border-top: 2px solid #c8a97e;
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
      color: #c8a97e; margin: 0;
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
    .info-block h3 { font-size: 0.5625rem; text-transform: uppercase; letter-spacing: 0.12em; color: #a8a29e; font-weight: 500; margin: 0 0 0.4rem; }
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
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdf = await page.pdf({ format: 'Letter', margin });
    await browser.close();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(pdf);
  } catch (pdfErr) {
    // Fallback: return HTML if Puppeteer unavailable
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
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
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
