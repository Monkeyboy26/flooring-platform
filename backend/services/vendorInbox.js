// Vendor inbox automation — vendors email the purchasing inbox when an order
// leaves their warehouse ("picked up" / BOL / shipped). This service polls that
// inbox, matches each confirmation to an open PO (RDP-xxxxx), and advances the
// platform automatically along the owner's mapping:
//   • store pickup  → PO items received → order lines ready → ready_for_pickup
//                     (existing receive rails; customer "ready" email/SMS fires)
//   • will_call     → the CUSTOMER collected at the distributor → delivered
//   • shipping      → carrier collected the freight → shipped (+ tracking if
//                     the email contains one, else a high-priority rep task)
//
// Safety posture (this sends real customer email/SMS):
//   - keyword screen first, then a gpt-4o-mini classification; act only on
//     event picked_up/shipped with confidence >= MIN_CONFIDENCE
//   - PO matched by exact RDP number, or by vendor sender-domain ONLY when that
//     vendor has exactly one open PO
//   - only ever moves forward: PO must be sent/acknowledged, order
//     confirmed/ready_for_pickup; everything else is recorded, never acted on
//   - every message is journaled in vendor_inbox_events (unique message_id =
//     idempotency); every action logs to po_activity_log/order activity and
//     notifies the assigned rep
//   - mailbox is opened read-only; human read/unread state is never touched
//   - VENDOR_INBOX_DRY_RUN=1 records what WOULD happen without doing it
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import OpenAI from 'openai';
import { pool } from '../db.js';
import { logOrderActivity, recalculateCommission } from '../lib/orderHelpers.js';
import { createRepNotification, createAutoTask } from '../lib/notifications.js';
import { sendOrderStatusUpdate } from './emailService.js';
import { sendOrderStatusSms } from './orderSmsService.js';
import { queueReviewRequest, autoReviewEnabled } from './reviewService.js';
import { queueTradeInvite, autoTradeInviteEnabled } from './tradeInviteService.js';

const DRY_RUN = () => process.env.VENDOR_INBOX_DRY_RUN === '1';
const MIN_CONFIDENCE = parseFloat(process.env.VENDOR_INBOX_MIN_CONFIDENCE || '0.8');
const LOOKBACK_DAYS = parseInt(process.env.VENDOR_INBOX_LOOKBACK_DAYS || '3', 10);
const MAX_MESSAGES_PER_POLL = 200;

const PO_NUMBER_RE = /\bRDP[-\s]?(\d{3,6})\b/gi;
// Cheap pre-screen before spending an LLM call: logistics vocabulary a pickup/
// ship confirmation would plausibly contain.
const LOGISTICS_RE = /\b(picked? ?up|pick ?up|will ?call|bol\b|bill of lading|shipped|shipment|in transit|tracking|pro ?(number|#)|freight|carrier|released to|out for delivery|ready for (pick ?up|collection))\b/i;

export function getInboxAccounts() {
  // VENDOR_INBOX_ACCOUNTS='[{"host":"imap.gmail.com","user":"a@x.com","pass":"..."}]'
  // overrides; otherwise reuse the SMTP (Gmail app-password) credentials, which
  // grant IMAP on the same account.
  if (process.env.VENDOR_INBOX_ACCOUNTS) {
    try {
      const list = JSON.parse(process.env.VENDOR_INBOX_ACCOUNTS);
      return (Array.isArray(list) ? list : []).filter(a => a && a.user && a.pass);
    } catch (e) {
      console.error('[VendorInbox] VENDOR_INBOX_ACCOUNTS is not valid JSON:', e.message);
      return [];
    }
  }
  const user = process.env.VENDOR_INBOX_USER || process.env.SMTP_USER;
  const pass = process.env.VENDOR_INBOX_PASS || process.env.SMTP_PASS;
  if (!user || !pass) return [];
  return [{ host: process.env.VENDOR_INBOX_HOST || 'imap.gmail.com', user, pass }];
}

export function vendorInboxEnabled() {
  if (process.env.VENDOR_INBOX_ENABLED === '0') return false;
  return getInboxAccounts().length > 0;
}

function extractPoNumbers(text) {
  const found = new Set();
  for (const m of String(text || '').matchAll(PO_NUMBER_RE)) found.add('RDP-' + m[1]);
  return [...found];
}

function senderDomain(addr) {
  const m = String(addr || '').toLowerCase().match(/@([a-z0-9.-]+)/);
  return m ? m[1] : null;
}

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Classify a screened-in email. Returns { event, po_numbers, tracking_number,
 * carrier, confidence } — event is one of picked_up | shipped |
 * ready_at_vendor | acknowledgment | invoice | other.
 */
export async function classifyVendorEmail(msg) {
  const body = String(msg.text || '').slice(0, 6000);
  const resp = await getOpenAI().chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'system',
      content: `You classify emails arriving at the purchasing inbox of a flooring retailer. The retailer sends purchase orders numbered like RDP-10123 to material vendors/distributors. Vendor emails are easily confused with each other — classify by what PHYSICALLY happened to the goods, not by tone or attachments.

Respond with JSON: {"event": "picked_up"|"shipped"|"ready_at_vendor"|"acknowledgment"|"payment_confirmation"|"invoice"|"backorder"|"other", "po_numbers": ["RDP-..."], "tracking_number": string|null, "carrier": string|null, "confidence": 0..1}

Definitions — the first two are the ONLY ones that mean goods have left the vendor:
- "picked_up": goods WERE COLLECTED from the vendor (by the retailer, a freight carrier, or the end customer). Signals: "was picked up", "has been picked up", BOL signed, "released to", pickup completed.
- "shipped": a carrier HAS the freight / it is in transit. Signals: "has shipped", tracking/PRO number issued, "left our warehouse", "in transit".
- "ready_at_vendor": goods are staged/ready at the vendor but NOT yet collected ("ready for pickup", "will call ready", "available for pickup"). NOT a pickup confirmation.
- "acknowledgment": vendor confirms they RECEIVED the order ("order confirmation", "we received your PO", sales order created, ETA given). Nothing has moved.
- "payment_confirmation": a payment/credit card was processed, receipt, "thank you for your payment". Nothing about goods moving.
- "invoice": an invoice/statement is attached or referenced. Invoices often arrive around pickup time but an invoice ALONE says nothing about goods moving.
- "backorder": items delayed/out of stock/ETA pushed.
- "other": marketing, price lists, everything else.

Examples:
- "Your order S123 / PO RDP-10140 has been picked up. BOL attached." → picked_up
- "RDP-10135 is ready for will call at our Anaheim branch." → ready_at_vendor (NOT picked_up)
- "Thank you for your payment of $671.88 on PO RDP-10112." → payment_confirmation (NOT picked_up, even if it mentions the PO)
- "Order Confirmation: we have received your purchase order RDP-10150, ETA 11/20." → acknowledgment
- "Invoice INV-4452 for PO RDP-10134 attached." → invoice
- "Your shipment is on its way — PRO 889912345, estimated delivery Thursday." → shipped

If an email mixes signals (e.g. invoice attached AND says goods were picked up), classify by the goods movement (picked_up) — but lower confidence if the movement language is indirect. Include any RDP numbers you find. confidence reflects how certain you are of the event classification; use < 0.8 whenever the movement of goods is implied rather than stated.`
    }, {
      role: 'user',
      content: `From: ${msg.from}\nSubject: ${msg.subject}\n\n${body}`
    }]
  });
  const parsed = JSON.parse(resp.choices[0].message.content);
  return {
    event: String(parsed.event || 'other'),
    po_numbers: Array.isArray(parsed.po_numbers) ? parsed.po_numbers.map(p => String(p).toUpperCase().replace(/\s+/g, '')) : [],
    tracking_number: parsed.tracking_number ? String(parsed.tracking_number).trim() : null,
    carrier: parsed.carrier ? String(parsed.carrier).trim() : null,
    confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0))
  };
}

/**
 * Resolve the email to exactly one open PO (status sent/acknowledged).
 * Prefers explicit RDP numbers (regex + classifier); falls back to the sender
 * domain when that vendor has exactly one open PO. Returns { po, matched_by }
 * or { po: null, reason }.
 */
async function resolveOpenPo(db, msg, classification) {
  const numbers = [...new Set([...extractPoNumbers(msg.subject + ' ' + msg.text), ...classification.po_numbers])];
  if (numbers.length) {
    const r = await db.query(
      `SELECT po.*, v.name AS vendor_name FROM purchase_orders po
       JOIN vendors v ON v.id = po.vendor_id
       WHERE po.po_number = ANY($1) AND po.status IN ('sent', 'acknowledged')`,
      [numbers]
    );
    if (r.rows.length === 1) return { po: r.rows[0], matched_by: 'po_number' };
    if (r.rows.length > 1) return { po: null, reason: `multiple open POs matched (${r.rows.map(p => p.po_number).join(', ')})` };
    return { po: null, reason: `no open PO for ${numbers.join(', ')}` };
  }
  const domain = senderDomain(msg.from);
  if (!domain) return { po: null, reason: 'no PO number and unparseable sender' };
  const r = await db.query(
    `SELECT po.*, v.name AS vendor_name FROM purchase_orders po
     JOIN vendors v ON v.id = po.vendor_id
     WHERE po.status IN ('sent', 'acknowledged') AND (
       LOWER(v.email) LIKE '%@' || $1
       OR EXISTS (SELECT 1 FROM vendor_contacts vc WHERE vc.vendor_id = v.id AND LOWER(vc.email) LIKE '%@' || $1)
     )`,
    [domain]
  );
  if (r.rows.length === 1) return { po: r.rows[0], matched_by: 'vendor_domain' };
  return { po: null, reason: r.rows.length ? `vendor domain ${domain} has ${r.rows.length} open POs — ambiguous` : `no vendor/open PO for domain ${domain}` };
}

// All non-sample material lines fully received? (same gate assertOrderTransition uses)
async function allLinesReceived(db, orderId) {
  const r = await db.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE oi.qty_received IS NOT NULL AND oi.qty_received + 0.001 >= oi.num_boxes)::int AS received
    FROM order_items oi
    WHERE oi.order_id = $1 AND NOT COALESCE(oi.is_sample, false)
      AND COALESCE(oi.item_type, 'material') <> 'labor'`, [orderId]);
  const { total, received } = r.rows[0];
  return total > 0 && received === total;
}

async function fallbackRepId(db, orderRepId) {
  if (orderRepId) return orderRepId;
  const r = await db.query("SELECT id FROM staff_accounts WHERE is_active = true AND role = 'sales_rep' ORDER BY created_at LIMIT 1");
  return r.rows.length ? r.rows[0].id : null;
}

/**
 * Apply a confirmed vendor-pickup event: mark the PO's items received (which
 * drives order-line readiness and the pickup auto-advance through the existing
 * rails), then advance the ORDER when every line is in:
 * shipping → shipped, will_call → delivered, pickup → handled by the rails.
 * Returns a short action string for the event journal.
 */
export async function applyVendorPickup(po, msg, classification, deps) {
  const client = await pool.connect();
  let readySync = { changed: false };
  let orderRow = null;
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [po.id]);
    if (!locked.rows.length || !['sent', 'acknowledged'].includes(locked.rows[0].status)) {
      await client.query('ROLLBACK');
      return 'skipped: PO no longer open';
    }
    if (po.order_id) {
      const o = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [po.order_id]);
      orderRow = o.rows[0] || null;
      if (orderRow && ['cancelled', 'refunded', 'delivered'].includes(orderRow.status)) {
        await client.query('ROLLBACK');
        return `skipped: order is ${orderRow.status}`;
      }
    }

    await client.query(
      `UPDATE purchase_order_items SET status = 'received' WHERE purchase_order_id = $1 AND status NOT IN ('received', 'cancelled')`,
      [po.id]
    );
    const allItems = await client.query('SELECT status FROM purchase_order_items WHERE purchase_order_id = $1', [po.id]);
    const fulfilled = allItems.rows.length > 0 && allItems.rows.every(r => r.status === 'received');
    if (fulfilled) {
      await client.query("UPDATE purchase_orders SET status = 'fulfilled', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [po.id]);
    }
    await client.query(
      `INSERT INTO po_activity_log (purchase_order_id, action, performer_name, details)
       VALUES ($1, 'vendor_pickup_email', 'Vendor Inbox', $2)`,
      [po.id, JSON.stringify({
        message_id: msg.messageId, from: msg.from, subject: msg.subject,
        event: classification.event, tracking_number: classification.tracking_number,
        carrier: classification.carrier, confidence: classification.confidence
      })]
    );
    if (po.order_id) readySync = await deps.syncOrderReadyFromPoReceipts(client, po.order_id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  // Existing rail: pickup order fully in → ready_for_pickup email/SMS/commission.
  if (po.order_id) deps.firePickupAdvanceEffects(readySync, po.order_id);

  let action = `PO ${po.po_number} items received${readySync.changed ? `; order → ${readySync.newStatus}` : ''}`;
  if (!po.order_id || !orderRow) return action;

  // Re-read post-sync state and advance the order where the rails don't.
  const fresh = (await pool.query('SELECT * FROM orders WHERE id = $1', [po.order_id])).rows[0];
  if (!fresh) return action;
  const repId = await fallbackRepId(pool, fresh.sales_rep_id);

  if (fresh.sales_rep_id) {
    setImmediate(() => createRepNotification(pool, fresh.sales_rep_id, 'po_items_received',
      `Vendor confirms pickup — PO ${po.po_number}`,
      `${po.vendor_name || 'Vendor'} emailed that ${fresh.order_number}'s material left their warehouse (auto-processed).`,
      'order', po.order_id));
  }

  if (fresh.status !== 'confirmed') return action;
  if (!(await allLinesReceived(pool, po.order_id))) {
    return action + '; order waiting on other lines';
  }

  if (fresh.delivery_method === 'shipping') {
    // ACH still clearing → never auto-ship; hand it to the rep instead.
    const pend = await deps.unsettledPaymentInfo(po.order_id, pool);
    if (pend.unsettled) {
      if (repId) {
        await createAutoTask(pool, repId, 'vendor_shipped_hold', po.order_id,
          `Vendor shipped ${fresh.order_number} but a bank payment is still clearing — ship it once settled`,
          { priority: 'high', customer_name: fresh.customer_name, linked_order_id: po.order_id });
      }
      return action + '; NOT auto-shipped (ACH clearing)';
    }
    const tracking = classification.tracking_number;
    const upd = await pool.query(
      `UPDATE orders SET status = 'shipped', shipped_at = NOW(),
        tracking_number = COALESCE($2, tracking_number), shipping_carrier = COALESCE($3, shipping_carrier)
       WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [po.order_id, tracking, classification.carrier]
    );
    if (!upd.rows.length) return action;
    const order = upd.rows[0];
    await logOrderActivity(pool, po.order_id, 'status_changed', null, 'Vendor Inbox',
      { from: 'confirmed', to: 'shipped', auto: 'vendor_pickup_email', po_number: po.po_number, ...(tracking ? { tracking_number: tracking, carrier: classification.carrier } : {}) });
    setImmediate(async () => {
      await deps.attachRep(order);
      sendOrderStatusUpdate(order, 'shipped'); sendOrderStatusSms(order, 'shipped');
    });
    setImmediate(() => deps.autoGenerateAndSendInvoice(po.order_id));
    setImmediate(() => recalculateCommission(pool, po.order_id));
    if (!tracking && repId) {
      await createAutoTask(pool, repId, 'fulfillment_no_tracking', po.order_id,
        `Add tracking number for ${order.order_number} — auto-marked shipped from ${po.vendor_name || 'vendor'}'s email, which had no tracking`,
        { priority: 'high', customer_name: order.customer_name, linked_order_id: po.order_id });
    }
    return action + `; order ${order.order_number} → shipped${tracking ? ' (tracking ' + tracking + ')' : ' (no tracking in email — task filed)'}`;
  }

  if (fresh.delivery_method === 'will_call') {
    // Customer collected at the distributor — the order is complete.
    const upd = await pool.query(
      `UPDATE orders SET status = 'delivered', delivered_at = NOW() WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [po.order_id]
    );
    if (!upd.rows.length) return action;
    const order = upd.rows[0];
    await logOrderActivity(pool, po.order_id, 'status_changed', null, 'Vendor Inbox',
      { from: 'confirmed', to: 'delivered', auto: 'vendor_pickup_email', po_number: po.po_number });
    setImmediate(async () => {
      await deps.attachRep(order);
      sendOrderStatusUpdate(order, 'delivered'); sendOrderStatusSms(order, 'delivered');
      if (autoReviewEnabled()) queueReviewRequest(order, { createdBy: 'auto' });
      if (autoTradeInviteEnabled()) queueTradeInvite(order, { createdBy: 'auto' });
    });
    setImmediate(() => recalculateCommission(pool, po.order_id));
    if (repId) {
      await createAutoTask(pool, repId, 'order_delivered', po.order_id,
        `Post-delivery follow-up — ${order.customer_name} (${order.order_number})`,
        { priority: 'low', customer_name: order.customer_name, customer_email: order.customer_email, linked_order_id: po.order_id });
    }
    return action + `; order ${order.order_number} → delivered (will-call pickup)`;
  }

  return action;
}

// "Ready at vendor" is informational: no status change, but the rep should go
// collect it (or send the customer for will-call).
async function handleReadyAtVendor(po, msg, deps) {
  if (!po.order_id) return 'ready_at_vendor noted (no linked order)';
  const o = (await pool.query('SELECT * FROM orders WHERE id = $1', [po.order_id])).rows[0];
  if (!o || !['confirmed', 'pending'].includes(o.status)) return 'ready_at_vendor noted';
  const repId = await fallbackRepId(pool, o.sales_rep_id);
  if (repId) {
    await createAutoTask(pool, repId, 'vendor_ready_at_vendor', po.order_id,
      `${po.vendor_name || 'Vendor'} says PO ${po.po_number} is ready — ${o.delivery_method === 'will_call' ? 'send the customer to collect it' : 'schedule the pickup'} (${o.order_number})`,
      { priority: 'high', customer_name: o.customer_name, linked_order_id: po.order_id });
  }
  return 'ready_at_vendor — rep task filed';
}

async function fetchRecentMessages(account) {
  const client = new ImapFlow({
    host: account.host || 'imap.gmail.com',
    port: account.port || 993,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false
  });
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);
  const messages = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    try {
      const uids = await client.search({ since }, { uid: true });
      const recent = (uids || []).slice(-MAX_MESSAGES_PER_POLL);
      for (const uid of recent) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        messages.push({
          uid,
          messageId: parsed.messageId || `${account.user}:${uid}:${parsed.date ? parsed.date.getTime() : 'na'}`,
          from: parsed.from ? parsed.from.text : '',
          subject: parsed.subject || '',
          date: parsed.date || null,
          text: (parsed.text || '').trim() || String(parsed.html || '').replace(/<[^>]+>/g, ' ')
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return messages;
}

/**
 * Poll every configured inbox once. deps must provide the server.js-scoped
 * helpers: { syncOrderReadyFromPoReceipts, firePickupAdvanceEffects, attachRep,
 * unsettledPaymentInfo, autoGenerateAndSendInvoice }.
 */
export async function pollVendorInboxes(deps) {
  const summary = { accounts: 0, fetched: 0, new: 0, screened: 0, acted: 0, errors: [] };
  for (const account of getInboxAccounts()) {
    summary.accounts++;
    let messages;
    try {
      messages = await fetchRecentMessages(account);
    } catch (err) {
      console.error(`[VendorInbox] ${account.user}: fetch failed — ${err.message}`);
      summary.errors.push(`${account.user}: ${err.message}`);
      continue;
    }
    summary.fetched += messages.length;
    for (const msg of messages) {
      try {
        // Claim by message_id — a prior poll (or the other account seeing the
        // same thread) already handled it.
        const claim = await pool.query(
          `INSERT INTO vendor_inbox_events (account, message_id, from_addr, subject, received_at, action)
           VALUES ($1, $2, $3, $4, $5, 'ignored') ON CONFLICT (message_id) DO NOTHING RETURNING id`,
          [account.user, msg.messageId, msg.from.slice(0, 300), msg.subject.slice(0, 500), msg.date]
        );
        if (!claim.rows.length) continue;
        summary.new++;
        const eventId = claim.rows[0].id;

        // Screen: skip our own outbound/internal mail, require logistics signal.
        const ownDomain = senderDomain(msg.from) === 'romaflooringdesigns.com';
        const hasPoNumber = extractPoNumbers(msg.subject + ' ' + msg.text).length > 0;
        const looksLogistics = LOGISTICS_RE.test(msg.subject + ' ' + msg.text);
        if (ownDomain || (!hasPoNumber && !looksLogistics)) continue;
        summary.screened++;

        const classification = await classifyVendorEmail(msg);
        const { po, matched_by, reason } = await resolveOpenPo(pool, msg, classification);
        let action;
        if (!po) {
          action = `no action: ${reason}`;
        } else if (!['picked_up', 'shipped', 'ready_at_vendor'].includes(classification.event)) {
          action = `no action: event=${classification.event}`;
        } else if (DRY_RUN()) {
          // Fully read-only (journal aside): report what a live run would do.
          action = classification.confidence < MIN_CONFIDENCE
            ? `DRY RUN: would file review task — ${classification.event} at low confidence ${classification.confidence} for ${po.po_number}`
            : `DRY RUN: would process event=${classification.event} for ${po.po_number} (matched by ${matched_by})`;
        } else if (classification.confidence < MIN_CONFIDENCE) {
          action = `no action: low confidence ${classification.confidence}`;
          // A shaky picked_up/shipped goes to a human; a shaky ready_at_vendor
          // is usually a newsletter that pattern-matched — journal only
          // (backtest: Goton marketing classified ready_at_vendor@0.7).
          if (['picked_up', 'shipped'].includes(classification.event)) {
            const o = po.order_id ? (await pool.query('SELECT * FROM orders WHERE id = $1', [po.order_id])).rows[0] : null;
            const repId = await fallbackRepId(pool, o ? o.sales_rep_id : null);
            if (repId && o) {
              await createAutoTask(pool, repId, 'vendor_email_review', po.order_id,
                `Review vendor email for PO ${po.po_number} — looks like a pickup/ship confirmation ("${msg.subject.slice(0, 80)}")`,
                { priority: 'high', customer_name: o.customer_name, linked_order_id: po.order_id });
              action += ' — review task filed';
            }
          }
        } else if (classification.event === 'ready_at_vendor') {
          action = await handleReadyAtVendor(po, msg, deps);
        } else {
          action = await applyVendorPickup(po, msg, classification, deps);
          summary.acted++;
        }

        await pool.query(
          `UPDATE vendor_inbox_events SET snippet = $2, classification = $3, purchase_order_id = $4, order_id = $5, action = $6 WHERE id = $1`,
          [eventId, msg.text.slice(0, 1000), JSON.stringify({ ...classification, matched_by: matched_by || null }), po ? po.id : null, po ? po.order_id : null, action.slice(0, 500)]
        );
        if (action && !action.startsWith('no action')) console.log(`[VendorInbox] ${msg.subject.slice(0, 60)} → ${action}`);
      } catch (err) {
        console.error(`[VendorInbox] message "${(msg.subject || '').slice(0, 60)}" failed:`, err.message);
        summary.errors.push(`${msg.messageId}: ${err.message}`);
      }
    }
  }
  return summary;
}
