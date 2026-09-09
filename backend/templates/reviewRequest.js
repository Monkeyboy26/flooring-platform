// Review-request email + the public browser pages the customer lands on after
// tapping a star. The email uses the shared "Brass Charcoal" transactional
// shell; the landing pages are standalone (rendered directly by the API) and
// carry noindex so they never enter search.

import { emailShell, heroSection, section, T, SERIF, SANS, MONO, esc } from './_shell.js';
import { SITE_URL } from './_config.js';

const PHONE = '(714) 999-0009';

// The one-tap rating URL. Email stars link straight to ?r=N; SMS sends the bare
// link and the customer picks a star on the landing page.
export function reviewRatingUrl(token, rating) {
  return `${SITE_URL}/api/reviews/r/${encodeURIComponent(token)}${rating ? `?r=${rating}` : ''}`;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function generateReviewRequestHTML({ customer_name, order_number, token }) {
  const firstName = esc((customer_name || '').trim().split(/\s+/)[0] || 'there');

  const starRow = `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:4px auto 0;"><tr>
    ${[1, 2, 3, 4, 5].map(n =>
      `<td style="padding:0 5px;"><a href="${reviewRatingUrl(token, n)}" target="_blank" style="text-decoration:none;font-size:38px;line-height:1;color:${T.accent};">&#9733;</a></td>`
    ).join('')}
  </tr></table>`;

  const scale = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:10px auto 0;max-width:280px;"><tr>
    <td style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${T.muted};text-align:left;">Not great</td>
    <td style="font-family:${MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${T.muted};text-align:right;">Loved it</td>
  </tr></table>`;

  const content = [
    heroSection({
      eyebrow: order_number ? `Order ${esc(order_number)}` : 'Your recent project',
      headline: 'How did we <em style="font-style:italic;">do</em>?',
      body: `${firstName} &mdash; thank you for choosing Roma Flooring Designs. We&rsquo;re a small team and your honest feedback genuinely helps us. Tap a star to let us know how it went &mdash; it takes about 15 seconds.`
    }),
    section(`${starRow}${scale}`, '0 40px 30px'),
    section(
      `<p style="margin:0;text-align:center;font-family:${SANS};font-size:12px;line-height:1.6;color:${T.muted};">If anything wasn&rsquo;t right, tell us directly &mdash; we&rsquo;d rather hear from you and make it right. Reply to this email or call ${PHONE}.</p>`,
      '0 40px 30px'
    )
  ].join('');

  return emailShell({
    title: 'How did we do?',
    preheader: 'Tap a star — your quick feedback means a lot to our team.',
    content
  });
}

// Short SMS body. Includes the STOP opt-out required for compliant messaging.
export function reviewSmsBody({ customer_name, token }) {
  const first = (customer_name || '').trim().split(/\s+/)[0] || 'there';
  return `Hi ${first}, thanks for choosing Roma Flooring Designs! How did we do? Tap to rate (about 15 sec): ${reviewRatingUrl(token)}\n\nReply STOP to opt out.`;
}

// ---------------------------------------------------------------------------
// Public landing pages (standalone HTML, noindex)
// ---------------------------------------------------------------------------

function publicPage({ title, inner }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} — Roma Flooring Designs</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,400&family=Inter:wght@400;500;600&display=swap');
  *{box-sizing:border-box;}
  body{margin:0;background:${T.inbox};font-family:${SANS};color:${T.ink};-webkit-font-smoothing:antialiased;}
  .wrap{max-width:520px;margin:0 auto;padding:44px 18px 56px;}
  .brand{text-align:center;font-family:${SERIF};letter-spacing:0.34em;font-size:20px;color:${T.ink};margin-bottom:22px;}
  .brand span{display:block;font-family:'Pinyon Script','Brush Script MT',${SERIF};letter-spacing:normal;font-size:26px;color:${T.accent};margin-top:-6px;}
  .card{background:${T.paper};padding:40px 30px;text-align:center;}
  h1{font-family:${SERIF};font-weight:300;font-size:34px;line-height:1.05;margin:0 0 14px;letter-spacing:-0.01em;}
  h1 em{font-style:italic;}
  p{font-size:15px;line-height:1.65;color:${T.body};margin:0 0 16px;}
  .stars{margin:8px 0 4px;}
  .stars a{font-size:46px;line-height:1;text-decoration:none;color:${T.accent};padding:0 5px;display:inline-block;}
  .scale{display:flex;justify-content:space-between;max-width:280px;margin:6px auto 0;font-family:${MONO};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:${T.muted};}
  .btn{display:block;width:100%;padding:16px 20px;margin:12px 0 0;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;border:0;cursor:pointer;}
  .btn-google{background:#1a73e8;color:#fff;}
  .btn-yelp{background:#d32323;color:#fff;}
  .btn-dark{background:${T.ink};color:${T.paper};}
  textarea{width:100%;min-height:130px;padding:12px 14px;border:1px solid ${T.border};font-family:inherit;font-size:14px;background:#fff;color:${T.ink};resize:vertical;}
  .foot{text-align:center;margin-top:22px;font-size:12px;color:${T.muted};line-height:1.6;}
  .eyebrow{font-family:${MONO};font-size:11px;font-weight:500;letter-spacing:0.2em;text-transform:uppercase;color:${T.accent};margin:0 0 14px;}
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">ROMA FLOORING<span>Designs</span></div>
  <div class="card">${inner}</div>
  <p class="foot">Roma Flooring Designs &middot; 1440 S. State College Blvd #6M, Anaheim, CA 92806 &middot; ${PHONE}</p>
</div>
</body>
</html>`;
}

// Star picker — shown when the customer opens the bare link (e.g. from SMS).
export function reviewStarPickerPage(token) {
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<a href="${reviewRatingUrl(token, n)}" aria-label="${n} star${n > 1 ? 's' : ''}">&#9733;</a>`
  ).join('');
  return publicPage({
    title: 'How did we do?',
    inner: `
      <p class="eyebrow">Roma Flooring Designs</p>
      <h1>How did we <em>do</em>?</h1>
      <p>Tap a star to rate your experience.</p>
      <div class="stars">${stars}</div>
      <div class="scale"><span>Not great</span><span>Loved it</span></div>
    `
  });
}

// High rating → invite to post publicly. Only providers with a configured URL
// get a button; the button routes through /go/:token/:provider so clicks are tracked.
export function reviewPublicThankYouPage({ token, hasGoogle, hasYelp }) {
  const t = encodeURIComponent(token);
  const buttons = [
    hasGoogle ? `<a class="btn btn-google" href="${SITE_URL}/api/reviews/go/${t}/google">Review us on Google</a>` : '',
    hasYelp ? `<a class="btn btn-yelp" href="${SITE_URL}/api/reviews/go/${t}/yelp">Review us on Yelp</a>` : ''
  ].filter(Boolean).join('');

  const body = buttons
    ? `<p>That&rsquo;s wonderful to hear &mdash; thank you! Would you take a moment to share your experience with others? It helps neighbors find us and means a great deal to our team.</p>${buttons}`
    : `<p>That&rsquo;s wonderful to hear &mdash; thank you! Your support means the world to our team.</p>`;

  return publicPage({
    title: 'Thank you!',
    inner: `
      <p class="eyebrow">Thank you</p>
      <h1>You made our <em>day</em>.</h1>
      ${body}
    `
  });
}

// Low rating → private feedback form (never shows public links). Submits via
// fetch JSON so no extra body-parser wiring is needed.
export function reviewPrivateFeedbackPage({ token, rating }) {
  const t = esc(token);
  return publicPage({
    title: 'We want to make this right',
    inner: `
      <p class="eyebrow">We&rsquo;re listening</p>
      <h1>Let&rsquo;s make it <em>right</em>.</h1>
      <p>Thank you for the honest rating. We&rsquo;d genuinely like to know what fell short so we can fix it. Your note goes straight to our team &mdash; not public anywhere.</p>
      <form id="fbform" onsubmit="return false;">
        <textarea id="fb" placeholder="What could we have done better?"></textarea>
        <button class="btn btn-dark" id="send" type="submit">Send feedback</button>
      </form>
      <p id="thanks" style="display:none;margin-top:18px;">Thank you &mdash; we&rsquo;ve got it and someone from our team will follow up.</p>
      <script>
        (function(){
          var form=document.getElementById('fbform');
          var btn=document.getElementById('send');
          form.addEventListener('submit',function(){
            btn.disabled=true;btn.textContent='Sending…';
            fetch('/api/reviews/r/${t}/feedback',{
              method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({feedback:document.getElementById('fb').value,rating:${Number(rating) || 0}})
            }).then(function(){
              form.style.display='none';
              document.getElementById('thanks').style.display='block';
            }).catch(function(){btn.disabled=false;btn.textContent='Send feedback';});
          });
        })();
      </script>
    `
  });
}

// Fallback page for expired/unknown tokens or a second visit.
export function reviewGenericThanksPage({ notFound } = {}) {
  return publicPage({
    title: notFound ? 'Link expired' : 'Thank you',
    inner: notFound
      ? `<p class="eyebrow">Roma Flooring Designs</p><h1>This link has <em>expired</em>.</h1><p>Thanks for your interest in sharing feedback. If you&rsquo;d still like to reach us, call ${PHONE} or email Sales@romaflooringdesigns.com.</p>`
      : `<p class="eyebrow">Thank you</p><h1>Thank <em>you</em>.</h1><p>We appreciate you taking the time.</p>`
  });
}
