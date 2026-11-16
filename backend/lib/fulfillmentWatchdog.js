// Fulfillment watchdog — detects orders whose tracking/fulfillment steps are
// overdue and turns them into rep tasks + a staff digest email. The admin
// orders ledger (/api/admin/orders/ledger) computes similar risk states but is
// pull-only; this is the push side, run daily by the cron in server.js and on
// demand via POST /api/admin/fulfillment-watchdog/run.
import { createAutoTask } from './notifications.js';

const DAY_MS = 86400000;

// Thresholds in days before a state counts as overdue.
export const WATCHDOG_THRESHOLDS = {
  stuck_pending: 3,   // paid (deposit or more) but never confirmed
  no_pos: 1,          // confirmed with zero purchase orders
  po_draft: 2,        // draft PO never sent to the vendor
  po_unacked: 3,      // PO sent, vendor never acknowledged
  no_tracking: 1,     // marked shipped (shipping order) with no tracking number
  stale_transit: 14,  // shipped long ago, never marked delivered
  pickup_stale: 7     // ready for pickup, customer never came
};

const ISSUE_DEFS = {
  fulfillment_stuck_pending: {
    label: 'Paid but never confirmed',
    task: (o, d) => `Confirm order ${o.order_number} — payment landed ${d}d ago, still pending`,
    priority: 'high'
  },
  fulfillment_no_pos: {
    label: 'Confirmed with no purchase orders',
    task: (o, d) => `Source material for ${o.order_number} — confirmed ${d}d ago, nothing on order with vendors`,
    priority: 'high'
  },
  fulfillment_po_draft: {
    label: 'Draft PO never sent',
    task: (o, d) => `Send draft PO${o.draft_pos > 1 ? 's' : ''} for ${o.order_number} — drafted ${d}d ago, vendor has not been told`,
    priority: 'high'
  },
  fulfillment_po_unacked: {
    label: 'Vendor has not confirmed PO',
    task: (o, d) => `Chase vendor confirmation for ${o.order_number} — PO sent ${d}d ago with no acknowledgment`,
    priority: 'medium'
  },
  fulfillment_no_tracking: {
    label: 'Shipped with no tracking number',
    task: (o, d) => `Add tracking number for ${o.order_number} — marked shipped ${d}d ago, customer cannot track it`,
    priority: 'high'
  },
  fulfillment_stale_transit: {
    label: 'In transit too long — verify delivery',
    task: (o, d) => `Verify delivery of ${o.order_number} — shipped ${d}d ago and never marked delivered`,
    priority: 'medium'
  },
  fulfillment_pickup_stale: {
    label: 'Ready for pickup, not collected',
    task: (o, d) => `Nudge ${o.customer_name || 'customer'} to pick up ${o.order_number} — staged ${d}d ago`,
    priority: 'medium'
  }
};

// Display order for the digest: internal-bottleneck items first (we can fix
// those today), customer/vendor-waiting items after.
export const ISSUE_ORDER = [
  'fulfillment_no_tracking', 'fulfillment_po_draft', 'fulfillment_stuck_pending',
  'fulfillment_no_pos', 'fulfillment_po_unacked', 'fulfillment_stale_transit',
  'fulfillment_pickup_stale'
];

/**
 * Scan open orders and return the list of overdue fulfillment issues.
 * Each issue: { type, label, order_id, order_number, customer_name, rep_name,
 * sales_rep_id, overdue_days, task_title, priority }.
 */
export async function collectFulfillmentIssues(pool) {
  const r = await pool.query(`
    SELECT o.id, o.order_number, o.customer_name, o.customer_email, o.status,
      o.delivery_method, o.amount_paid, o.total, o.tracking_number,
      o.created_at, o.confirmed_at, o.shipped_at, o.sales_rep_id,
      sr.first_name || ' ' || sr.last_name as rep_name,
      COALESCE(po.total_pos, 0) as total_pos,
      COALESCE(po.draft_pos, 0) as draft_pos,
      COALESCE(po.unacked_pos, 0) as unacked_pos,
      po.oldest_draft, po.oldest_unacked,
      items.last_ready_at
    FROM orders o
    LEFT JOIN staff_accounts sr ON sr.id = o.sales_rep_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int as total_pos,
        COUNT(*) FILTER (WHERE p.status = 'draft')::int as draft_pos,
        COUNT(*) FILTER (WHERE p.status = 'sent' AND p.edi_ack_status IS NULL)::int as unacked_pos,
        MIN(p.created_at) FILTER (WHERE p.status = 'draft') as oldest_draft,
        MIN(COALESCE(p.approved_at, p.created_at)) FILTER (WHERE p.status = 'sent' AND p.edi_ack_status IS NULL) as oldest_unacked
      FROM purchase_orders p WHERE p.order_id = o.id AND p.status != 'cancelled'
    ) po ON true
    LEFT JOIN LATERAL (
      SELECT MAX(oi.ready_at) as last_ready_at FROM order_items oi WHERE oi.order_id = o.id
    ) items ON true
    WHERE o.status IN ('pending', 'confirmed', 'ready_for_pickup', 'shipped')
    ORDER BY o.created_at
  `);

  const days = ts => ts ? (Date.now() - new Date(ts).getTime()) / DAY_MS : 0;
  const T = WATCHDOG_THRESHOLDS;
  const issues = [];
  const add = (type, o, overdueSince) => {
    const d = Math.floor(days(overdueSince));
    const def = ISSUE_DEFS[type];
    issues.push({
      type, label: def.label, priority: def.priority,
      order_id: o.id, order_number: o.order_number,
      customer_name: o.customer_name, rep_name: o.rep_name, sales_rep_id: o.sales_rep_id,
      overdue_days: d, task_title: def.task(o, d)
    });
  };

  for (const o of r.rows) {
    if (o.status === 'pending') {
      // Unpaid pending orders are abandoned checkouts, not fulfillment work.
      if (parseFloat(o.amount_paid || 0) > 0 && days(o.created_at) > T.stuck_pending) {
        add('fulfillment_stuck_pending', o, o.created_at);
      }
      continue;
    }
    if (o.draft_pos > 0 && days(o.oldest_draft) > T.po_draft) {
      add('fulfillment_po_draft', o, o.oldest_draft);
    }
    if (o.unacked_pos > 0 && days(o.oldest_unacked) > T.po_unacked) {
      add('fulfillment_po_unacked', o, o.oldest_unacked);
    }
    if (o.status === 'confirmed' && o.total_pos === 0 && days(o.confirmed_at || o.created_at) > T.no_pos) {
      add('fulfillment_no_pos', o, o.confirmed_at || o.created_at);
    }
    if (o.status === 'shipped') {
      const since = o.shipped_at || o.created_at;
      if (o.delivery_method !== 'pickup' && !(o.tracking_number || '').trim() && days(since) > T.no_tracking) {
        add('fulfillment_no_tracking', o, since);
      }
      if (days(since) > T.stale_transit) {
        add('fulfillment_stale_transit', o, since);
      }
    }
    if (o.status === 'ready_for_pickup' && days(o.last_ready_at || o.created_at) > T.pickup_stale) {
      add('fulfillment_pickup_stale', o, o.last_ready_at || o.created_at);
    }
  }

  issues.sort((a, b) =>
    ISSUE_ORDER.indexOf(a.type) - ISSUE_ORDER.indexOf(b.type) || b.overdue_days - a.overdue_days);
  return issues;
}

/**
 * Run the watchdog: collect issues, file an auto-task for each on the order's
 * rep (idempotent — the rep_tasks unique index makes repeat runs no-ops), and
 * send the digest email when anything is overdue. `sendDigest` is injected so
 * this module stays import-cycle-free with emailService.
 */
export async function runFulfillmentWatchdog(pool, { sendDigest } = {}) {
  const issues = await collectFulfillmentIssues(pool);
  let tasksCreated = 0;
  for (const i of issues) {
    if (!i.sales_rep_id) continue;
    const task = await createAutoTask(pool, i.sales_rep_id, i.type, i.order_id, i.task_title, {
      priority: i.priority,
      customer_name: i.customer_name,
      linked_order_id: i.order_id
    });
    if (task) tasksCreated++;
  }
  if (issues.length && typeof sendDigest === 'function') {
    await sendDigest(issues);
  }
  return { issues, tasksCreated };
}
