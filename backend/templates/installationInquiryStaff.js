function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export function generateInstallationInquiryStaffHTML(inquiry) {
  const productSection = inquiry.product_name ? `
    <div style="background:#f5f5f4;border-left:3px solid #b8860b;padding:16px 20px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-weight:500;color:#1c1917;">Product Reference</p>
      <p style="margin:0;color:#57534e;line-height:1.6;">${esc(inquiry.product_name)}${inquiry.collection ? ` — ${esc(inquiry.collection)}` : ''}</p>
    </div>` : '';

  const messageSection = inquiry.message ? `
    <div style="margin:0 0 24px;">
      <p style="margin:0 0 8px;font-weight:500;color:#1c1917;">Customer Message</p>
      <blockquote style="margin:0;padding:12px 20px;border-left:3px solid #e7e5e4;color:#57534e;line-height:1.6;font-style:italic;">${esc(inquiry.message)}</blockquote>
    </div>` : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;padding:40px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;">
  <tr><td style="padding:40px 40px 20px;text-align:center;border-bottom:1px solid #e7e5e4;">
    <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;font-weight:300;color:#1c1917;margin:0;">Roma Flooring Designs</h1>
    <p style="font-size:12px;text-transform:uppercase;letter-spacing:0.1em;color:#78716c;margin:8px 0 0;">Installation Inquiry</p>
  </td></tr>
  <tr><td style="padding:40px;">
    <h2 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;font-weight:400;color:#1c1917;margin:0 0 24px;">New Installation Inquiry — ${esc(inquiry.customer_name)}</h2>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="padding:8px 0;color:#78716c;width:140px;vertical-align:top;">Name</td>
        <td style="padding:8px 0;color:#1c1917;">${esc(inquiry.customer_name)}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#78716c;vertical-align:top;">Email</td>
        <td style="padding:8px 0;color:#1c1917;"><a href="mailto:${esc(inquiry.customer_email)}" style="color:#b8860b;">${esc(inquiry.customer_email)}</a></td>
      </tr>
      ${inquiry.phone ? `<tr>
        <td style="padding:8px 0;color:#78716c;vertical-align:top;">Phone</td>
        <td style="padding:8px 0;color:#1c1917;">${esc(inquiry.phone)}</td>
      </tr>` : ''}
      ${inquiry.zip_code ? `<tr>
        <td style="padding:8px 0;color:#78716c;vertical-align:top;">Zip Code</td>
        <td style="padding:8px 0;color:#1c1917;">${esc(inquiry.zip_code)}</td>
      </tr>` : ''}
      ${inquiry.estimated_sqft ? `<tr>
        <td style="padding:8px 0;color:#78716c;vertical-align:top;">Estimated Sq Ft</td>
        <td style="padding:8px 0;color:#1c1917;">${esc(inquiry.estimated_sqft)}</td>
      </tr>` : ''}
    </table>

    ${productSection}
    ${messageSection}
  </td></tr>
  <tr><td style="padding:20px 40px;background:#f5f5f4;border-top:1px solid #e7e5e4;text-align:center;">
    <p style="margin:0;font-size:12px;color:#78716c;">Roma Flooring Designs | 1440 S. State College Blvd #6M, Anaheim, CA 92806 | (714) 999-0009</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}
