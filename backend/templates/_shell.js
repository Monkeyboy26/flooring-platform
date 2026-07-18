// Shared transactional-email shell — "Brass Charcoal" design.
// Table-based, inline-styled HTML for email-client compatibility.

export const T = {
  ink: '#1c1917',      // near-black text, buttons, footer bg
  paper: '#ece5d8',    // card background
  accent: '#a87935',   // brass — eyebrows, section labels
  muted: '#8a7e68',    // secondary text
  warm: '#d8cdb6',     // warm card / chip background
  inbox: '#f3f1ed',    // page background behind the card
  border: '#d4ccbd',   // row separators on paper
  hairline: '#ddd5c6', // lighter separators on paper
  body: '#46413a',     // long-form body text
  soft: '#6f6759',     // tertiary text
  footText: '#c2bcb1', // footer body text on ink
  footFaint: '#a49f93',// footer fine print on ink
  footBorder: '#4a463f'// footer divider on ink
};

export const SERIF = "'Cormorant Garamond',Georgia,'Times New Roman',serif";
export const SANS = "'Inter',Helvetica,Arial,sans-serif";
export const MONO = "'SF Mono',Menlo,Consolas,'Courier New',monospace";

export function money(v) {
  return '$' + parseFloat(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Small mono uppercase label used above sections.
export function sectionLabel(text, color = T.accent) {
  return `<p style="margin:0 0 14px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${color};">${text}</p>`;
}

// One content row of the outer card table.
export function section(inner, padding = '0 40px 24px') {
  return `<tr><td style="padding:${padding};">${inner}</td></tr>`;
}

// Centered hero: eyebrow, serif headline (may contain <em>), body copy, optional chip.
export function heroSection({ eyebrow, headline, body, chip }) {
  return `<tr><td style="padding:40px 40px 28px;text-align:center;">
    <p style="margin:0 0 18px;font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.22em;text-transform:uppercase;color:${T.accent};">${eyebrow}</p>
    <h1 style="margin:0;font-family:${SERIF};font-size:44px;line-height:1.02;font-weight:300;letter-spacing:-0.02em;color:${T.ink};">${headline}</h1>
    ${body ? `<p style="margin:20px auto 0;max-width:480px;font-family:${SANS};font-size:15px;line-height:1.6;color:${T.body};">${body}</p>` : ''}
    ${chip ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin-top:22px;"><tr>
      <td style="padding:8px 14px;background:${T.warm};border:1px solid ${T.border};font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;color:${T.ink};">${chip}</td>
    </tr></table>` : ''}
  </td></tr>`;
}

// Full-width primary CTA with optional note beneath it.
export function ctaButton({ href, label, note }) {
  return `<tr><td style="padding:4px 40px 24px;text-align:center;">
    <a href="${esc(href)}" target="_blank" style="display:block;padding:18px 28px;background:${T.ink};color:${T.paper};font-family:${SANS};font-size:13px;font-weight:500;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;text-align:center;">${label}</a>
    ${note ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${T.muted};">${note}</p>` : ''}
  </td></tr>`;
}

// Label/value rows (mono label column, sans value column).
export function detailList(rows, labelWidth = 140) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    ${rows.map((r, i) => `<tr>
      <td width="${labelWidth}" valign="top" style="padding:12px 14px 12px 0;${i < rows.length - 1 ? `border-bottom:1px solid ${T.hairline};` : ''}font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.16em;text-transform:uppercase;color:${T.muted};">${r.label}</td>
      <td valign="top" style="padding:12px 0;${i < rows.length - 1 ? `border-bottom:1px solid ${T.hairline};` : ''}font-family:${SANS};font-size:14px;line-height:1.4;color:${T.ink};">${r.value}</td>
    </tr>`).join('')}
  </table>`;
}

// Warm highlight box.
export function warmCard(inner, padding = '18px 22px') {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.warm};"><tr>
    <td style="padding:${padding};">${inner}</td>
  </tr></table>`;
}

function brandHeader() {
  return `<tr><td style="padding:32px 40px 22px;text-align:center;border-bottom:1px solid ${T.border};">
    <p style="margin:0;font-family:${SERIF};font-size:40px;line-height:1;font-weight:300;letter-spacing:-0.018em;color:${T.ink};">Roma</p>
    <p style="margin:6px 0 0;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.24em;text-transform:uppercase;color:${T.muted};">Flooring &middot; Surfaces &middot; Anaheim</p>
  </td></tr>`;
}

function footer() {
  return `<tr><td style="background:${T.ink};padding:28px 40px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="50%" valign="top" style="padding:0 12px 18px 0;border-bottom:1px solid ${T.footBorder};">
          <p style="margin:0 0 10px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};">Showroom</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.footText};">1440 S. State College Blvd #6M<br>Anaheim, CA 92806<br>Mon&ndash;Fri 8am&ndash;5pm &middot; Sat 9am&ndash;2pm</p>
        </td>
        <td width="50%" valign="top" style="padding:0 0 18px;border-bottom:1px solid ${T.footBorder};">
          <p style="margin:0 0 10px;font-family:${MONO};font-size:10px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};">Reach us</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;line-height:1.5;color:${T.footText};">(714) 999-0009<br><a href="mailto:Sales@romaflooringdesigns.com" style="color:${T.footText};text-decoration:none;">Sales@romaflooringdesigns.com</a><br>License #830966 &middot; Licensed + bonded</p>
        </td>
      </tr>
    </table>
    <p style="margin:18px 0 0;font-family:${SANS};font-size:11px;line-height:1.4;color:${T.footFaint};">&copy; ${new Date().getFullYear()} Roma Flooring Designs &middot; Anaheim, CA &middot; <a href="https://www.romaflooringdesigns.com" style="color:${T.footText};text-decoration:none;">romaflooringdesigns.com</a></p>
  </td></tr>`;
}

// Full email document: inbox background, 640px card, brand header + content + footer.
export function emailShell({ title, preheader, content }) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title || 'Roma Flooring Designs')}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@300;400;500;600&display=swap');</style>
</head>
<body style="margin:0;padding:0;background-color:${T.inbox};font-family:${SANS};">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${T.inbox};">
<tr><td align="center" style="padding:40px 12px 60px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background-color:${T.paper};">
${brandHeader()}
${content}
${footer()}
</table>
</td></tr>
</table>
</body>
</html>`;
}
