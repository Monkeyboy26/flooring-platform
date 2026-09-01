// Quality audit runner — executes conformance rules and diffs results against
// the quality_violations table.
//
// Lifecycle per fingerprint:
//   new finding            -> insert as 'open'
//   still present          -> last_seen bumped (status untouched, waived stays waived)
//   previously 'fixed'     -> reopened to 'open'
//   open but gone this run -> auto-closed as 'fixed'
//
// Scoped runs (vendorId set) only touch that vendor's violations, so a
// post-scrape MSI run can't close open Emser findings.

import crypto from 'crypto';
import { RULES } from './rules.js';

function fingerprintOf(ruleKey, v) {
  const entity = v.sku_id || v.product_id || v.vendor_id || '';
  return crypto.createHash('md5')
    .update(`${ruleKey}|${entity}|${v.discriminator || ''}`)
    .digest('hex');
}

export function listRules() {
  return RULES.map(r => ({ key: r.key, title: r.title, severity: r.severity, heavy: !!r.heavy }));
}

export async function runQualityAudit(pool, opts = {}) {
  const { vendorId = null, triggeredBy = 'manual', checkImages = false, imageLimit = null, ruleKeys = null } = opts;

  const scopeLabel = vendorId ? `vendor:${vendorId}` : 'all';
  const runRow = await pool.query(
    `INSERT INTO quality_runs (scope, triggered_by) VALUES ($1, $2) RETURNING id`,
    [scopeLabel, triggeredBy]
  );
  const runId = runRow.rows[0].id;

  try {
    const rules = RULES
      .filter(r => (checkImages ? true : !r.heavy))
      .filter(r => (ruleKeys ? ruleKeys.includes(r.key) : true));

    const exemptRes = await pool.query(`SELECT rule_key, vendor_id FROM quality_exemptions`);
    const exempt = new Set(exemptRes.rows.map(r => `${r.rule_key}|${r.vendor_id}`));

    // Run rules sequentially — each is one heavy SQL query; parallelism would
    // just contend for pool connections. A rule that throws (e.g. statement
    // timeout) must NOT abort the whole audit: previously one slow rule aborted
    // the run before the auto-close step, so resolved violations never cleared.
    // Failed rules are recorded and EXCLUDED from auto-close below — leaving
    // their existing violations untouched rather than mass-closing them.
    const findings = [];
    const failedKeys = [];
    for (const rule of rules) {
      let results;
      try {
        results = await rule.run(pool, { vendorId, imageLimit });
      } catch (ruleErr) {
        failedKeys.push(rule.key);
        console.error(`[Quality] rule '${rule.key}' failed, skipping: ${ruleErr.message}`);
        continue;
      }
      for (const v of results) {
        if (v.vendor_id && exempt.has(`${rule.key}|${v.vendor_id}`)) continue;
        findings.push({
          ...v,
          rule_key: rule.key,
          severity: rule.severity,
          fingerprint: fingerprintOf(rule.key, v),
        });
      }
    }

    // Collapse duplicate fingerprints before persisting. A single rule can emit
    // two rows that map to the same (rule_key|entity|discriminator) — e.g.
    // sheet-shares-field-price returns one sheet SKU matched to two field
    // variants. The batched `ON CONFLICT (fingerprint) DO UPDATE` errors with
    // "cannot affect row a second time" if one batch touches a fingerprint
    // twice, so keep only the last finding per fingerprint (they describe the
    // same violation).
    const byFingerprint = new Map();
    for (const f of findings) byFingerprint.set(f.fingerprint, f);
    const uniqueFindings = [...byFingerprint.values()];

    // Classify against existing rows to count new vs reopened.
    const allFps = uniqueFindings.map(f => f.fingerprint);
    const known = new Map();
    for (let i = 0; i < allFps.length; i += 5000) {
      const chunk = allFps.slice(i, i + 5000);
      const res = await pool.query(
        `SELECT fingerprint, status FROM quality_violations WHERE fingerprint = ANY($1)`,
        [chunk]
      );
      for (const r of res.rows) known.set(r.fingerprint, r.status);
    }
    const newFindings = uniqueFindings.filter(f => !known.has(f.fingerprint));
    const reopened = uniqueFindings.filter(f => known.get(f.fingerprint) === 'fixed');

    // Upsert current findings in batches.
    for (let i = 0; i < uniqueFindings.length; i += 500) {
      const chunk = uniqueFindings.slice(i, i + 500);
      const values = [];
      const params = [];
      chunk.forEach((f, j) => {
        const base = j * 8;
        values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
        params.push(f.rule_key, f.severity, f.vendor_id || null, f.product_id || null,
          f.sku_id || null, f.summary, JSON.stringify(f.detail || {}), f.fingerprint);
      });
      await pool.query(`
        INSERT INTO quality_violations (rule_key, severity, vendor_id, product_id, sku_id, summary, detail, fingerprint)
        VALUES ${values.join(', ')}
        ON CONFLICT (fingerprint) DO UPDATE SET
          last_seen = CURRENT_TIMESTAMP,
          summary = EXCLUDED.summary,
          detail = EXCLUDED.detail,
          severity = EXCLUDED.severity,
          status = CASE WHEN quality_violations.status = 'fixed' THEN 'open' ELSE quality_violations.status END,
          resolved_at = CASE WHEN quality_violations.status = 'fixed' THEN NULL ELSE quality_violations.resolved_at END
      `, params);
    }

    // Auto-close open violations that no longer reproduce — but only for the
    // rules and vendor scope this run actually covered. A rule that FAILED this
    // run is excluded, so its open violations are left as-is (not mass-closed
    // just because the rule couldn't produce findings).
    const ranKeys = rules.map(r => r.key).filter(k => !failedKeys.includes(k));
    const fixedRes = await pool.query(`
      UPDATE quality_violations qv
      SET status = 'fixed', resolved_at = CURRENT_TIMESTAMP
      WHERE qv.status = 'open'
        AND qv.rule_key = ANY($1)
        AND ($2::uuid IS NULL OR qv.vendor_id = $2)
        AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) f(fp) WHERE f.fp = qv.fingerprint)
      RETURNING qv.id
    `, [ranKeys, vendorId, allFps]);

    const openTotalRes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM quality_violations WHERE status = 'open'`
    );

    await pool.query(`
      UPDATE quality_runs SET finished_at = CURRENT_TIMESTAMP, rules_run = $2,
        new_count = $3, reopened_count = $4, fixed_count = $5, open_total = $6,
        error = $7
      WHERE id = $1
    `, [runId, rules.length - failedKeys.length, newFindings.length, reopened.length,
        fixedRes.rowCount, openTotalRes.rows[0].n,
        failedKeys.length ? `rules failed: ${failedKeys.join(', ')}` : null]);

    return {
      runId,
      rulesRun: rules.length,
      failedKeys,
      total: uniqueFindings.length,
      newCount: newFindings.length,
      reopenedCount: reopened.length,
      fixedCount: fixedRes.rowCount,
      openTotal: openTotalRes.rows[0].n,
      // Capped sample for the alert email.
      newSample: newFindings.slice(0, 25).map(f => ({ rule_key: f.rule_key, severity: f.severity, summary: f.summary })),
    };
  } catch (err) {
    await pool.query(
      `UPDATE quality_runs SET finished_at = CURRENT_TIMESTAMP, error = $2 WHERE id = $1`,
      [runId, err.message]
    ).catch(() => {});
    throw err;
  }
}
