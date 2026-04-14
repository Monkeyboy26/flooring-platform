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

export async function generatePDF(html, filename, req, res) {
  // Preview mode: return HTML directly for iframe rendering
  if (req.query.preview === 'true') {
    res.set('Content-Type', 'text/html');
    return res.send(html);
  }
  try {
    const puppeteer = await import('puppeteer');
    const browser = await puppeteer.default.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdf = await page.pdf({ format: 'Letter', margin: { top: '0.6in', bottom: '0.6in', left: '0.65in', right: '0.65in' } });
    await browser.close();
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` });
    res.send(pdf);
  } catch (pdfErr) {
    // Fallback: return HTML if Puppeteer unavailable
    res.set('Content-Type', 'text/html');
    res.send(html);
  }
}

export async function generatePDFBuffer(html) {
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  const pdf = await page.pdf({ format: 'Letter', margin: { top: '0.6in', bottom: '0.6in', left: '0.65in', right: '0.65in' } });
  await browser.close();
  return Buffer.from(pdf);
}

export async function generatePOHtml(pool, poId) {
  const po = await pool.query(`
    SELECT po.*, v.name as vendor_name, v.code as vendor_code, v.email as vendor_email,
      sa.first_name || ' ' || sa.last_name as approved_by_name,
      o.order_number
    FROM purchase_orders po
    JOIN vendors v ON v.id = po.vendor_id
    LEFT JOIN staff_accounts sa ON sa.id = po.approved_by
    LEFT JOIN orders o ON o.id = po.order_id
    WHERE po.id = $1
  `, [poId]);
  if (!po.rows.length) return null;
  const p = po.rows[0];
  const items = await pool.query(`
    SELECT poi.*, pr.collection, sk.variant_name, sa_c.value as color
    FROM purchase_order_items poi
    LEFT JOIN skus sk ON sk.id = poi.sku_id
    LEFT JOIN products pr ON pr.id = sk.product_id
    LEFT JOIN sku_attributes sa_c ON sa_c.sku_id = poi.sku_id
      AND sa_c.attribute_id = (SELECT id FROM attributes WHERE slug = 'color' LIMIT 1)
    WHERE poi.purchase_order_id = $1 ORDER BY poi.created_at
  `, [poId]);

  const statusClass = p.status ? 'badge-' + p.status : 'badge-draft';

  const html = `<!DOCTYPE html><html><head><style>
    ${getDocumentBaseCSS()}
  </style></head><body>
    <div class="page">
      ${getDocumentHeader('Purchase Order')}

      <div class="doc-banner">
        <div class="doc-banner-left">
          <div class="meta-group">
            <p class="meta-label">PO Number</p>
            <p class="meta-value">${p.po_number}</p>
          </div>
          <div class="meta-group">
            <p class="meta-label">Date</p>
            <p class="meta-value-sm">${new Date(p.created_at).toLocaleDateString()}</p>
          </div>
          ${p.order_number ? `<div class="meta-group">
            <p class="meta-label">Order</p>
            <p class="meta-value-sm">${p.order_number}</p>
          </div>` : ''}
        </div>
        <div>
          <span class="badge ${statusClass}">${p.status || 'draft'}</span>
          ${p.is_revised ? ' <span class="badge badge-revised">Revised</span>' : ''}
        </div>
      </div>

      <div class="info-row">
        <div class="info-card">
          <h3>Vendor</h3>
          <p><strong>${p.vendor_name}</strong><br/>Code: ${p.vendor_code}${p.vendor_email ? '<br/>' + p.vendor_email : ''}</p>
        </div>
        <div class="info-card">
          <h3>Ship To</h3>
          <p><strong>Roma Flooring Designs</strong><br/>1440 S. State College Blvd., Suite 6M<br/>Anaheim, CA 92806</p>
        </div>
      </div>

      <table>
        <thead><tr>
          <th>Description</th><th>Vendor SKU</th>
          <th class="text-right">Qty</th>
          <th class="text-right">Cost</th><th class="text-right">Subtotal</th>
        </tr></thead>
        <tbody>
          ${items.rows.map(i => {
            const isUnit = i.sell_by === 'unit';
            return `<tr>
              <td>${itemDescriptionCell(i.collection, i.color, i.variant_name)}</td>
              <td>${i.vendor_sku || '\u2014'}</td>
              <td class="text-right">${i.qty}${isUnit ? '' : ' box' + (i.qty > 1 ? 'es' : '')}</td>
              <td class="text-right">$${parseFloat(i.cost).toFixed(2)}${isUnit ? '/ea' : '/sqft'}</td>
              <td class="text-right">$${parseFloat(i.subtotal).toFixed(2)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>

      <div class="totals-wrapper">
        <div class="totals-box">
          <div class="totals-line grand-total"><span>PO Total</span><span>$${parseFloat(p.subtotal || 0).toFixed(2)}</span></div>
        </div>
      </div>

      ${p.notes ? `<div class="notes-block"><h4>Notes</h4><div>${p.notes}</div></div>` : ''}
      ${p.approved_by_name ? `<div class="approval-line">Approved by ${p.approved_by_name} on ${new Date(p.approved_at).toLocaleDateString()}</div>` : ''}

      ${getDocumentFooter()}
    </div>
  </body></html>`;

  return { html, po: p, items: items.rows };
}
