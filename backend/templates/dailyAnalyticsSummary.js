import { LOGO_URL } from './_config.js';

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function fmtMoney(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(n) {
  return parseFloat(n || 0).toFixed(1) + '%';
}

export function generateDailyAnalyticsSummaryHTML(data) {
  const {
    stat_date,
    total_sessions = 0,
    unique_visitors = 0,
    page_views = 0,
    product_views = 0,
    add_to_carts = 0,
    checkouts_started = 0,
    orders_completed = 0,
    searches = 0,
    sample_requests = 0,
    trade_signups = 0,
    total_revenue = 0,
    avg_session_duration_secs = 0,
    bounce_rate = 0,
    cart_abandonment_rate = 0,
    top_search_terms = [],
    top_viewed_not_purchased = [],
    zero_result_searches = [],
    funnel = {}
  } = data;

  const dateStr = new Date(stat_date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const durationMin = Math.floor(avg_session_duration_secs / 60);
  const durationSec = avg_session_duration_secs % 60;
  const durationStr = durationMin > 0 ? `${durationMin}m ${durationSec}s` : `${durationSec}s`;

  const statCard = (label, value, color) => `
    <td style="padding:8px;width:33%;">
      <div style="background:#fafaf9;border:1px solid #e7e5e4;padding:16px;text-align:center;">
        <div style="font-size:24px;font-weight:600;color:${color || '#1c1917'};font-family:'Cormorant Garamond',Georgia,serif;">${value}</div>
        <div style="font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:0.05em;margin-top:4px;">${label}</div>
      </div>
    </td>`;

  const funnelStep = (label, count, pct) => `
    <tr>
      <td style="padding:6px 12px;font-size:13px;color:#1c1917;">${label}</td>
      <td style="padding:6px 12px;font-size:13px;color:#1c1917;text-align:right;font-weight:500;">${fmtNum(count)}</td>
      <td style="padding:6px 12px;font-size:13px;color:${pct < 30 ? '#b91c1c' : pct < 60 ? '#c8a97e' : '#16a34a'};text-align:right;">${pct != null ? fmtPct(pct) : '--'}</td>
    </tr>`;

  const pvToProduct = product_views > 0 ? ((product_views / page_views) * 100) : 0;
  const productToCart = product_views > 0 ? ((add_to_carts / product_views) * 100) : 0;
  const cartToCheckout = add_to_carts > 0 ? ((checkouts_started / add_to_carts) * 100) : 0;
  const checkoutToOrder = checkouts_started > 0 ? ((orders_completed / checkouts_started) * 100) : 0;

  const searchTermRows = (top_search_terms || []).slice(0, 10).map((t, i) => `
    <tr>
      <td style="padding:4px 12px;font-size:13px;color:#57534e;border-bottom:1px solid #f5f5f4;">${i + 1}.</td>
      <td style="padding:4px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #f5f5f4;">${esc(t.term || t)}</td>
      <td style="padding:4px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f5f5f4;">${fmtNum(t.count || '')}</td>
    </tr>`).join('');

  const zeroResultRows = (zero_result_searches || []).slice(0, 5).map(t => `
    <tr>
      <td style="padding:4px 12px;font-size:13px;color:#b91c1c;border-bottom:1px solid #f5f5f4;">${esc(t.term || t)}</td>
      <td style="padding:4px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f5f5f4;">${fmtNum(t.count || '')}</td>
    </tr>`).join('');

  const viewedNotPurchasedRows = (top_viewed_not_purchased || []).slice(0, 5).map(p => `
    <tr>
      <td style="padding:4px 12px;font-size:13px;color:#1c1917;border-bottom:1px solid #f5f5f4;">${esc(p.product_name || '')}</td>
      <td style="padding:4px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f5f5f4;">${fmtNum(p.views)}</td>
      <td style="padding:4px 12px;font-size:13px;color:#57534e;text-align:right;border-bottom:1px solid #f5f5f4;">${fmtNum(p.carts)}</td>
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
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:400;color:#1c1917;">Daily Analytics Summary</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#78716c;">${dateStr}</p>
  </td></tr>

  <!-- Key Stats -->
  <tr><td style="padding:24px 32px 8px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        ${statCard('Sessions', fmtNum(total_sessions))}
        ${statCard('Unique Visitors', fmtNum(unique_visitors))}
        ${statCard('Revenue', fmtMoney(total_revenue), '#16a34a')}
      </tr>
      <tr>
        ${statCard('Page Views', fmtNum(page_views))}
        ${statCard('Orders', fmtNum(orders_completed))}
        ${statCard('Avg Duration', durationStr)}
      </tr>
      <tr>
        ${statCard('Bounce Rate', fmtPct(bounce_rate), parseFloat(bounce_rate) > 60 ? '#b91c1c' : '#1c1917')}
        ${statCard('Cart Abandon', fmtPct(cart_abandonment_rate), parseFloat(cart_abandonment_rate) > 70 ? '#b91c1c' : '#1c1917')}
        ${statCard('Searches', fmtNum(searches))}
      </tr>
    </table>
  </td></tr>

  <!-- Funnel -->
  <tr><td style="padding:16px 40px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Conversion Funnel</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Step</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Count</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Rate</th>
      </tr>
      ${funnelStep('Page Views', page_views, null)}
      ${funnelStep('Product Views', product_views, pvToProduct)}
      ${funnelStep('Add to Cart', add_to_carts, productToCart)}
      ${funnelStep('Checkout Started', checkouts_started, cartToCheckout)}
      ${funnelStep('Order Completed', orders_completed, checkoutToOrder)}
    </table>
  </td></tr>

  <!-- Viewed but Not Purchased -->
  ${viewedNotPurchasedRows ? `
  <tr><td style="padding:16px 40px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Top Viewed (Not Purchased)</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Product</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Views</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Carts</th>
      </tr>
      ${viewedNotPurchasedRows}
    </table>
  </td></tr>` : ''}

  <!-- Top Search Terms -->
  ${searchTermRows ? `
  <tr><td style="padding:16px 40px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#1c1917;">Top Search Terms</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#1c1917;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">#</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Term</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Count</th>
      </tr>
      ${searchTermRows}
    </table>
  </td></tr>` : ''}

  <!-- Zero Result Searches -->
  ${zeroResultRows ? `
  <tr><td style="padding:16px 40px;">
    <h2 style="margin:0 0 12px;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;font-weight:400;color:#b91c1c;">Zero-Result Searches</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr style="background:#b91c1c;">
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:left;text-transform:uppercase;letter-spacing:0.05em;">Term</th>
        <th style="padding:8px 12px;font-size:11px;color:#fff;text-align:right;text-transform:uppercase;letter-spacing:0.05em;">Count</th>
      </tr>
      ${zeroResultRows}
    </table>
  </td></tr>` : ''}

  <!-- Other Metrics -->
  <tr><td style="padding:16px 40px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7e5e4;">
      <tr><td style="padding:8px 12px;font-size:13px;color:#57534e;border-bottom:1px solid #f5f5f4;">Sample Requests</td><td style="padding:8px 12px;font-size:13px;color:#1c1917;text-align:right;border-bottom:1px solid #f5f5f4;">${fmtNum(sample_requests)}</td></tr>
      <tr><td style="padding:8px 12px;font-size:13px;color:#57534e;">Trade Signups</td><td style="padding:8px 12px;font-size:13px;color:#1c1917;text-align:right;">${fmtNum(trade_signups)}</td></tr>
    </table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#78716c;">This report was generated automatically at 7:00 AM Pacific.</p>
    <p style="margin:0;font-size:11px;color:#a8a29e;">Roma Flooring Designs | License #830966 | www.romaflooringdesigns.com</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}
