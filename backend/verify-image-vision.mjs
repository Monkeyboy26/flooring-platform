// Phase 2b — AI-vision image correctness. For SKUs with a stated color, ask a
// vision model whether the primary image actually depicts that color/material.
// Covers the ~76k SKUs the deterministic EF/Shaw code-check can't (no URL color
// signal, or a wrong filename). Verdicts are cached in image_vision_checks so
// the expensive call runs once (bounded/on-demand); the cheap image-vision-
// mismatch quality rule reads the cache. Cost-tracked, bounded by --limit.
//
//   node verify-image-vision.mjs [--limit N] [--vendor CODE] [--recheck] [--concurrency N]
//
// Sends a PUBLIC image URL (OpenAI must fetch it): a mirrored /uploads image via
// SITE_URL (alive, served even in maintenance mode), else the vendor URL.

import OpenAI from 'openai';
import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '200'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const VENDOR = arg('--vendor', null);
const RECHECK = process.argv.includes('--recheck');
const MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';
const SITE = (process.env.SITE_URL || 'https://www.romaflooringdesigns.com').replace(/\/$/, '');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function publicUrl(url, originalUrl) {
  if (!url) return originalUrl || null;
  if (url.startsWith('/uploads/') || url.startsWith('/assets/')) return SITE + url; // mirrored: alive + public
  if (/^https?:\/\//.test(url)) return url;
  return originalUrl || null;
}

const { rows } = await pool.query(`
  SELECT s.id AS sku_id, s.internal_sku, p.name, v.code AS vendor_code,
         c.name AS category, ma.id AS media_id, ma.url, ma.original_url,
         (SELECT sa.value FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
           WHERE sa.sku_id = s.id AND a.slug = 'color' LIMIT 1) AS color
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
  WHERE s.status = 'active' AND p.status = 'active'
    AND ($1::text IS NULL OR v.code = $1)
    AND EXISTS (SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id WHERE sa.sku_id = s.id AND a.slug = 'color' AND sa.value <> '')
    ${RECHECK ? '' : 'AND NOT EXISTS (SELECT 1 FROM image_vision_checks ivc WHERE ivc.sku_id = s.id)'}
  ORDER BY md5(s.id::text)
  LIMIT ${LIMIT}
`, [VENDOR]);

console.log(`${rows.length} SKUs to vision-check (model ${MODEL}, concurrency ${CONC})`);

const PROMPT = (name, color, cat) =>
  `You are auditing a flooring product photo for an e-commerce catalog. ` +
  `The product is "${name}", stated color "${color}"${cat ? `, category "${cat}"` : ''}. ` +
  `Flooring colors usually have MARKETING names ("River Jade", "Saddle White", "Metal", "Malibu") ` +
  `that are NOT literal color descriptions — do not judge the name literally. ` +
  `Look only at the dominant material in the image (ignore backgrounds, props, rooms). ` +
  `Set match=false ONLY when the image would clearly surprise a customer who ordered this product — ` +
  `an obvious color-family swap (ordered a WHITE floor, the photo is DARK GREY / BLACK; ordered ` +
  `a warm BROWN wood, the photo is a COOL GREY). If the image plausibly fits the name or you are ` +
  `unsure, set match=true. Report the observed dominant color plainly. ` +
  `Reply ONLY compact JSON: {"match":true|false,"observed_color":"...","confidence":0.0-1.0,"note":"short"}.`;

let done = 0, checked = 0, mism = 0, errs = 0, ptok = 0, ctok = 0;
let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const r = rows[cursor++];
    const img = publicUrl(r.url, r.original_url);
    if (!img || !r.color) { done++; continue; }
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT(r.name, r.color, r.category) },
          { type: 'image_url', image_url: { url: img, detail: 'low' } },
        ] }],
        max_tokens: 120,
        temperature: 0,
      });
      ptok += resp.usage?.prompt_tokens || 0;
      ctok += resp.usage?.completion_tokens || 0;
      let verdict;
      try { verdict = JSON.parse(resp.choices[0].message.content.replace(/```json|```/g, '').trim()); }
      catch { errs++; done++; continue; }
      await pool.query(`
        INSERT INTO image_vision_checks (sku_id, media_id, matched, confidence, observed_color, note, model, image_url, checked_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
        ON CONFLICT (sku_id) DO UPDATE SET media_id=EXCLUDED.media_id, matched=EXCLUDED.matched,
          confidence=EXCLUDED.confidence, observed_color=EXCLUDED.observed_color, note=EXCLUDED.note,
          model=EXCLUDED.model, image_url=EXCLUDED.image_url, checked_at=CURRENT_TIMESTAMP`,
        [r.sku_id, r.media_id, verdict.match !== false, verdict.confidence ?? null,
         (verdict.observed_color || '').slice(0, 60), (verdict.note || '').slice(0, 200), MODEL, img]);
      checked++;
      if (verdict.match === false) mism++;
    } catch (e) { errs++; }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${rows.length} checked=${checked} mismatch=${mism} err=${errs}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// gpt-4o-mini pricing: $0.15 / 1M input, $0.60 / 1M output.
const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
console.log(`\nDone: ${checked} checked, ${mism} color mismatch, ${errs} errors`);
console.log(`Tokens: ${ptok} in + ${ctok} out = $${cost.toFixed(4)}  (~$${(cost / Math.max(checked, 1) * 1000).toFixed(2)} per 1000 images)`);
await pool.end();
