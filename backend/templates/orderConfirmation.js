export function generateOrderConfirmationHTML(orderData) {
  const {
    order_number, created_at, customer_name,
    shipping_address_line1, shipping_address_line2, shipping_city, shipping_state, shipping_zip,
    delivery_method, subtotal, shipping, sample_shipping, total, items = []
  } = orderData;

  const orderDate = new Date(created_at).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const isPickup = delivery_method === 'pickup';

  const addressBlock = isPickup
    ? '<p style="margin:0;color:#57534e;">Store Pickup</p>'
    : `<p style="margin:0;color:#57534e;">${esc(shipping_address_line1)}</p>
       ${shipping_address_line2 ? `<p style="margin:0;color:#57534e;">${esc(shipping_address_line2)}</p>` : ''}
       <p style="margin:0;color:#57534e;">${esc(shipping_city)}, ${esc(shipping_state)} ${esc(shipping_zip)}</p>`;

  const itemRows = items.map(item => {
    const isSample = item.is_sample;
    const name = esc(item.product_name || 'Product');
    const collection = item.collection ? esc(item.collection) : '';
    const qty = isSample ? `${item.num_boxes} sample${item.num_boxes > 1 ? 's' : ''}` : `${item.num_boxes} box${item.num_boxes > 1 ? 'es' : ''}`;
    const price = isSample ? 'FREE' : `$${parseFloat(item.subtotal || 0).toFixed(2)}`;
    const sampleBadge = isSample
      ? ' <span style="display:inline-block;background:#c9a668;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;text-transform:uppercase;font-family:Inter,Arial,sans-serif;">Sample</span>'
      : '';

    return `<tr>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;">
        ${name}${sampleBadge}
        ${collection ? `<br><span style="color:#78716c;font-size:12px;">${collection}</span>` : ''}
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;text-align:center;">${qty}</td>
      <td style="padding:12px 0;border-bottom:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">${price}</td>
    </tr>`;
  }).join('');

  const shippingTotal = parseFloat(shipping || 0) + parseFloat(sample_shipping || 0);

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
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:18px;letter-spacing:4px;color:#292524;font-weight:600;">ATELIER SURFACES</p>
  </td></tr>

  <!-- Title -->
  <tr><td style="padding:40px 40px 20px;">
    <h1 style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:600;color:#292524;">Order Confirmed</h1>
    <p style="margin:8px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#78716c;">Thank you for your order, ${esc(customer_name)}.</p>
  </td></tr>

  <!-- Order Info -->
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;width:50%;">
          <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Order Number</p>
          <p style="margin:4px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${esc(order_number)}</p>
        </td>
        <td style="padding:12px 16px;background:#fafaf9;border:1px solid #e7e5e4;border-left:none;width:50%;">
          <p style="margin:0;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">Order Date</p>
          <p style="margin:4px 0 0;font-family:Inter,Arial,sans-serif;font-size:14px;font-weight:500;color:#292524;">${orderDate}</p>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Shipping Address -->
  <tr><td style="padding:0 40px 24px;">
    <p style="margin:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;">${isPickup ? 'Delivery Method' : 'Shipping Address'}</p>
    ${addressBlock}
  </td></tr>

  <!-- Items -->
  <tr><td style="padding:0 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;">Item</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:center;">Qty</td>
        <td style="padding:0 0 8px;font-family:Inter,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#78716c;border-bottom:2px solid #292524;text-align:right;">Price</td>
      </tr>
      ${itemRows}
    </table>
  </td></tr>

  <!-- Totals -->
  <tr><td style="padding:0 40px 32px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Subtotal</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">$${parseFloat(subtotal || 0).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#57534e;">Shipping</td>
        <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:#292524;text-align:right;">${shippingTotal > 0 ? '$' + shippingTotal.toFixed(2) : 'FREE'}</td>
      </tr>
      <tr>
        <td style="padding:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;">Total</td>
        <td style="padding:12px 0 0;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:500;color:#292524;border-top:2px solid #292524;text-align:right;">$${parseFloat(total || 0).toFixed(2)}</td>
      </tr>
    </table>
  </td></tr>

  <!-- Next Steps -->
  <tr><td style="padding:0 40px 40px;">
    <p style="margin:0;padding:16px;background:#fafaf9;border:1px solid #e7e5e4;font-family:Inter,Arial,sans-serif;font-size:13px;color:#57534e;line-height:1.6;">
      We'll send you a notification when your order ships. If you have any questions, reply to this email or contact us at <a href="mailto:hello@ateliersurfaces.com" style="color:#c9a668;">hello@ateliersurfaces.com</a>.
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:24px 40px;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:14px;letter-spacing:2px;color:#a8a29e;">ATELIER SURFACES</p>
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
