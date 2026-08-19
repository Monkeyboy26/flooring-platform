// Valor Connect (cloud) client — drives the physical VP800 countertop terminal
// through Valor's cloud. Flow: check the device is online, then POST a "publish"
// which BLOCKS while the customer taps their card and returns the full result
// inline (up to ~120s). Card data never touches our servers (PCI stays on the
// terminal); we only record what Valor returns (TXN_ID / RRN / masked PAN /
// brand). See [[valor-terminal-instore]] memory + the Valor Connect API docs.
//
// Credentials + hosts come from env so nothing sensitive lives in code:
//   VALOR_APP_ID        merchant App ID (32 chars, from Valor Portal → API Keys)
//   VALOR_APP_KEY       per-device App Key (32 chars, generated for the EPI)
//   VALOR_EPI           terminal endpoint id (10 digits, e.g. 2501459891)
//   VALOR_SECURELINK_URL  publish/status host (PROD host from Valor before go-live)
//   VALOR_STATUS_URL      device-status host (PROD host from Valor before go-live)
// The URL defaults are Valor's documented UAT/staging hosts so the code runs in
// dev; they must be pointed at the production hosts to reach a real device.

const APP_ID = process.env.VALOR_APP_ID || '';
const APP_KEY = process.env.VALOR_APP_KEY || '';
const EPI = process.env.VALOR_EPI || '';
const SECURELINK_URL = (process.env.VALOR_SECURELINK_URL || 'https://securelink-staging.valorpaytech.com').replace(/\/+$/, '');
const STATUS_URL = (process.env.VALOR_STATUS_URL || 'https://demo.valorpaytech.com').replace(/\/+$/, '');

// The synchronous publish holds the connection open while the customer taps.
// Valor's documented ceiling is 120s; give ourselves a small margin.
const TAP_TIMEOUT_MS = 125000;

export function configured() {
  return !!(APP_ID && APP_KEY && EPI);
}

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// Look up our device on the Valor account. Returns { isOnline, channelId }.
// channel_id is required to publish; isOnline guards against a dead terminal.
export async function deviceStatus() {
  const { json } = await fetchJson(`${STATUS_URL}/api/vc/devices/status`, {
    method: 'GET',
    headers: { appid: APP_ID, appkey: APP_KEY },
  }, 15000);
  const devices = (json && json.devices) || [];
  const dev = devices.find(d => String(d.EPI) === String(EPI));
  if (!dev) throw new Error(`terminal EPI ${EPI} not found on the Valor account`);
  return { isOnline: String(dev.isOnline) === '1', channelId: dev.channel_id };
}

// Publish a SALE to the terminal and wait for the tap result (blocks ~≤120s).
// TRAN_MODE 1 / TRAN_CODE 1 = credit sale (the only publicly documented pair;
// void/refund codes come from Valor's POS Integration PDF — not wired yet).
export async function publishSale({ amountCents, reqTxnId, channelId }) {
  const body = {
    appid: APP_ID,
    appkey: APP_KEY,
    epi: EPI,
    txn_type: 'vc_publish',
    channel_id: channelId,
    version: '1',
    payload: {
      TRAN_MODE: '1',
      TRAN_CODE: '1',
      AMOUNT: String(amountCents),
      REQ_TXN_ID: String(reqTxnId).slice(0, 25),
    },
  };
  const { json } = await fetchJson(`${SECURELINK_URL}/?status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, TAP_TIMEOUT_MS);
  return json;
}

// Recovery only: if the publish connection dropped, fetch the outcome by the
// same REQ_TXN_ID so we never lose a completed sale.
export async function txnStatus(reqTxnId) {
  const body = {
    appid: APP_ID,
    appkey: APP_KEY,
    epi: EPI,
    txn_type: 'vc_status',
    req_txn_id: String(reqTxnId).slice(0, 25),
  };
  const { json } = await fetchJson(`${SECURELINK_URL}/?txn_status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 20000);
  return json;
}

// Normalize a Valor Connect response into the card_txn shape our order flows
// already persist (see normalizeValorTxn in server.js). tran_no carries the
// Valor TXN_ID (the real transaction id), last4 is derived from the masked PAN.
export function toCardTxn(resp) {
  const r = (resp && resp.response) || {};
  if (String(r.STATE) === '0') {
    const masked = String(r.MASKED_PAN || '');
    return {
      approved: true,
      card_txn: {
        state: '0',
        tran_no: r.TXN_ID != null ? String(r.TXN_ID) : (r.TRAN_NO != null ? String(r.TRAN_NO) : ''),
        rrn: r.RRN || '',
        masked_pan: masked,
        last4: masked.replace(/\D/g, '').slice(-4),
        brand: r.ISSUER || '',
        auth_text: r.AUTH_RSP_TEXT || '',
        code: r.CODE || '',
        amount_cents: r.AMOUNT || '',
        date: r.DATE || '',
      },
    };
  }
  const err = r.ERROR_MSG || (resp && (resp.desc || resp.msg || resp.mesg)) || 'Terminal declined or cancelled the transaction';
  return { approved: false, error: err };
}

export { EPI };
