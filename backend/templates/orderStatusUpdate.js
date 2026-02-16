function getTrackingUrl(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null;
  const c = carrier.toLowerCase();
  if (c === 'ups') return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(trackingNumber);
  if (c === 'fedex' || c === 'fedex freight') return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(trackingNumber);
  if (c === 'usps') return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(trackingNumber);
  // LTL carriers (XPO, R+L, SAIA, Old Dominion, Other) — no universal tracking URL
  return null;
}

const statusContent = {
  shipped: {
    title: 'Your Order Has Shipped',
    message: 'Great news! Your order is on its way.',
    icon: '&#x2708;'
  },
  delivered: {
    title: 'Your Order Has Been Delivered',
    message: 'Your order has been delivered! Please inspect your delivery and ensure everything is in good condition. If you have any concerns, please contact us within 48 hours.',
    icon: '&#x2714;'
  },
  cancelled: {
    title: 'Order Cancelled',
    message: 'Your order has been cancelled. If payment was collected, your refund will be processed within 5\u20137 business days. If you believe this was done in error, please contact us immediately.',
    icon: '&#x2715;'
  }
};

export function generateOrderStatusUpdateHTML(orderData, status) {
  const { order_number, customer_name, tracking_number, shipping_carrier, shipped_at } = orderData;
  const content = statusContent[status];

  if (!content) return null;

  const accentColor = status === 'cancelled' ? '#b91c1c' : '#c9a668';
  const trackingUrl = getTrackingUrl(shipping_carrier, tracking_number);

  // Build tracking section if tracking data exists
  let trackingSection = '';
  if (tracking_number && status === 'shipped') {
    const shippedDate = shipped_at ? new Date(shipped_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    trackingSection = `
  <!-- Tracking Info -->
  <tr><td style="padding:0 40px 32px;">
    <div style="background:#fafaf9;border:1px solid #e7e5e4;border-radius:4px;padding:20px;text-align:center;">
      <p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Tracking Number</p>
      <p style="margin:0 0 12px;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;letter-spacing:0.5px;">${esc(tracking_number)}</p>
      ${shipping_carrier ? `<p style="margin:0 0 4px;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;">Carrier: <strong>${esc(shipping_carrier)}</strong></p>` : ''}
      ${shippedDate ? `<p style="margin:0 0 16px;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;">Shipped: ${shippedDate}</p>` : ''}
      ${trackingUrl ? `<a href="${trackingUrl}" target="_blank" style="display:inline-block;padding:10px 28px;background:#c9a668;color:#ffffff;font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:500;text-decoration:none;border-radius:4px;letter-spacing:0.5px;">Track Your Package</a>` : ''}
    </div>
  </td></tr>`;
  }

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

  <!-- Status Icon + Title -->
  <tr><td style="padding:40px 40px 20px;text-align:center;">
    <div style="display:inline-block;width:48px;height:48px;line-height:48px;border-radius:50%;background:${accentColor};color:#fff;font-size:20px;text-align:center;margin-bottom:16px;">
      ${content.icon}
    </div>
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;color:#292524;">${content.title}</h1>
  </td></tr>

  <!-- Order Number -->
  <tr><td style="padding:0 40px 24px;text-align:center;">
    <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Order Number</p>
    <p style="margin:4px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;">${esc(order_number)}</p>
  </td></tr>

  <!-- Message -->
  <tr><td style="padding:0 40px ${tracking_number && status === 'shipped' ? '24px' : '40px'};">
    <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;line-height:1.7;">
      Hi ${esc(customer_name)},<br><br>
      ${content.message}
    </p>
  </td></tr>

  ${trackingSection}

  <!-- Contact -->
  <tr><td style="padding:0 40px 40px;">
    <p style="margin:0;padding:16px;background:#fafaf9;border:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;line-height:1.6;text-align:center;">
      Questions? Contact us at <a href="mailto:Sales@romaflooringdesigns.com" style="color:#c9a668;">Sales@romaflooringdesigns.com</a>
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
