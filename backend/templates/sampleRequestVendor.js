function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Generates HTML for a sample request sent to a vendor.
 * Used both as the email body and as the source for PDF generation.
 *
 * @param {Object} data
 * @param {string} data.vendor_name
 * @param {string} data.request_number
 * @param {string} data.customer_name
 * @param {string} data.rep_name
 * @param {string} [data.notes] - request-level notes
 * @param {Object} data.ship_to - shipping destination
 * @param {string} data.ship_to.name
 * @param {string} data.ship_to.line1
 * @param {string} [data.ship_to.line2]
 * @param {string} data.ship_to.city
 * @param {string} data.ship_to.state
 * @param {string} data.ship_to.zip
 * @param {Array} data.items - items for this vendor only
 */
export function generateSampleRequestVendorHTML(data) {
  const {
    vendor_name, request_number, customer_name, rep_name, notes, ship_to, items = []
  } = data;

  const itemRows = items.map((item, idx) => {
    const name = esc(item.product_name || 'Product');
    const collection = item.collection ? esc(item.collection) : '';
    const variant = item.variant_name ? esc(item.variant_name) : '';
    const skuCode = item.sku_code ? esc(item.sku_code) : '';
    const itemNotes = item.notes ? esc(item.notes) : '';

    return `<tr${idx % 2 === 1 ? ' style="background:#fafaf9;"' : ''}>
      <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;">
        <strong>${name}</strong>
        ${collection ? `<br/><span style="color:#78716c;">${collection}</span>` : ''}
        ${variant ? `<br/><span style="color:#78716c;">Variant: ${variant}</span>` : ''}
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;">${skuCode || '\u2014'}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;">1</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e7e5e4;font-size:13px;color:#57534e;">${itemNotes || '\u2014'}</td>
    </tr>`;
  }).join('');

  // Build ship-to address lines
  const shipToLines = [];
  if (ship_to) {
    if (ship_to.name) shipToLines.push(`<strong>${esc(ship_to.name)}</strong>`);
    if (ship_to.line1) shipToLines.push(esc(ship_to.line1));
    if (ship_to.line2) shipToLines.push(esc(ship_to.line2));
    const cityParts = [ship_to.city, ship_to.state].filter(Boolean).join(', ');
    if (cityParts && ship_to.zip) shipToLines.push(`${esc(cityParts)} ${esc(ship_to.zip)}`);
    else if (cityParts) shipToLines.push(esc(cityParts));
    else if (ship_to.zip) shipToLines.push(esc(ship_to.zip));
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600&family=Inter:wght@300;400;500;600&display=swap');
  body { font-family: 'Inter', Arial, sans-serif; margin: 0; padding: 2rem; color: #1c1917; font-size: 13px; line-height: 1.5; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 2px solid #c8a97e; }
  .company { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.75rem; font-weight: 300; margin-bottom: 0.25rem; }
  .company-info { font-size: 0.75rem; color: #57534e; line-height: 1.6; }
  .doc-title { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 1.5rem; font-weight: 400; color: #c8a97e; }
  .info-columns { display: flex; gap: 2rem; margin-bottom: 1.5rem; }
  .info-block { flex: 1; padding: 1rem; background: #fafaf9; border: 1px solid #e7e5e4; }
  .info-block h3 { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.1em; color: #78716c; margin: 0 0 0.5rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  th { background: #1c1917; color: #fff; padding: 10px 12px; text-align: left; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .notes-section { margin-top: 1.5rem; padding: 1rem; background: #fafaf9; border: 1px solid #e7e5e4; }
  .notes-section h4 { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.1em; color: #78716c; margin: 0 0 0.5rem; }
  .footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e7e5e4; font-size: 0.6875rem; color: #78716c; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="company">Roma Flooring Designs</div>
      <div class="company-info">
        1440 S. State College Blvd #6M<br/>
        Anaheim, CA 92806<br/>
        (714) 999-0009<br/>
        Sales@romaflooringdesigns.com
      </div>
    </div>
    <div>
      <div class="doc-title">Sample Request</div>
    </div>
  </div>

  <div style="margin-top: -1.5rem; margin-bottom: 1.5rem; font-size: 0.8125rem; color: #57534e; line-height: 1.8;">
    <strong>${esc(request_number)}</strong><br/>
    Date: ${new Date().toLocaleDateString()}
  </div>

  <div class="info-columns">
    <div class="info-block">
      <h3>Vendor</h3>
      <strong>${esc(vendor_name)}</strong>
    </div>
    <div class="info-block">
      <h3>Ship To</h3>
      ${shipToLines.length ? shipToLines.join('<br/>') : '<em>Not specified</em>'}
    </div>
  </div>

  <div class="info-columns">
    <div class="info-block">
      <h3>Requested By</h3>
      <strong>Roma Flooring Designs</strong><br/>
      ${rep_name ? `Rep: ${esc(rep_name)}<br/>` : ''}
      Customer: ${esc(customer_name)}
    </div>
  </div>

  <table>
    <thead><tr>
      <th>Product</th>
      <th>SKU</th>
      <th>Qty</th>
      <th>Notes</th>
    </tr></thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  ${notes ? `<div class="notes-section"><h4>Notes</h4><div style="font-size:0.8125rem;white-space:pre-wrap;">${esc(notes)}</div></div>` : ''}

  <div class="footer">
    <p>Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </div>
</body>
</html>`;
}
