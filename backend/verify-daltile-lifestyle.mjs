// Daltile lifestyle color-match check. Daltile publishes ONE collection-level
// room scene per series and the scraper attaches it to EVERY color variant in
// that series (e.g. one cream pool-deck shot rides all 64 Keystones colors), so
// the lifestyle photo shows the wrong color for most variants. For each shared
// lifestyle image (used by >1 color product) we ask a vision model whether the
// room scene prominently features installed tile of the SAME COLOR as that
// SKU's own primary product photo (the per-color ground truth). Judged on COLOR
// only — size/finish/angle/lighting/grout don't matter. Verdicts are cached per
// (lifestyle_url, reference_url) pair so the ~7k links collapse to ~4k vision
// calls; fix-daltile-lifestyle-demote.mjs hides the confirmed-mismatch links.
//
// Images are fed to the model via their public vendor CDN original_url (Daltile
// scene7), so this does not depend on the local mirror being on prod.
//
//   node verify-daltile-lifestyle.mjs [--limit N] [--vendor DAL] [--recheck] [--concurrency N]

import OpenAI from 'openai';
import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '100000'), 10);
const CONC = parseInt(arg('--concurrency', '6'), 10);
const VENDOR = arg('--vendor', 'DAL');
const RECHECK = process.argv.includes('--recheck');
const MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

await pool.query(`
  CREATE TABLE IF NOT EXISTS lifestyle_color_checks (
    life_url   TEXT,
    ref_url    TEXT,
    matches    BOOLEAN,
    observed   TEXT,
    confidence NUMERIC(3,2),
    note       TEXT,
    model      TEXT,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (life_url, ref_url)
  )`);

// Prefer the public vendor CDN url (original_url) so OpenAI can fetch the image.
function publicUrl(url, originalUrl) {
  if (originalUrl && /^https?:\/\//.test(originalUrl)) return originalUrl;
  if (url && /^https?:\/\//.test(url)) return url;
  return null;
}

// Candidate set: active Daltile 'lifestyle' links whose image is SHARED across
// more than one color product (the systematic-mismatch set). ref = that SKU's
// own primary (fallback swatch) = the per-color ground truth.
const CANDIDATE_SQL = `
  WITH dal_life AS (
    SELECT m.id AS media_id, m.sku_id, m.product_id,
           m.url AS life_url, m.original_url AS life_original,
           ref.url AS ref_url, ref.original_url AS ref_original,
           p.name
    FROM media_assets m
    JOIN products p ON p.id = m.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN LATERAL (
      SELECT url, original_url FROM media_assets rm
      WHERE rm.sku_id = m.sku_id AND rm.asset_type IN ('primary','swatch')
      ORDER BY (rm.asset_type = 'primary') DESC, rm.sort_order LIMIT 1
    ) ref ON true
    WHERE v.code = $1 AND p.status = 'active' AND m.asset_type = 'lifestyle'
      AND ref.url IS NOT NULL
  ),
  shared AS (
    SELECT life_url FROM dal_life GROUP BY life_url HAVING COUNT(DISTINCT product_id) > 1
  )
  SELECT dl.* FROM dal_life dl JOIN shared s ON s.life_url = dl.life_url
`;

const { rows } = await pool.query(CANDIDATE_SQL, [VENDOR]);

// Collapse to distinct (life_public, ref_public) pairs.
const pairs = new Map();
for (const r of rows) {
  const life = publicUrl(r.life_url, r.life_original);
  const ref = publicUrl(r.ref_url, r.ref_original);
  if (!life || !ref || life === ref) continue;
  const key = life + '|' + ref;
  if (!pairs.has(key)) pairs.set(key, { life, ref, name: r.name });
}
let work = [...pairs.values()];

if (!RECHECK) {
  const { rows: done } = await pool.query('SELECT life_url, ref_url FROM lifestyle_color_checks');
  const seen = new Set(done.map(d => d.life_url + '|' + d.ref_url));
  work = work.filter(w => !seen.has(w.life + '|' + w.ref));
}
work = work.slice(0, LIMIT);

console.log(`${rows.length} shared lifestyle links → ${pairs.size} distinct pairs, ${work.length} to check (model ${MODEL}, conc ${CONC})`);

const PROMPT = (name) =>
  `Image 1 is the actual product tile for "${name}" — a studio/swatch photo showing its true COLOR. ` +
  `Image 2 is an installed room scene shown on the same product page. ` +
  `Judging COLOR ONLY (ignore tile size, shape, finish, grout, camera angle and lighting): does image 2 prominently feature installed tile/flooring of the SAME color and tone as image 1 — i.e. is this room actually showcasing THIS color? ` +
  `Answer match=false when the main tile shown in the room is clearly a DIFFERENT color than image 1 (e.g. image 1 is cobalt blue but the room is cream, or image 1 is red but the room is gray). ` +
  `When genuinely ambiguous, answer match=true. ` +
  `Reply ONLY compact JSON: {"match":true|false,"observed":"dominant tile color in the room","confidence":0.0-1.0,"note":"short"}.`;

let done = 0, checked = 0, mism = 0, errs = 0, ptok = 0, ctok = 0, cursor = 0;
async function worker() {
  while (cursor < work.length) {
    const w = work[cursor++];
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT(w.name) },
          { type: 'image_url', image_url: { url: w.ref, detail: 'low' } },
          { type: 'image_url', image_url: { url: w.life, detail: 'low' } },
        ] }],
        max_tokens: 120,
        temperature: 0,
      });
      ptok += resp.usage?.prompt_tokens || 0;
      ctok += resp.usage?.completion_tokens || 0;
      let v;
      try { v = JSON.parse(resp.choices[0].message.content.replace(/```json|```/g, '').trim()); }
      catch { errs++; done++; continue; }
      await pool.query(`
        INSERT INTO lifestyle_color_checks (life_url, ref_url, matches, observed, confidence, note, model, checked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
        ON CONFLICT (life_url, ref_url) DO UPDATE SET matches=EXCLUDED.matches, observed=EXCLUDED.observed,
          confidence=EXCLUDED.confidence, note=EXCLUDED.note, model=EXCLUDED.model, checked_at=CURRENT_TIMESTAMP`,
        [w.life, w.ref, v.match !== false, (v.observed || '').slice(0, 120), v.confidence ?? null, (v.note || '').slice(0, 200), MODEL]);
      checked++;
      if (v.match === false) mism++;
    } catch (e) { errs++; }
    done++;
    if (done % 100 === 0) console.log(`  ${done}/${work.length} checked=${checked} mismatch=${mism} err=${errs}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
console.log(`\nDone: ${checked} checked, ${mism} COLOR MISMATCH, ${errs} errors`);
console.log(`Tokens: ${ptok} in + ${ctok} out = $${cost.toFixed(4)}`);
await pool.end();
