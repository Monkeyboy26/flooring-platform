import { LOGO_URL } from './_config.js';

export function generateEstimateSentHTML(data) {
  const {
    estimate_number, customer_name, project_name,
    materials_subtotal, labor_subtotal, subtotal,
    tax_amount, total,
    rep_first_name, rep_last_name, rep_email,
    materialItems = [], laborItems = []
  } = data;

  const repName = [rep_first_name, rep_last_name].filter(Boolean).join(' ') || 'Your Sales Representative';

  const materialRows = materialItems.map(item => {
    const name = esc(item.product_name || 'Product');
    const collection = item.collection ? esc(item.collection) : '';
    const qty = `${item.num_boxes || item.quantity || 1}`;
    const price = `$${parseFloat(item.subtotal || 0).toFixed(2)}`;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#292524;">
        ${name}${collection ? `<br><span style="color:#78716c;font-size:12px;">${collection}</span>` : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;text-align:center;">${qty}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#292524;text-align:right;">${price}</td>
    </tr>`;
  }).join('');

  const laborCategoryLabels = {
    installation: 'Installation', tearout: 'Tearout', underlayment: 'Underlayment',
    transitions: 'Transitions', baseboards: 'Baseboards', floor_leveling: 'Floor Leveling',
    moisture_barrier: 'Moisture Barrier', furniture_moving: 'Furniture Moving', other: 'Other'
  };

  const laborRows = laborItems.map(item => {
    const cat = laborCategoryLabels[item.labor_category] || esc(item.labor_category || 'Service');
    const desc = item.description ? '<br><span style="color:#78716c;font-size:12px;">' + item.description.split('\n').map((line, i) => i === 0 ? esc(line) : '&bull; ' + esc(line)).join('<br>') + '</span>' : '';
    const rateInfo = item.rate_type === 'per_sqft'
      ? `$${parseFloat(item.rate_sqft || 0).toFixed(2)}/sqft × ${parseFloat(item.labor_sqft || 0).toFixed(0)} sqft`
      : (parseFloat(item.quantity || 1) > 1 ? `$${parseFloat(item.unit_price || 0).toFixed(2)} × ${parseFloat(item.quantity).toFixed(0)}` : 'Flat rate');
    const price = `$${parseFloat(item.subtotal || 0).toFixed(2)}`;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#292524;">
        ${cat}${desc}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;text-align:center;">${rateInfo}</td>
      <td style="padding:10px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#292524;text-align:right;">${price}</td>
    </tr>`;
  }).join('');

  const projectLine = project_name ? ` for <strong>${esc(project_name)}</strong>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=Inter:wght@400;500&display=swap');</style>
</head>
<body style="margin:0;padding:0;background-color:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf9;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #e7e5e4;">

  <!-- Header -->
  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <img src="${LOGO_URL}" alt="Roma Flooring Designs" width="140" height="140" style="display:block;margin:0 auto;width:140px;height:140px;" />
  </td></tr>

  <!-- Title -->
  <tr><td style="padding:40px 40px 20px;">
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;color:#292524;">Your Construction Estimate</h1>
    <p style="margin:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;line-height:1.6;">
      Hi ${esc(customer_name)},<br><br>
      ${esc(repName)} has prepared a construction estimate${projectLine} for your review. This includes both materials and labor costs.
    </p>
  </td></tr>

  <!-- Estimate Number -->
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;">
          <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Estimate Number</p>
          <p style="margin:4px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${esc(estimate_number)}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  ${materialRows ? `
  <!-- Materials -->
  <tr><td style="padding:0 40px 8px;">
    <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Materials</p>
  </td></tr>
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;">Product</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:center;">Qty</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:right;">Amount</td>
      </tr>
      ${materialRows}
    </table>
  </td></tr>
  ` : ''}

  ${laborRows ? `
  <!-- Labor & Services -->
  <tr><td style="padding:0 40px 8px;">
    <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Labor &amp; Services</p>
  </td></tr>
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;">Service</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:center;">Rate</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:right;">Amount</td>
      </tr>
      ${laborRows}
    </table>
  </td></tr>
  ` : ''}

  <!-- Totals -->
  <tr><td style="padding:0 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Materials</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">$${parseFloat(materials_subtotal || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Labor &amp; Services</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">$${parseFloat(labor_subtotal || 0).toFixed(2)}</td>
      </tr>
      ${parseFloat(tax_amount || 0) > 0 ? `<tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Tax (materials only)</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">$${parseFloat(tax_amount).toFixed(2)}</td>
      </tr>` : ''}
      <tr>
        <td style="padding:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;">Grand Total</td>
        <td style="padding:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;text-align:right;">$${parseFloat(total || 0).toFixed(2)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Rep Contact -->
  <tr><td style="padding:0 40px 32px;">
    <div style="padding:20px;background:#fafaf9;border:1px solid #e7e5e4;">
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Your Sales Representative</p>
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${esc(repName)}</p>
      <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;">
        <a href="mailto:${esc(rep_email)}" style="color:#c9a668;">${esc(rep_email)}</a>
      </p>
    </div>
  </td></tr>

  <!-- CTA -->
  <tr><td style="padding:0 40px 40px;text-align:center;">
    <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;line-height:1.6;">
      To proceed with this estimate or discuss any changes, simply reply to this email. We look forward to working with you.
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 40px;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;letter-spacing:2px;color:#a8a29e;">ROMA FLOORING DESIGNS</p>
    <p style="margin:8px 0 0;font-family:Inter,Arial,sans-serif;font-size:11px;color:#a8a29e;">Curated flooring &amp; surfaces for refined spaces</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
