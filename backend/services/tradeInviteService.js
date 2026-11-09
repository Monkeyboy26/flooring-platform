// Trade-invite automation: when a delivered order looks "pro" (company name on
// file or a contractor-sized total) and the customer has no trade account, queue
// the existing trade-invite email (templates/tradeInvite.js) with a personalized
// Silver-tier savings estimate computed from the order's actual lines.
//
// Mirrors reviewService.js: queue on the delivered hook → delayed send → 15-min
// sweep from server.js. One invite per customer EVER (unique index) — this is a
// single discreet nudge, not a drip campaign. The manual admin/rep "send invite"
// path is unaffected and stays available for anyone this misses.
//
// Safety posture matches reviews: master switch on, AUTO-QUEUE OFF by default.
// Opt in with TRADE_INVITE_AUTO_ENABLED=true once the messaging is approved.

import { pool } from '../db.js';
import { sendTradeInvite } from './emailService.js';
import { tradeTierPrice } from '../lib/tierPrice.js';

const ENABLED = process.env.TRADE_INVITES_ENABLED !== 'false';
const AUTO_ENABLED = process.env.TRADE_INVITE_AUTO_ENABLED === 'true';
const DELAY_HOURS = Math.max(0, parseFloat(process.env.TRADE_INVITE_DELAY_HOURS || '72'));
// An order at/above this total flags the buyer as a trade prospect even without
// a company name (homeowners rarely clear it; contractors routinely do).
const MIN_TOTAL = Math.max(0, parseFloat(process.env.TRADE_INVITE_MIN_TOTAL || '2000'));

export function tradeInvitesEnabled() { return ENABLED; }
export function autoTradeInviteEnabled() { return ENABLED && AUTO_ENABLED; }

/**
 * Estimate what the order's product lines would have cost at the lowest trade
 * tier, using the live tier formula against CURRENT pricing. The trade/retail
 * ratio is applied to what the customer actually paid per line, which sidesteps
 * box/unit basis conversions. Rep-negotiated lines already below trade price
 * contribute $0 (never negative). Returns a Number (may be 0) or null when
 * nothing on the order was priceable.
 */
export async function computeOrderTradeSavings(orderId) {
  const tier = await pool.query(
    'SELECT cost_multiplier, discount_percent FROM margin_tiers WHERE is_active = true ORDER BY tier_level LIMIT 1');
  if (!tier.rows.length) return null;
  const { cost_multiplier: mult, discount_percent: pct } = tier.rows[0];

  const items = await pool.query(
    `SELECT oi.subtotal, oi.unit_price, oi.cost AS line_cost,
            pr.retail_price, pr.cost, pr.price_basis, pr.retail_locked, cat.slug AS category_slug
       FROM order_items oi
       LEFT JOIN skus s ON s.id = oi.sku_id
       LEFT JOIN products p ON p.id = COALESCE(oi.product_id, s.product_id)
       LEFT JOIN categories cat ON cat.id = p.category_id
       LEFT JOIN pricing pr ON pr.sku_id = oi.sku_id
      WHERE oi.order_id = $1
        AND COALESCE(oi.is_sample, false) = false
        AND COALESCE(oi.item_type, 'product') <> 'labor'`, [orderId]);

  let savings = 0, priceable = 0;
  for (const it of items.rows) {
    const paid = parseFloat(it.subtotal) || 0;
    if (!(paid > 0)) continue;
    const retail = parseFloat(it.retail_price) || 0;
    if (retail > 0) {
      // Catalog line: exact tier formula on the current pricing row.
      const trade = tradeTierPrice({
        cost: it.cost, retail, priceBasis: it.price_basis, categorySlug: it.category_slug,
        costMultiplier: mult, fallbackDiscountPct: pct, retailLocked: it.retail_locked === true
      });
      if (trade == null) continue;
      priceable++;
      savings += Math.max(0, paid * (1 - trade / retail));
    } else {
      // Custom/off-catalog line: tier formula on the line's own cost/unit price.
      const unit = parseFloat(it.unit_price) || 0;
      const cost = parseFloat(it.line_cost) || 0;
      if (!(unit > 0) || !(cost > 0)) continue;
      priceable++;
      const trade = Math.min(unit, Math.max(cost * parseFloat(mult), cost + 1.50));
      savings += Math.max(0, paid * (1 - trade / unit));
    }
  }
  return priceable ? Math.round(savings) : null;
}

/**
 * Queue a trade invite off a delivered order. Eligibility: a linked retail
 * customer with no trade account, and either a company name on file (order or
 * customer) or an order total >= TRADE_INVITE_MIN_TOTAL. Idempotent per
 * CUSTOMER via the unique index — the first qualifying order wins, later ones
 * no-op. `order` is the full orders row (rep fields attached via attachRep).
 */
export async function queueTradeInvite(order, { createdBy = 'auto' } = {}) {
  if (!ENABLED) return { queued: false, reason: 'disabled' };
  if (!order || !order.id || !order.customer_id) return { queued: false, reason: 'no_customer' };
  if (order.trade_customer_id) return { queued: false, reason: 'already_trade' };
  if (!order.customer_email) return { queued: false, reason: 'no_email' };

  try {
    const c = await pool.query(
      'SELECT trade_customer_id, company_name, first_name FROM customers WHERE id = $1', [order.customer_id]);
    if (!c.rows.length) return { queued: false, reason: 'no_customer' };
    if (c.rows[0].trade_customer_id) return { queued: false, reason: 'already_trade' };

    const company = (order.company_name || c.rows[0].company_name || '').trim();
    const total = parseFloat(order.total) || 0;
    if (!company && total < MIN_TOTAL) return { queued: false, reason: 'not_qualified' };

    const [savings, oc] = await Promise.all([
      computeOrderTradeSavings(order.id),
      pool.query(
        `SELECT count(*)::int AS n FROM orders
          WHERE customer_id = $1 AND status NOT IN ('cancelled')
            AND created_at > CURRENT_TIMESTAMP - interval '12 months'`, [order.customer_id])
    ]);

    const r = await pool.query(
      `INSERT INTO trade_invites
         (customer_id, order_id, order_number, customer_name, customer_email, company_name,
          order_total, savings_estimate, order_count, rep_email, rep_first_name, rep_last_name,
          status, send_after, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'scheduled',
               CURRENT_TIMESTAMP + make_interval(hours => $13), $14)
       ON CONFLICT (customer_id) DO NOTHING
       RETURNING id`,
      [order.customer_id, order.id, order.order_number || null,
       order.customer_name || c.rows[0].first_name || null, order.customer_email,
       company || null, total || null, savings, oc.rows[0].n,
       order.rep_email || null, order.rep_first_name || null, order.rep_last_name || null,
       DELAY_HOURS, createdBy]);

    if (!r.rows.length) return { queued: false, reason: 'already_invited' };
    console.log(`[TradeInvite] queued for ${order.customer_email} (order ${order.order_number}, est. savings $${savings ?? '—'})`);
    return { queued: true, id: r.rows[0].id, savings };
  } catch (err) {
    console.error('[TradeInvite] queue failed:', err.message);
    return { queued: false, reason: err.message };
  }
}

/** Send one queued invite and record the outcome. Re-checks the customer at
 *  send time — if they applied for trade in the interim, skip silently. */
export async function sendQueuedTradeInvite(row) {
  try {
    const c = await pool.query('SELECT trade_customer_id FROM customers WHERE id = $1', [row.customer_id]);
    if (!c.rows.length || c.rows[0].trade_customer_id) {
      await pool.query(
        `UPDATE trade_invites SET status = 'skipped', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
      return { sent: false, skipped: true };
    }

    const res = await sendTradeInvite({
      name: row.customer_name || '',
      email: row.customer_email,
      order_count: row.order_count || undefined,
      savings_estimate: row.savings_estimate != null ? parseFloat(row.savings_estimate) : undefined,
      order_number: row.order_number || undefined,
      rep_email: row.rep_email || undefined,
      rep_first_name: row.rep_first_name || undefined,
      rep_last_name: row.rep_last_name || undefined
    });
    const sent = !!(res && res.sent);
    await pool.query(
      `UPDATE trade_invites
          SET status = $1, sent_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE sent_at END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $3`, [sent ? 'sent' : 'failed', sent, row.id]);
    return { sent };
  } catch (err) {
    console.error('[TradeInvite] send failed:', err.message);
    try {
      await pool.query(`UPDATE trade_invites SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
    } catch {}
    return { sent: false };
  }
}

/** Poll for due invites and send them. Started on an interval from server.js. */
export async function processDueTradeInvites() {
  if (!ENABLED) return;
  try {
    const due = await pool.query(
      `SELECT * FROM trade_invites
        WHERE status = 'scheduled' AND send_after <= CURRENT_TIMESTAMP
        ORDER BY send_after ASC LIMIT 25`);
    for (const row of due.rows) await sendQueuedTradeInvite(row);
    if (due.rows.length) console.log(`[TradeInvite] processed ${due.rows.length} due invite(s)`);
  } catch (err) {
    console.error('[TradeInvite] poller error:', err.message);
  }
}
