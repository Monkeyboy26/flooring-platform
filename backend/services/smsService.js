// Lightweight SMS sender via the Twilio REST API.
//
// Deliberately dependency-free — it uses the global fetch (Node 18+) and HTTP
// Basic auth rather than the `twilio` SDK, so no new package needs installing
// or bundling into the API image. Mirrors emailService's contract: it silently
// no-ops when unconfigured so callers never have to guard, and every send
// returns { sent: boolean, ... } instead of throwing.
//
// Configure with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM
// (an E.164 number you own on Twilio, e.g. +17149990009, or a Messaging
// Service SID beginning with "MG").

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const SMS_ENABLED = !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);

if (SMS_ENABLED) {
  console.log(`[SMS] Twilio configured (from ${TWILIO_FROM})`);
} else {
  console.log('[SMS] Not configured — SMS will be skipped. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM to enable.');
}

export function smsConfigured() {
  return SMS_ENABLED;
}

// Best-effort normalization of a US/CA phone number to E.164 (+1XXXXXXXXXX).
// Returns null when it can't confidently format — callers skip those rather
// than risk a mis-dial.
export function toE164(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 ? '+' + digits : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

/**
 * Send a single SMS. Never throws — returns { sent, ... } so it can be awaited
 * fire-and-forget alongside email.
 */
export async function sendSms(to, body) {
  if (!SMS_ENABLED) {
    console.log(`[SMS] Skipping SMS to ${to} — not configured`);
    return { sent: false, skipped: true };
  }
  const e164 = toE164(to);
  if (!e164) {
    console.log(`[SMS] Skipping SMS — unparseable number: ${to}`);
    return { sent: false, error: 'bad_number' };
  }
  try {
    const form = new URLSearchParams({ To: e164, Body: body });
    // A Messaging Service SID (MG...) uses MessagingServiceSid; a plain number uses From.
    if (/^MG[0-9a-f]{32}$/i.test(TWILIO_FROM)) form.set('MessagingServiceSid', TWILIO_FROM);
    else form.set('From', TWILIO_FROM);

    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.error(`[SMS] Twilio error ${resp.status} sending to ${e164}: ${txt.slice(0, 240)}`);
      return { sent: false, error: `twilio_${resp.status}` };
    }
    const data = await resp.json().catch(() => ({}));
    console.log(`[SMS] Sent to ${e164} (sid ${data.sid || '?'})`);
    return { sent: true, sid: data.sid };
  } catch (err) {
    console.error(`[SMS] Failed to send to ${e164}:`, err.message);
    return { sent: false, error: err.message };
  }
}
