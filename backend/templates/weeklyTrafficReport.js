import { LOGO_LOCKUP } from './_config.js';

function esc(str) {
  return (str || '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders a signed, colored week-over-week delta (e.g. "+18%" green, "−4%" red).
function delta(cur, prev) {
  if (prev == null || prev === 0) {
    if (!cur) return '<span style="font-size:11px;color:#a8a29e;">—</span>';
    return '<span style="font-size:11px;color:#16a34a;">new</span>';
  }
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return '<span style="font-size:11px;color:#a8a29e;">±0%</span>';
  const up = pct > 0;
  const color = up ? '#16a34a' : '#b91c1c';
  const arrow = up ? '▲' : '▼';
  return `<span style="font-size:11px;color:${color};">${arrow} ${up ? '+' : ''}${pct}%</span>`;
}

const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-US');
const fmtMoney = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Weekly site-traffic digest.
 * @param {object} d
 *   rangeLabel        e.g. "Sep 9 – Sep 15, 2026"
 *   cur/prev          {sessions, visitors, page_views, product_views, add_to_carts,
 *                      checkouts, orders, sample_requests, trade_signups, revenue,
 *                      bounce_rate}
 *   topSearches       [{term, count, zeroResults}]
 *   topProducts       [{name, views}]
 *   sources           [{label, sessions}]
 *   devices           [{label, sessions}]
 */
export function generateWeeklyTrafficHTML(d) {
  const cur = d.cur || {};
  const prev = d.prev || {};

  const statCard = (label, value, prevValue, color) => `
    <td style="padding:8px;width:33%;vertical-align:top;">
      <div style="background:#fafaf9;border:1px solid #e7e5e4;padding:16px;text-align:center;">
        <div style="font-size:26px;font-weight:600;color:${color || '#1c1917'};font-family:'Cormorant Garamond',Georgia,serif;">${value}</div>
        <div style="font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px;">${label}</div>
        <div style="margin-top:4px;">${delta(prevValue == null ? null : Number(String(value).replace(/[^0-9.]/g, '')), prevValue)}</div>
      </div>
    </td>`;

  const funnelRow = (label, value, prevValue, ofSessions) => {
    const pct = ofSessions ? Math.round((value / ofSessions) * 1000) / 10 : null;
    return `
    <tr>
      <td style="padding:8px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #f0efed;">${label}</td>
      <td style="padding:8px 12px;font-size:13px;color:#1c1917;text-align:right;border-bottom:1px solid #f0efed;font-weight:600;">${fmtInt(value)}</td>
      <td style="padding:8px 12px;font-size:12px;color:#78716c;text-align:right;border-bottom:1px solid #f0efed;">${pct != null ? pct + '%' : ''}</td>
      <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0efed;">${delta(value, prevValue)}</td>
    </tr>`;
  };

  const searchRows = (d.topSearches || []).slice(0, 12).map(s => `
    <tr>
      <td style="padding:6px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #f0efed;">${esc(s.term)}${s.zeroResults ? ' <span style="font-size:10px;color:#b91c1c;background:#fef2f2;padding:1px 6px;border-radius:10px;">no results</span>' : ''}</td>
      <td style="padding:6px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f0efed;">${fmtInt(s.count)}</td>
    </tr>`).join('') || `<tr><td colspan="2" style="padding:10px 12px;font-size:12px;color:#a8a29e;">No searches this week.</td></tr>`;

  const productRows = (d.topProducts || []).slice(0, 10).map((p, i) => `
    <tr>
      <td style="padding:6px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #f0efed;"><span style="color:#a8a29e;">${i + 1}.</span> ${esc(p.name)}</td>
      <td style="padding:6px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f0efed;">${fmtInt(p.views)}</td>
    </tr>`).join('') || `<tr><td colspan="2" style="padding:10px 12px;font-size:12px;color:#a8a29e;">No product views this week.</td></tr>`;

  const splitRows = (items) => (items || []).slice(0, 6).map(s => `
    <tr>
      <td style="padding:6px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #f0efed;">${esc(s.label)}</td>
      <td style="padding:6px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f0efed;">${fmtInt(s.sessions)}</td>
    </tr>`).join('') || `<tr><td colspan="2" style="padding:10px 12px;font-size:12px;color:#a8a29e;">—</td></tr>`;

  const miniTable = (title, headerRight, rowsHtml) => `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;margin-bottom:8px;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">${title}</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">${headerRight}</th>
      </tr>
      ${rowsHtml}
    </table>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border:1px solid #e7e5e4;">

  <!-- Header -->
  <tr><td style="padding:24px 40px;border-bottom:1px solid #e7e5e4;text-align:center;">
    <div style="margin:0 0 8px;">${LOGO_LOCKUP}</div>
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:400;color:#1c1917;">Weekly Traffic Report</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#78716c;">${esc(d.rangeLabel)} &nbsp;·&nbsp; vs. prior week</p>
  </td></tr>

  <!-- Top-line cards -->
  <tr><td style="padding:20px 32px 4px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${statCard('Visitors', fmtInt(cur.visitors), prev.visitors)}
      ${statCard('Sessions', fmtInt(cur.sessions), prev.sessions)}
      ${statCard('Page Views', fmtInt(cur.page_views), prev.page_views)}
    </tr><tr>
      ${statCard('Orders', fmtInt(cur.orders), prev.orders, '#16a34a')}
      ${statCard('Sample Reqs', fmtInt(cur.sample_requests), prev.sample_requests)}
      ${statCard('Revenue', fmtMoney(cur.revenue), prev.revenue, '#16a34a')}
    </tr></table>
  </td></tr>

  <!-- Funnel -->
  <tr><td style="padding:16px 32px 4px;">
    <h2 style="margin:0 0 10px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Conversion Funnel</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Step</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Count</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">% of sess.</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">WoW</th>
      </tr>
      ${funnelRow('Sessions', cur.sessions, prev.sessions, cur.sessions)}
      ${funnelRow('Product views', cur.product_views, prev.product_views, cur.sessions)}
      ${funnelRow('Add to cart', cur.add_to_carts, prev.add_to_carts, cur.sessions)}
      ${funnelRow('Checkout started', cur.checkouts, prev.checkouts, cur.sessions)}
      ${funnelRow('Orders completed', cur.orders, prev.orders, cur.sessions)}
      ${funnelRow('Sample requests', cur.sample_requests, prev.sample_requests, cur.sessions)}
    </table>
    <p style="margin:8px 0 0;font-size:12px;color:#78716c;">Bounce rate: <strong>${(Number(cur.bounce_rate) || 0).toFixed(1)}%</strong> &nbsp;·&nbsp; Trade signups: <strong>${fmtInt(cur.trade_signups)}</strong></p>
  </td></tr>

  <!-- Searches -->
  <tr><td style="padding:16px 32px 4px;">
    <h2 style="margin:0 0 10px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Top Searches</h2>
    ${miniTable('Term', 'Searches', searchRows)}
  </td></tr>

  <!-- Products -->
  <tr><td style="padding:8px 32px 4px;">
    <h2 style="margin:0 0 10px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Most-Viewed Products</h2>
    ${miniTable('Product', 'Views', productRows)}
  </td></tr>

  <!-- Sources + devices -->
  <tr><td style="padding:8px 32px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:50%;vertical-align:top;padding-right:6px;">
        <h2 style="margin:0 0 10px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Traffic Sources</h2>
        ${miniTable('Source', 'Sessions', splitRows(d.sources))}
      </td>
      <td style="width:50%;vertical-align:top;padding-left:6px;">
        <h2 style="margin:0 0 10px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Devices</h2>
        ${miniTable('Device', 'Sessions', splitRows(d.devices))}
      </td>
    </tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">Full dashboard: admin panel &rarr; Site Traffic.</p>
    <p style="margin:0;font-size:11px;color:#a8a29e;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}
