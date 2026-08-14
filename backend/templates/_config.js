const BASE = process.env.SITE_URL || 'http://localhost:3001';
export const LOGO_URL = BASE + '/assets/logo/roma-square.png';
export const SITE_URL = BASE;

// Text logo lockup — email-safe inline styles, centered, for light backgrounds.
// Pinyon Script degrades to Brush Script MT / serif in clients without web fonts.
export const LOGO_LOCKUP = `<div style="text-align:center;">
<p style="margin:0;font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;line-height:1;font-weight:400;letter-spacing:0.34em;color:#1c1917;">ROMA <span style="font-size:24px;letter-spacing:normal;color:#1c1917;">FLOORING</span></p>
<p style="margin:-10px 0 0;font-family:'Pinyon Script','Brush Script MT','Segoe Script','Cormorant Garamond',cursive;font-size:33px;line-height:1;color:#a87935;">Designs</p>
</div>`;

// CAN-SPAM: every MARKETING email must include the physical address and a
// working unsubscribe link (transactional emails are exempt). Pass the
// subscriber's unsubscribe_token from newsletter_subscribers.
export const BUSINESS_ADDRESS = 'Roma Flooring Designs · 1440 South State College Blvd #6M, Anaheim, CA 92806';
export const unsubscribeUrl = (token) => `${BASE}/api/newsletter/unsubscribe/${token}`;
export const marketingFooter = (token) => `
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e7e2db;font-size:12px;line-height:1.6;color:#a8a29e;text-align:center">
    ${BUSINESS_ADDRESS}<br>
    You received this email because you subscribed to updates from Roma Flooring Designs.<br>
    <a href="${unsubscribeUrl(token)}" style="color:#78716c">Unsubscribe</a>
  </div>`;
