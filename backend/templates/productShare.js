import { LOGO_URL } from './_config.js';

export function generateProductShareHTML(data) {
  const {
    product_name, collection, price, sell_by,
    image_url, product_url,
    rep_first_name, rep_last_name, rep_email, rep_phone,
    message
  } = data;

  const repName = [rep_first_name, rep_last_name].filter(Boolean).join(' ') || 'Your Sales Representative';
  const priceLabel = price ? `$${parseFloat(price).toFixed(2)}${sell_by === 'sqft' ? '/sqft' : sell_by === 'unit' ? '/ea' : ''}` : '';

  const imageSection = image_url ? `
  <tr><td style="padding:0 40px 24px;text-align:center;">
    <img src="${esc(image_url)}" alt="${esc(product_name)}" width="400" style="display:block;margin:0 auto;max-width:100%;height:auto;border:1px solid #e7e5e4;" />
  </td></tr>` : '';

  const messageSection = message ? `
  <tr><td style="padding:0 40px 24px;">
    <div style="padding:16px 20px;background:#fafaf9;border:1px solid #e7e5e4;font-size:14px;color:#57534e;line-height:1.6;">
      <strong style="color:#1c1917;">A note from ${esc(repName)}:</strong><br/><br/>
      ${esc(message).replace(/\n/g, '<br/>')}
    </div>
  </td></tr>` : '';

  const ctaSection = product_url ? `
  <tr><td style="padding:0 40px 32px;text-align:center;">
    <a href="${esc(product_url)}" style="display:inline-block;background:#1c1917;color:#ffffff;padding:14px 40px;text-decoration:none;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:500;">View Product</a>
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
  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <img src="${LOGO_URL}" alt="Roma Flooring Designs" width="120" height="120" style="display:block;margin:0 auto;width:120px;height:120px;" />
  </td></tr>

  <!-- Title -->
  <tr><td style="padding:32px 40px 16px;text-align:center;">
    <h1 style="margin:0 0 4px;font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:600;color:#292524;">${esc(product_name)}</h1>
    ${collection ? `<p style="margin:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">${esc(collection)}</p>` : ''}
    ${priceLabel ? `<p style="margin:8px 0 0;font-family:Inter,Arial,sans-serif;font-size:18px;font-weight:500;color:#292524;">${priceLabel}</p>` : ''}
  </td></tr>

  <!-- Product Image -->
  ${imageSection}

  <!-- Rep Message -->
  ${messageSection}

  <!-- CTA Button -->
  ${ctaSection}

  <!-- Rep Contact -->
  <tr><td style="padding:0 40px 32px;">
    <div style="padding:20px;background:#fafaf9;border:1px solid #e7e5e4;">
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Your Sales Representative</p>
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${esc(repName)}</p>
      <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;">
        <a href="mailto:${esc(rep_email)}" style="color:#c9a668;">${esc(rep_email)}</a>
        ${rep_phone ? ` &middot; ${esc(rep_phone)}` : ''}
      </p>
    </div>
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
