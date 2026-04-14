import { Router } from 'express';

const ALLOWED_EVENT_TYPES = new Set([
  'page_view', 'product_view', 'add_to_cart', 'remove_from_cart', 'checkout_started',
  'order_completed', 'search', 'filter_toggle', 'sort_change', 'category_select',
  'collection_select', 'wishlist_add', 'wishlist_remove', 'sample_request',
  'trade_signup_start', 'trade_signup_complete', 'trade_login', 'customer_login',
  'quick_view_open', 'image_gallery', 'scroll_depth', 'time_on_page',
  'cart_drawer_open', 'page_change'
]);

export default function createAnalyticsRoutes(ctx) {
  const router = Router();
  const { pool } = ctx;

  router.post('/api/analytics/event', (req, res) => {
    res.json({ ok: true });
    setImmediate(async () => {
      try {
        const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 50) : [];
        if (events.length === 0) return;
        const values = [];
        const params = [];
        let idx = 1;
        for (const evt of events) {
          if (!evt.event_type || !ALLOWED_EVENT_TYPES.has(evt.event_type)) continue;
          values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5})`);
          params.push(evt.session_id || null, evt.visitor_id || null, evt.event_type,
            JSON.stringify(evt.properties || {}), evt.page_path || null, evt.referrer || null);
          idx += 6;
        }
        if (values.length === 0) return;
        await pool.query(
          `INSERT INTO analytics_events (session_id, visitor_id, event_type, properties, page_path, referrer)
           VALUES ${values.join(', ')}`,
          params
        );
      } catch (err) { console.error('[Analytics] Event insert error:', err.message); }
    });
  });

  router.post('/api/analytics/session', (req, res) => {
    res.json({ ok: true });
    setImmediate(async () => {
      try {
        const { session_id, visitor_id, user_agent, referrer, device_type, utm_source, utm_medium, utm_campaign } = req.body;
        if (!session_id) return;
        await pool.query(`
          INSERT INTO analytics_sessions (session_id, visitor_id, user_agent, referrer, device_type, utm_source, utm_medium, utm_campaign)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (session_id) DO UPDATE SET
            last_seen_at = CURRENT_TIMESTAMP,
            page_count = analytics_sessions.page_count + 1
        `, [session_id, visitor_id || null, user_agent || null, referrer || null,
            device_type || null, utm_source || null, utm_medium || null, utm_campaign || null]);
      } catch (err) { console.error('[Analytics] Session upsert error:', err.message); }
    });
  });

  return router;
}
