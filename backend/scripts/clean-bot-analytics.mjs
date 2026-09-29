/**
 * Clean bot traffic out of first-party analytics and re-roll daily stats.
 *
 * Context: crawlers that execute the storefront JS (GoogleOther posted ~640
 * sessions on 2026-09-28 alone) fire real /api/analytics beacons and inflate
 * the admin dashboard's views. The ingest endpoint now drops bot UAs
 * (backend/routes/analytics.js BOT_UA_RE — keep the regex here in sync);
 * this script removes what already landed and recomputes analytics_daily_stats
 * for the affected dates using the same aggregation as the 7 AM cron.
 *
 * Deleted rows are copied to analytics_sessions_bot_backup / analytics_events_bot_backup
 * tables first, so the operation is reversible.
 *
 * Usage:
 *   node backend/scripts/clean-bot-analytics.mjs            # dry run (default)
 *   node backend/scripts/clean-bot-analytics.mjs --apply    # delete + re-roll
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Mirror of BOT_UA_RE in backend/routes/analytics.js, as a Postgres regex.
const BOT_UA_SQL = String.raw`bot|crawl|spider|slurp|scrape|headless|lighthouse|pagespeed|pingdom|gtmetrix|prerender|screaming frog|facebookexternalhit|embedly|quora link preview|outbrain|vkshare|w3c_validator|googleother|google-inspectiontool|mediapartners-google|apis-google|feedfetcher|python-requests|python-urllib|aiohttp|httpx|axios|node-fetch|go-http-client|curl/|wget/|phantomjs|puppeteer|playwright|selenium`;

async function main() {
  const bots = await pool.query(
    `SELECT session_id FROM analytics_sessions WHERE user_agent ~* $1`, [BOT_UA_SQL]);
  const ids = bots.rows.map(r => r.session_id);
  console.log(`Bot sessions matched: ${ids.length}`);
  if (ids.length === 0) { await pool.end(); return; }

  const evCount = await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(created_at)::date AS lo, MAX(created_at)::date AS hi
     FROM analytics_events WHERE session_id = ANY($1)`, [ids]);
  console.log(`Bot events attached: ${evCount.rows[0].n} (${evCount.rows[0].lo} .. ${evCount.rows[0].hi})`);

  const dates = await pool.query(
    `SELECT DISTINCT created_at::date AS d FROM analytics_events WHERE session_id = ANY($1)
     UNION SELECT DISTINCT first_seen_at::date FROM analytics_sessions WHERE session_id = ANY($1)
     ORDER BY 1`, [ids]);
  const affected = dates.rows.map(r => r.d.toISOString().slice(0, 10));
  console.log(`Affected dates: ${affected.join(', ')}`);

  if (!APPLY) {
    const byUa = await pool.query(
      `SELECT LEFT(user_agent, 90) AS ua, COUNT(*)::int AS n FROM analytics_sessions
       WHERE session_id = ANY($1) GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, [ids]);
    console.table(byUa.rows);
    console.log('\nDry run — re-run with --apply to delete + re-roll.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS analytics_sessions_bot_backup (LIKE analytics_sessions INCLUDING DEFAULTS)`);
    await client.query(`CREATE TABLE IF NOT EXISTS analytics_events_bot_backup (LIKE analytics_events INCLUDING DEFAULTS)`);
    const bs = await client.query(
      `INSERT INTO analytics_sessions_bot_backup SELECT * FROM analytics_sessions WHERE session_id = ANY($1) RETURNING 1`, [ids]);
    const be = await client.query(
      `INSERT INTO analytics_events_bot_backup SELECT * FROM analytics_events WHERE session_id = ANY($1) RETURNING 1`, [ids]);
    const de = await client.query(`DELETE FROM analytics_events WHERE session_id = ANY($1)`, [ids]);
    const ds = await client.query(`DELETE FROM analytics_sessions WHERE session_id = ANY($1)`, [ids]);
    console.log(`Backed up ${bs.rowCount} sessions / ${be.rowCount} events; deleted ${ds.rowCount} sessions / ${de.rowCount} events.`);

    // Re-roll each affected date — same math as the daily cron in server.js.
    for (const day of affected) {
      const dayStart = day + 'T00:00:00';
      const dayEnd = day + 'T23:59:59.999';
      const eventCounts = await client.query(`
        SELECT event_type, COUNT(*)::int as cnt FROM analytics_events
        WHERE created_at >= $1 AND created_at <= $2 GROUP BY event_type`, [dayStart, dayEnd]);
      const ec = {};
      eventCounts.rows.forEach(r => { ec[r.event_type] = r.cnt; });
      const ss = (await client.query(`
        SELECT COUNT(*)::int as total_sessions,
               COUNT(DISTINCT visitor_id)::int as unique_visitors,
               AVG(EXTRACT(EPOCH FROM (last_seen_at - first_seen_at)))::int as avg_duration,
               COUNT(*) FILTER (WHERE page_count <= 1)::numeric / NULLIF(COUNT(*), 0) * 100 as bounce_rate
        FROM analytics_sessions WHERE first_seen_at >= $1 AND first_seen_at <= $2`, [dayStart, dayEnd])).rows[0] || {};
      const ca = (await client.query(`
        SELECT COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'add_to_cart')::int as cart_sessions,
               COUNT(DISTINCT session_id) FILTER (WHERE event_type = 'order_completed')::int as order_sessions
        FROM analytics_events WHERE created_at >= $1 AND created_at <= $2`, [dayStart, dayEnd])).rows[0] || {};
      const cartAbandonRate = ca.cart_sessions > 0
        ? parseFloat(((ca.cart_sessions - ca.order_sessions) / ca.cart_sessions * 100).toFixed(2)) : 0;
      const topSearches = await client.query(`
        SELECT LOWER(properties->>'query') as term, COUNT(*)::int as count
        FROM analytics_events WHERE event_type = 'search' AND created_at >= $1 AND created_at <= $2
          AND properties->>'query' IS NOT NULL AND properties->>'query' != ''
        GROUP BY LOWER(properties->>'query') ORDER BY count DESC LIMIT 20`, [dayStart, dayEnd]);
      // Revenue/searches/etc. come from the same sources as the cron; revenue is
      // orders-table based and unaffected by bot deletion, so keep the stored value.
      await client.query(`
        UPDATE analytics_daily_stats SET
          total_sessions = $2, unique_visitors = $3, page_views = $4, product_views = $5,
          add_to_carts = $6, checkouts_started = $7, orders_completed = $8, searches = $9,
          sample_requests = $10, trade_signups = $11, avg_session_duration_secs = $12,
          bounce_rate = $13, cart_abandonment_rate = $14, top_search_terms = $15
        WHERE stat_date = $1`, [
        day,
        ss.total_sessions || 0,
        ss.unique_visitors || 0,
        ec.page_view || 0,
        ec.product_view || 0,
        ec.add_to_cart || 0,
        ec.checkout_started || 0,
        ec.order_completed || 0,
        ec.search || 0,
        ec.sample_request || 0,
        ec.trade_signup_complete || 0,
        ss.avg_duration || 0,
        parseFloat(ss.bounce_rate || 0).toFixed(2),
        cartAbandonRate,
        JSON.stringify(topSearches.rows),
      ]);
      console.log(`Re-rolled ${day}: sessions ${ss.total_sessions || 0}, page_views ${ec.page_view || 0}`);
    }
    await client.query('COMMIT');
    console.log('Done.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
