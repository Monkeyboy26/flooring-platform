import { LOGO_URL } from './_config.js';

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateDailyHealthCheckHTML(data) {
  const { generated_at, summary, sources } = data;
  const dateStr = new Date(generated_at).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const problemSources = sources.filter(s => s.status !== 'healthy');

  const statCard = (label, value, color, bgColor) => `
    <td style="padding:8px;width:25%;">
      <div style="background:${bgColor || '#fafaf9'};border:1px solid #e7e5e4;padding:16px;text-align:center;">
        <div style="font-size:28px;font-weight:600;color:${color || '#1c1917'};font-family:'Cormorant Garamond',Georgia,serif;">${value}</div>
        <div style="font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px;">${label}</div>
      </div>
    </td>`;

  const statusBadge = (status) => {
    const colors = { critical: '#b91c1c', warning: '#a16207', healthy: '#16a34a' };
    const bgs = { critical: '#fef2f2', warning: '#fefce8', healthy: '#f0fdf4' };
    return `<span style="display:inline-block;padding:2px 10px;font-size:11px;font-weight:600;color:${colors[status]};background:${bgs[status]};border-radius:12px;text-transform:uppercase;">${status}</span>`;
  };

  const issueRows = problemSources.map(s => `
    <tr style="background:${s.status === 'critical' ? '#fef2f2' : '#fefce8'};">
      <td style="padding:8px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #e7e5e4;">${esc(s.vendor_name)}</td>
      <td style="padding:8px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #e7e5e4;">${esc(s.source_name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;text-align:center;">${statusBadge(s.status)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#57534e;border-bottom:1px solid #e7e5e4;">
        ${(s.issues || []).map(i => `<div style="margin-bottom:2px;">• ${esc(i)}</div>`).join('')}
      </td>
    </tr>`).join('');

  const allHealthy = problemSources.length === 0;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border:1px solid #e7e5e4;">

  <!-- Header -->
  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <img src="${LOGO_URL}" alt="Roma Flooring Designs" width="60" height="60" style="display:block;margin:0 auto 8px;width:60px;height:60px;" />
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:400;color:#1c1917;">Scraper Health Report</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#78716c;">${dateStr}</p>
  </td></tr>

  <!-- Summary Cards -->
  <tr><td style="padding:24px 32px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statCard('Total Sources', summary.total_sources)}
        ${statCard('Healthy', summary.healthy, '#16a34a', '#f0fdf4')}
        ${statCard('Warning', summary.warning, '#a16207', '#fefce8')}
        ${statCard('Critical', summary.critical, '#b91c1c', '#fef2f2')}
      </tr>
    </table>
  </td></tr>

  ${allHealthy ? `
  <!-- All Healthy -->
  <tr><td style="padding:24px 40px;">
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:20px;text-align:center;">
      <div style="font-size:16px;color:#16a34a;font-weight:500;">All scrapers are healthy</div>
      <div style="font-size:13px;color:#57534e;margin-top:4px;">No issues detected across ${summary.total_sources} active sources.</div>
    </div>
  </td></tr>` : `
  <!-- Issues Table -->
  <tr><td style="padding:16px 32px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Issues Detected</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Vendor</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Source</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:center;text-transform:uppercase;letter-spacing:0.05em;">Status</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Issues</th>
      </tr>
      ${issueRows}
    </table>
  </td></tr>`}

  <!-- Footer -->
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">Check the admin panel for full details.</p>
    <p style="margin:0;font-size:11px;color:#a8a29e;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}
