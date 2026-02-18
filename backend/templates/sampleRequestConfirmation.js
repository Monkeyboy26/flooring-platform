function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateSampleRequestConfirmationHTML(data) {
  const {
    customer_name, request_number, items = [],
    shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip
  } = data;

  const itemRows = items.map(item => {
    const name = esc(item.product_name || 'Product');
    const collection = item.collection ? esc(item.collection) : '';
    const variant = item.variant_name ? esc(item.variant_name) : '';
    const image = item.primary_image || '';

    return `<tr>
      <td style="padding:16px 0;border-bottom:1px solid #e7e5e4;">
        <table cellpadding="0" cellspacing="0" width="100%"><tr>
          ${image ? `<td width="120" valign="top" style="padding-right:16px;">
            <img src="${esc(image)}" alt="${name}" width="120" height="120" style="display:block;width:120px;height:120px;object-fit:cover;border:1px solid #e7e5e4;" />
          </td>` : ''}
          <td valign="top" style="font-family:Inter,Arial,sans-serif;">
            <p style="margin:0 0 4px;font-size:16px;font-weight:500;color:#292524;">${name}</p>
            ${collection ? `<p style="margin:0 0 2px;font-size:13px;color:#78716c;">${collection}</p>` : ''}
            ${variant ? `<p style="margin:0 0 2px;font-size:13px;color:#78716c;">${variant}</p>` : ''}
            <p style="margin:8px 0 0;font-size:13px;font-weight:500;color:#15803d;">Free Sample</p>
          </td>
        </tr></table>
      </td>
    </tr>`;
  }).join('');

  const addressParts = [shipping_address_line1, shipping_address_line2].filter(Boolean);
  const cityLine = [shipping_city, shipping_state].filter(Boolean).join(', ');
  if (shipping_zip && cityLine) addressParts.push(cityLine + ' ' + shipping_zip);
  else if (cityLine) addressParts.push(cityLine);
  else if (shipping_zip) addressParts.push(shipping_zip);

  const addressBlock = addressParts.length ? `
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#78716c;font-weight:500;">Shipping To</p>
    <div style="background:#fafaf9;border:1px solid #e7e5e4;padding:16px 20px;">
      ${addressParts.map(l => `<p style="margin:0 0 2px;font-size:14px;color:#292524;">${esc(l)}</p>`).join('')}
    </div>
  </td></tr>` : '';

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
  <tr><td style="padding:32px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;letter-spacing:4px;color:#292524;font-weight:600;">ROMA FLOORING DESIGNS</p>
  </td></tr>

  <!-- Greeting -->
  <tr><td style="padding:40px 40px 16px;">
    <h1 style="margin:0 0 8px;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:400;color:#1c1917;">Your Sample Request</h1>
    <p style="margin:0;font-size:15px;color:#57534e;">Hi ${esc(customer_name)}, we've received your sample request!</p>
  </td></tr>

  <!-- Request Number -->
  <tr><td style="padding:0 40px 24px;">
    <div style="background:#f5f5f4;display:inline-block;padding:10px 24px;font-size:15px;font-weight:500;color:#1c1917;">
      ${esc(request_number)}
    </div>
  </td></tr>

  <!-- Items -->
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 16px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#78716c;font-weight:500;">Samples Requested</p>
    <table cellpadding="0" cellspacing="0" width="100%">
      ${itemRows}
    </table>
  </td></tr>

  ${addressBlock}

  <!-- Shipping Note -->
  <tr><td style="padding:0 40px 40px;">
    <div style="background:#fefce8;border:1px solid #fde68a;padding:12px 16px;">
      <p style="margin:0;font-size:13px;color:#854d0e;">Samples ship for a flat rate of $12. You will not be charged for the product itself.</p>
    </div>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 40px;background:#fafaf9;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">Questions? Contact us at (714) 999-0009</p>
    <p style="margin:0;color:#a8a29e;font-size:11px;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>

</table>
</td></tr></table>
</body>
</html>`;
}
