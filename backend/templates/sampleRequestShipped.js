function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateSampleRequestShippedHTML(data) {
  const {
    customer_name, request_number, tracking_number, items = []
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
          </td>
        </tr></table>
      </td>
    </tr>`;
  }).join('');

  const trackingBlock = tracking_number ? `
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#78716c;font-weight:500;">Tracking Number</p>
    <div style="background:#f5f5f4;display:inline-block;padding:10px 24px;font-family:'Courier New',Courier,monospace;font-size:15px;font-weight:500;color:#1c1917;letter-spacing:1px;">
      ${esc(tracking_number)}
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
    <h1 style="margin:0 0 8px;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:400;color:#1c1917;">Your Samples Are On The Way</h1>
    <p style="margin:0;font-size:15px;color:#57534e;">Hi ${esc(customer_name)}, your samples have shipped!</p>
  </td></tr>

  <!-- Request Number -->
  <tr><td style="padding:0 40px 24px;">
    <div style="background:#f5f5f4;display:inline-block;padding:10px 24px;font-size:15px;font-weight:500;color:#1c1917;">
      ${esc(request_number)}
    </div>
  </td></tr>

  ${trackingBlock}

  <!-- Items -->
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 16px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#78716c;font-weight:500;">Your Samples</p>
    <table cellpadding="0" cellspacing="0" width="100%">
      ${itemRows}
    </table>
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
