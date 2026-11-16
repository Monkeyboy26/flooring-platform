import { Router } from 'express';

// Crawlers execute the storefront JS and fire real analytics beacons — GoogleOther
// alone posted ~640 sessions on 2026-09-28 and showed up as a fake traffic spike in
// the admin dashboard. Checked against the request header (not the client-reported
// body value) so a spoofed payload can't sneak past. Clarity/GA4 filter these
// upstream; this keeps our first-party numbers comparable.
const BOT_UA_RE = /bot|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|pingdom|gtmetrix|prerender|screaming frog|facebookexternalhit|embedly|quora link preview|outbrain|vkshare|w3c_validator|googleother|google-inspectiontool|mediapartners-google|apis-google|feedfetcher|python-requests|python-urllib|aiohttp|httpx|axios|node-fetch|go-http-client|curl\/|wget\/|phantomjs|puppeteer|playwright|selenium|lightpanda/i;

function isBotRequest(req) {
  const headerUa = req.headers['user-agent'] || '';
  const bodyUa = typeof req.body?.user_agent === 'string' ? req.body.user_agent : '';
  return BOT_UA_RE.test(headerUa) || BOT_UA_RE.test(bodyUa);
}

const ALLOWED_EVENT_TYPES = new Set([
  'page_view', 'product_view', 'add_to_cart', 'remove_from_cart', 'checkout_started',
  'order_completed', 'search', 'filter_toggle', 'sort_change', 'category_select',
  'collection_select', 'wishlist_add', 'wishlist_remove', 'sample_request', 'sample_request_started',
  'trade_signup_start', 'trade_signup_complete', 'trade_login', 'customer_login',
  'quick_view_open', 'image_gallery', 'scroll_depth', 'time_on_page',
  'cart_drawer_open', 'page_change'
]);

// The 2026-11-08..13 Meta/IG catalog re-crawl rendered the SPA with plain-Chrome
// UAs (plus Lightpanda) that no UA regex can catch — ~29K fake sessions in 6 days,
// each firing the session beacon and leaving before the event batch flushed. So a
// session row is only persisted once its first real event batch arrives; bare
// session pings park here and evaporate if no events ever follow. Per-process map
// is fine: single API container (see CLAUDE.md Caching). A restart drops pending
// pings, which at worst loses the session row for a visitor mid-first-page —
// events still insert (they never required a session row).
const pendingSessions = new Map(); // session_id -> { params, pings, ts }
const PENDING_TTL_MS = 60 * 60 * 1000;
const PENDING_MAX = 20000; // bound memory under a crawl storm

function sweepPendingSessions() {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [id, p] of pendingSessions) {
    if (p.ts < cutoff) pendingSessions.delete(id);
  }
  if (pendingSessions.size >= PENDING_MAX) {
    // Still over cap after TTL sweep (crawl storm) — drop oldest first.
    const ids = [...pendingSessions.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [id] of ids.slice(0, pendingSessions.size - PENDING_MAX + 1)) pendingSessions.delete(id);
  }
}

export default function createAnalyticsRoutes(ctx) {
  const router = Router();
  const { pool } = ctx;

  // page_count: a fresh insert carries the accumulated ping count from the pending
  // map; the conflict path is the per-ping increment the old upsert always did.
  async function upsertSession(params, insertPageCount) {
    await pool.query(`
      INSERT INTO analytics_sessions (session_id, visitor_id, user_agent, referrer, device_type, utm_source, utm_medium, utm_campaign, customer_id, trade_customer_id, ip, page_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (session_id) DO UPDATE SET
        last_seen_at = CURRENT_TIMESTAMP,
        page_count = analytics_sessions.page_count + 1,
        customer_id = COALESCE(EXCLUDED.customer_id, analytics_sessions.customer_id),
        trade_customer_id = COALESCE(EXCLUDED.trade_customer_id, analytics_sessions.trade_customer_id)
    `, [...params, insertPageCount]);
  }

  router.post('/api/analytics/event', (req, res) => {
    res.json({ ok: true });
    if (isBotRequest(req)) return;
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
        // First real events for a parked session → persist its row now.
        const eventSessionIds = [...new Set(events.map(e => e.session_id).filter(Boolean))];
        for (const sid of eventSessionIds) {
          const pending = pendingSessions.get(sid);
          if (!pending) continue;
          pendingSessions.delete(sid);
          await upsertSession(pending.params, pending.pings);
        }
        // Mark a session converted when it produces a real funnel outcome. This is
        // an offline-closed business — a web order is rare, so sample requests and
        // trade signups ARE the conversion signal; counting only order_completed
        // undercounted conversions ~4x. Channel/referrer lives on the session row,
        // so this is what makes "which channel converts" answerable.
        const CONVERSION_EVENTS = new Set(['order_completed', 'sample_request', 'trade_signup_complete']);
        const convertedSessions = [...new Set(events
          .filter(e => CONVERSION_EVENTS.has(e.event_type) && e.session_id)
          .map(e => e.session_id))];
        if (convertedSessions.length > 0) {
          await pool.query(
            `UPDATE analytics_sessions SET is_converted = true WHERE session_id = ANY($1) AND is_converted = false`,
            [convertedSessions]
          );
        }
      } catch (err) { console.error('[Analytics] Event insert error:', err.message); }
    });
  });

  router.post('/api/analytics/session', (req, res) => {
    res.json({ ok: true });
    if (isBotRequest(req)) return;
    setImmediate(async () => {
      try {
        const { session_id, visitor_id, user_agent, referrer, device_type, utm_source, utm_medium, utm_campaign, customer_id, trade_customer_id } = req.body;
        if (!session_id) return;
        // Identity columns are UUID — only accept well-formed values so a stray
        // client payload can't break the insert. Stamped once the visitor is known
        // (logged in) and RETAINED via COALESCE so a later anonymous ping on the
        // same session can't null it back out.
        const uuid = v => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) ? v : null;
        // First X-Forwarded-For hop — nginx sets it, trust proxy is on (server.js).
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null;
        const sessionParams = [session_id, visitor_id || null, user_agent || null, referrer || null,
            device_type || null, utm_source || null, utm_medium || null, utm_campaign || null,
            uuid(customer_id), uuid(trade_customer_id), ip];
        const pending = pendingSessions.get(session_id);
        if (pending) {
          pending.pings += 1;
          pending.params = sessionParams;
          pending.ts = Date.now();
          return;
        }
        const existing = await pool.query('SELECT 1 FROM analytics_sessions WHERE session_id = $1', [session_id]);
        if (existing.rowCount > 0) {
          await upsertSession(sessionParams, 1); // conflict path: page_count + 1
          return;
        }
        sweepPendingSessions();
        pendingSessions.set(session_id, { params: sessionParams, pings: 1, ts: Date.now() });
      } catch (err) { console.error('[Analytics] Session upsert error:', err.message); }
    });
  });

  return router;
}
