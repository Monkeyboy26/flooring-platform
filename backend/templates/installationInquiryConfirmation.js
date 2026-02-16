function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function generateInstallationInquiryConfirmationHTML(inquiry) {
  const productLine = inquiry.product_name
    ? `<p style="color:#57534e;line-height:1.6;margin:0 0 8px;"><strong>Product:</strong> ${esc(inquiry.product_name)}${inquiry.collection ? ` — ${esc(inquiry.collection)}` : ''}</p>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px 40px 20px;text-align:center;border-bottom:1px solid #e7e5e4;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0;">Roma Flooring Designs</h1>
    <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#78716c;margin:8px 0 0;">Installation Services</p>
  </td></tr>
  <tr><td style="padding:40px;">
    <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:400;color:#1c1917;margin:0 0 16px;">Inquiry Received</h2>
    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">Dear ${esc(inquiry.customer_name)},</p>
    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">Thank you for your interest in our professional installation services. We've received your inquiry and a member of our team will be in touch within <strong>1–2 business days</strong>.</p>

    <div style="background:#f5f5f4;padding:20px;margin:24px 0;">
      <p style="margin:0 0 12px;font-weight:500;color:#1c1917;">Your Submission Summary</p>
      ${productLine}
      ${inquiry.zip_code ? `<p style="color:#57534e;line-height:1.6;margin:0 0 8px;"><strong>Zip Code:</strong> ${esc(inquiry.zip_code)}</p>` : ''}
      ${inquiry.estimated_sqft ? `<p style="color:#57534e;line-height:1.6;margin:0 0 8px;"><strong>Estimated Area:</strong> ${esc(inquiry.estimated_sqft)} sq ft</p>` : ''}
      ${inquiry.message ? `<p style="color:#57534e;line-height:1.6;margin:0;"><strong>Message:</strong> ${esc(inquiry.message)}</p>` : ''}
    </div>

    <p style="color:#57534e;line-height:1.6;margin:0 0 16px;">If you have any immediate questions, feel free to reach us at <a href="tel:7149990009" style="color:#b8860b;">(714) 999-0009</a> or <a href="mailto:Sales@romaflooringdesigns.com" style="color:#b8860b;">Sales@romaflooringdesigns.com</a>.</p>
    <p style="color:#57534e;line-height:1.6;margin:0;">Thank you for choosing Roma Flooring Designs.</p>
  </td></tr>
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-size:12px;color:#78716c;">Roma Flooring Designs | 1440 S. State College Blvd #6M, Anaheim, CA 92806 | (714) 999-0009</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
