/**
 * Shadow-mode competitive repricing engine.
 *
 * Reads confirmed competitor observations (competitor_prices) and, for each SKU,
 * proposes a new retail that undercuts the cheapest reputable in-stock competitor
 * by 1%. Price follows the competitor; COST is treated as the negotiable lever
 * (Kian rule 2026-11-12): our stored book/list cost does NOT block competing —
 * when it's too high to make margin at the competitive price we still propose the
 * price and emit a "negotiate cost to $X" action for a rep call. Only MAP is a
 * hard (legal) floor. Below-cost proposals are flagged and never auto-applied.
 *
 * Posture (owner decision 2026-11-12):
 *   - Reference = Home Depot / Lowe's EVERYDAY price (non-sale). Liquidators and
 *     flash sales are deliberately ignored — "lowest among names people trust".
 *   - Also RAISES when we sit below reference-$0.10 (recover left-behind margin).
 *   - Floor conflict => hold at floor + flag for review.
 *
 * Mirrors the charm-rounding + floor rules in scrapers/base.js upsertPricing so a
 * later re-scrape won't fight the engine. SHADOW MODE by default: writes proposals
 * to reprice_proposals, never touches pricing. Pass { apply:true } to write prices
 * (not wired to any cron yet — manual, deliberate).
 *
 * CLI: docker compose exec api node scrapers/competitor/engine.js [--apply] [--vendor=MSI] [--limit=N]
 */

import { randomUUID } from 'node:crypto';

// --- tunables -------------------------------------------------------------
const UNDERCUT_PCT = 0.01;   // undercut the reference by this fraction (owner 2026-11-12: 1%, not a flat $0.10)
const UNDERCUT_ABS = 0.00;   // optional hard floor on the undercut in $ (0 = pure percentage)
const RETAIL_MIN_MARGIN = 1.50;   // standard covering floor (base.js)
const MOSAIC_MIN_MARGIN = 4.50;   // per-sheet mosaic/stacked-stone floor (base.js)
const MAX_MOVE_PCT = 0.25;        // clamp any single reprice to +/-25% of current, then flag
const STALE_DAYS = 14;            // ignore competitor observations older than this

// Reference competitor set: only these feed the anchor (big-box everyday posture).
// Widen here (e.g. add 'floor_decor') to change the posture — engine stays the same.
const REFERENCE_COMPETITORS = ['home_depot', 'lowes', 'ferguson', 'stone_tile_shoppe'];

// --- charm/floor helpers (copied from base.js so behavior is identical) ----
// Largest value ending in 9 that is <= v (round DOWN; guarantees we stay under
// the competitor). Integer cents avoid float drift; floored at $0.09.
function nineDown(v) {
  const cents = Math.round(Number(v) * 100);
  const k = Math.floor((cents - 9) / 10);
  return Math.max(9, k * 10 + 9) / 100;
}
// Smallest 9-ending >= floor (what base.js uses for coveringFloorValue).
function nineUp(floor) {
  let n = nineDown(floor);
  if (floor > 0 && n < floor - 1e-9) n = Math.round((n + 0.10) * 100) / 100;
  return n;
}
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export async function run(pool, job, source, opts = {}) {
  const apply = !!opts.apply;
  const vendorFilter = opts.vendor || null;
  const limit = opts.limit ? Number(opts.limit) : null;
  const runId = randomUUID();

  // Pull every SKU that has at least one CONFIRMED, in-stock, fresh observation
  // from a reference competitor. Aggregate to the cheapest everyday price + which
  // competitor set it. per_sqyd (carpet) and $0/unknown-cost rows are skipped —
  // competitors rarely list carpet by our unit and a margin can't be computed.
  const staleCutoff = new Date(Date.now() - STALE_DAYS * 86400e3).toISOString();
  const { rows } = await pool.query(
    `WITH ranked AS (
       SELECT cp.sku_id, cp.everyday_price, cp.competitor,
              -- Reputability tiers: big-box > Ferguson/Build > specialty e-tailer.
              -- The anchor prefers the most reputable price available, not merely
              -- the cheapest, so the undercut stays defensible (owner 2026-11-13).
              CASE cp.competitor WHEN 'home_depot' THEN 1 WHEN 'lowes' THEN 1
                                 WHEN 'ferguson' THEN 2 ELSE 3 END AS tier
       FROM competitor_prices cp
       WHERE cp.match_status = 'confirmed'
         AND cp.in_stock IS DISTINCT FROM false
         AND cp.everyday_price > 0
         AND cp.scraped_at >= $1
         AND cp.competitor = ANY($2)
     ), ref AS (
       SELECT DISTINCT ON (sku_id) sku_id, everyday_price AS ref_price, competitor AS ref_competitor
       FROM ranked ORDER BY sku_id, tier ASC, everyday_price ASC
     )
     SELECT s.id AS sku_id, s.variant_name, p.name AS product_name, v.code AS vendor_code,
            pr.cost, pr.retail_price, pr.price_basis, pr.map_price, pr.retail_locked,
            s.variant_type,
            ref.ref_price, ref.ref_competitor
     FROM ref
     JOIN skus s ON s.id = ref.sku_id
     JOIN products p ON p.id = s.product_id
     JOIN vendors v ON v.id = p.vendor_id
     JOIN pricing pr ON pr.sku_id = s.id
     WHERE pr.cost > 0
       AND COALESCE(pr.price_basis,'per_sqft') <> 'per_sqyd'
       ${vendorFilter ? 'AND v.code = $3' : ''}
     ${limit ? `LIMIT ${limit}` : ''}`,
    vendorFilter ? [staleCutoff, REFERENCE_COMPETITORS, vendorFilter]
                 : [staleCutoff, REFERENCE_COMPETITORS]
  );

  const proposals = [];
  for (const r of rows) {
    const cost = Number(r.cost);
    const current = Number(r.retail_price);
    const ref = Number(r.ref_price);
    const isMosaicSheet = r.variant_type === 'mosaic' && (r.price_basis === 'per_unit' || r.price_basis == null);
    const minMargin = isMosaicSheet ? MOSAIC_MIN_MARGIN : RETAIL_MIN_MARGIN;

    // --- Price follows the competitor; COST is the negotiable lever ----------
    // Kian rule (2026-11-12): do NOT treat our stored (book/list) cost as a hard
    // price floor. MSI/Daltile reps routinely move cost so we can make margin
    // UNDER the big-box price ("see $8, call the rep, it's $5"). So we always
    // propose the HD-undercut price and output the COST we'd need to negotiate to
    // in order to keep the minimum margin. The ONLY hard floor is MAP (legal).
    const hardFloor = (r.map_price != null) ? nineUp(Number(r.map_price)) : 0;
    const mapBound = hardFloor > 0;

    // retail_locked (hand-matched) rows are left alone — recorded for visibility.
    if (r.retail_locked) {
      proposals.push(mkProposal(runId, r, current, ref, current, hardFloor || null,
        'locked', false, 'retail_locked — manual price preserved'));
      continue;
    }

    // Competitive target: undercut reference, charm-round DOWN (stays under), but
    // never below MAP (we don't break MAP even if a competitor does).
    const undercut = Math.max(UNDERCUT_ABS, ref * UNDERCUT_PCT);
    let target = nineDown(ref - undercut);
    let action, flagged = false, reason = null;

    if (mapBound && target < hardFloor - 1e-9) {
      target = hardFloor;
      flagged = true;
      reason = `competitive target below MAP $${hardFloor.toFixed(2)} — pinned at MAP (legal floor)`;
    }

    // Cost we'd need to hit the minimum margin at the competitive price. If our
    // book cost is above it, the price still stands — we route a "call the rep"
    // cost target instead of refusing to compete.
    const requiredCost = round2(target - minMargin);
    const marginNow = round2(target - cost);
    if (cost > requiredCost + 1e-9) {
      flagged = true;
      const tag = `NEGOTIATE COST: to undercut ${r.ref_competitor} $${ref.toFixed(2)} at $${target.toFixed(2)} keeping $${minMargin.toFixed(2)} margin, move cost $${cost.toFixed(2)} → ≤ $${requiredCost.toFixed(2)} (book-list likely; margin at current cost would be $${marginNow.toFixed(2)})`;
      reason = reason ? `${reason} | ${tag}` : tag;
    }

    // Flag (not clamp) large moves so a human looks before any apply.
    if (current > 0 && Math.abs(target - current) > current * MAX_MOVE_PCT) {
      flagged = true;
      const tag = `large move ${(100 * (target - current) / current).toFixed(0)}% — review before apply`;
      reason = reason ? `${reason} | ${tag}` : tag;
    }

    if (target < current - 0.01) action = 'cut';
    else if (target > current + 0.01) action = 'raise';
    else action = 'hold';

    proposals.push(mkProposal(runId, r, current, ref, target, requiredCost, action, flagged, reason));
  }

  // Persist proposals (durable shadow-mode record / audit trail).
  for (const p of proposals) {
    await pool.query(
      `INSERT INTO reprice_proposals
         (run_id, sku_id, current_price, reference_competitor, reference_price,
          target_price, floor_price, action, flagged, flag_reason, applied)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [p.run_id, p.sku_id, p.current_price, p.reference_competitor, p.reference_price,
       p.target_price, p.floor_price, p.action, p.flagged, p.flag_reason, apply && (p.action === 'cut' || p.action === 'raise')]
    );
  }

  // Apply mode: write targets for actionable, non-flagged proposals only. Flagged
  // = needs-cost-negotiation (would sell below book cost), MAP-pinned, or a large
  // move — all need a human before the price is written, so they never auto-apply.
  let applied = 0;
  if (apply) {
    for (const p of proposals) {
      if ((p.action === 'cut' || p.action === 'raise') && !p.flagged) {
        await pool.query(`UPDATE pricing SET retail_price = $2 WHERE sku_id = $1`, [p.sku_id, p.target_price]);
        applied++;
      }
    }
  }

  const summary = summarize(proposals);
  console.log(`\n=== Reprice run ${runId} ${apply ? '(APPLIED)' : '(SHADOW)'} ===`);
  console.log(`SKUs evaluated: ${proposals.length}`);
  console.table(summary.byAction);
  console.log(`Flagged for review: ${summary.flagged}`);
  if (apply) console.log(`Prices written: ${applied}`);
  console.log(`Query proposals: SELECT * FROM reprice_proposals WHERE run_id = '${runId}';`);
  return { runId, evaluated: proposals.length, applied, summary };
}

function mkProposal(run_id, r, current_price, reference_price, target_price, floor_price, action, flagged, flag_reason) {
  return {
    run_id, sku_id: r.sku_id,
    current_price, reference_competitor: r.ref_competitor, reference_price,
    target_price, floor_price, action, flagged, flag_reason,
  };
}

function summarize(proposals) {
  const by = {};
  let flagged = 0;
  for (const p of proposals) {
    by[p.action] = by[p.action] || { action: p.action, count: 0, avg_change: 0 };
    by[p.action].count++;
    by[p.action].avg_change += (p.target_price - p.current_price);
    if (p.flagged) flagged++;
  }
  const byAction = Object.values(by).map(a => ({
    action: a.action, count: a.count,
    avg_change: a.count ? Number((a.avg_change / a.count).toFixed(2)) : 0,
  }));
  return { byAction, flagged };
}

if (process.argv[1] && process.argv[1].endsWith('engine.js')) {
  const argv = process.argv.slice(2);
  const opts = {
    apply: argv.includes('--apply'),
    vendor: (argv.find(a => a.startsWith('--vendor=')) || '').split('=')[1] || null,
    limit: (argv.find(a => a.startsWith('--limit=')) || '').split('=')[1] || null,
  };
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || process.env.DB_PASS || 'postgres',
  });
  try {
    await run(pool, null, null, opts);
  } finally {
    await pool.end();
  }
}
