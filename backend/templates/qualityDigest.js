import { LOGO_URL } from './_config.js';

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateQualityDigestHTML(data) {
  const { generated_at, overall, vendors, worst_skus } = data;
  const dateStr = new Date(generated_at).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const statCard = (label, value, color, bgColor) => `
    <td style="padding:8px;width:25%;">
      <div style="background:${bgColor || '#fafaf9'};border:1px solid #e7e5e4;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:600;color:${color || '#1c1917'};font-family:'Cormorant Garamond',Georgia,serif;">${value}</div>
        <div style="font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px;">${label}</div>
      </div>
    </td>`;

  const scoreColor = (score) => score >= 80 ? '#16a34a' : score >= 50 ? '#a16207' : '#b91c1c';
  const scoreBg = (score) => score >= 80 ? '#f0fdf4' : score >= 50 ? '#fefce8' : '#fef2f2';

  const vendorRows = vendors.map(v => `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #e7e5e4;">${esc(v.vendor_name)}</td>
      <td style="padding:8px 12px;text-align:center;border-bottom:1px solid #e7e5e4;">
        <span style="display:inline-block;padding:2px 10px;font-size:12px;font-weight:600;color:${scoreColor(v.avg_score)};background:${scoreBg(v.avg_score)};border-radius:12px;">${v.avg_score}</span>
      </td>
      <td style="padding:8px 12px;font-size:13px;color:#57534e;text-align:center;border-bottom:1px solid #e7e5e4;">${v.sku_count}</td>
      <td style="padding:8px 12px;font-size:12px;color:#57534e;border-bottom:1px solid #e7e5e4;">
        ${v.issues.map(i => `<span style="display:inline-block;padding:1px 6px;margin:1px;font-size:10px;background:#fef2f2;color:#991b1b;border-radius:8px;">${esc(i)}</span>`).join('')}
      </td>
    </tr>`).join('');

  const worstRows = worst_skus.slice(0, 10).map(s => `
    <tr>
      <td style="padding:6px 12px;font-size:12px;color:#57534e;border-bottom:1px solid #e7e5e4;">${esc(s.vendor_name)}</td>
      <td style="padding:6px 12px;font-size:12px;color:#1c1917;border-bottom:1px solid #e7e5e4;">${esc(s.product_name)}</td>
      <td style="padding:6px 12px;font-size:11px;font-family:monospace;color:#57534e;border-bottom:1px solid #e7e5e4;">${esc(s.internal_sku)}</td>
      <td style="padding:6px 12px;text-align:center;border-bottom:1px solid #e7e5e4;">
        <span style="font-weight:600;color:${scoreColor(s.quality_score)};">${s.quality_score}</span>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border:1px solid #e7e5e4;">

  <!-- Header -->
  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <img src="${LOGO_URL}" alt="Roma Flooring Designs" width="60" height="60" style="display:block;margin:0 auto 8px;width:60px;height:60px;" />
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:400;color:#1c1917;">Data Quality Digest</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#78716c;">${dateStr}</p>
  </td></tr>

  <!-- Summary Cards -->
  <tr><td style="padding:24px 32px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statCard('Avg Score', overall.avg_score, scoreColor(overall.avg_score), scoreBg(overall.avg_score))}
        ${statCard('Active SKUs', overall.total_skus.toLocaleString())}
        ${statCard('Good (80+)', overall.good.toLocaleString(), '#16a34a', '#f0fdf4')}
        ${statCard('Poor (<50)', overall.poor.toLocaleString(), overall.poor > 0 ? '#b91c1c' : '#16a34a', overall.poor > 0 ? '#fef2f2' : '#f0fdf4')}
      </tr>
    </table>
  </td></tr>

  <!-- Missing Data Summary -->
  <tr><td style="padding:16px 32px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:4px 8px;width:50%;">
          <div style="font-size:12px;color:#78716c;">No Image: <strong style="color:${overall.no_image > 0 ? '#b91c1c' : '#16a34a'}">${overall.no_image}</strong></div>
        </td>
        <td style="padding:4px 8px;width:50%;">
          <div style="font-size:12px;color:#78716c;">No Price: <strong style="color:${overall.no_price > 0 ? '#b91c1c' : '#16a34a'}">${overall.no_price}</strong></div>
        </td>
      </tr>
      <tr>
        <td style="padding:4px 8px;">
          <div style="font-size:12px;color:#78716c;">No Color: <strong style="color:${overall.no_color > 0 ? '#a16207' : '#16a34a'}">${overall.no_color}</strong></div>
        </td>
        <td style="padding:4px 8px;">
          <div style="font-size:12px;color:#78716c;">No Description: <strong style="color:${overall.no_description > 0 ? '#a16207' : '#16a34a'}">${overall.no_description}</strong></div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Vendors Below 80 -->
  ${vendors.length > 0 ? `
  <tr><td style="padding:16px 32px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Vendors Below 80</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Vendor</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:center;text-transform:uppercase;letter-spacing:0.05em;">Score</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:center;text-transform:uppercase;letter-spacing:0.05em;">SKUs</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Issues</th>
      </tr>
      ${vendorRows}
    </table>
  </td></tr>` : `
  <tr><td style="padding:24px 40px;">
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:20px;text-align:center;">
      <div style="font-size:16px;color:#16a34a;font-weight:500;">All vendors at 80+</div>
      <div style="font-size:13px;color:#57534e;margin-top:4px;">No vendors below the quality threshold.</div>
    </div>
  </td></tr>`}

  <!-- Worst SKUs -->
  ${worst_skus.length > 0 ? `
  <tr><td style="padding:16px 32px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Lowest Scoring SKUs</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:6px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Vendor</th>
        <th style="padding:6px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Product</th>
        <th style="padding:6px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">SKU</th>
        <th style="padding:6px 12px;font-size:11px;color:#fff;text-align:center;text-transform:uppercase;letter-spacing:0.05em;">Score</th>
      </tr>
      ${worstRows}
    </table>
  </td></tr>` : ''}

  <!-- Footer -->
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">View full details in the admin panel under Data Quality.</p>
    <p style="margin:0;font-size:11px;color:#a8a29e;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}
