import { LOGO_URL } from './_config.js';

export function generateStockAlertHTML(data) {
  const { product_name, variant_name, sku_code, primary_image, product_url } = data;
  const displayName = variant_name ? `${product_name} — ${variant_name}` : product_name;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px 40px 24px;text-align:center;">
    <img src="${LOGO_URL}" alt="Roma Flooring Designs" style="height:48px;margin-bottom:24px;" />
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0 0 8px;">Good News!</h1>
    <p style="color:#57534e;font-size:16px;margin:0 0 24px;">An item on your wish list is back in stock.</p>
  </td></tr>
  <tr><td style="padding:0 40px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      ${primary_image ? `<tr><td style="text-align:center;background:#fafaf9;padding:16px;">
        <img src="${primary_image}" alt="${displayName}" style="max-width:280px;max-height:200px;" />
      </td></tr>` : ''}
      <tr><td style="padding:20px;text-align:center;">
        <div style="display:inline-block;background:#dcfce7;color:#166534;padding:4px 12px;font-size:12px;font-weight:600;letter-spacing:0.5px;margin-bottom:12px;">IN STOCK</div>
        <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:20px;font-weight:400;color:#1c1917;margin:8px 0 4px;">${displayName}</p>
        ${sku_code ? `<p style="color:#a8a29e;font-size:12px;margin:0 0 16px;">SKU: ${sku_code}</p>` : ''}
        <a href="${product_url}" style="display:inline-block;background:#1c1917;color:#fff;padding:12px 36px;text-decoration:none;font-size:14px;font-weight:500;">Shop Now</a>
      </td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:16px 40px;background:#fafaf9;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="color:#a8a29e;font-size:11px;margin:0;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
    <p style="color:#a8a29e;font-size:11px;margin:4px 0 0;">You received this email because you signed up for a back-in-stock alert.</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
