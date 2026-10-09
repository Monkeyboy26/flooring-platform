// Gallery-image format check. For each SUSPECT non-primary MSI image (CDN
// colorname/mosaic/fullslab/pattern shots — the ones the website/CDN scraper
// grabbed by color name), ask a vision model whether it shows the SAME product
// as that SKU's PRIMARY photo, or a DIFFERENT format (hex/mosaic/slab/other
// pattern) / different color. Two-image comparison (primary = ground truth) so a
// room scene of the same tile reads SAME, but a hex-mosaic shot reads DIFFERENT.
// Verdicts cached in gallery_image_checks; fix-gallery-images.mjs removes the
// confirmed-different ones. Cost-tracked, bounded by --limit.
//
//   node verify-gallery-images.mjs [--limit N] [--vendor CODE] [--recheck] [--concurrency N]

import OpenAI from 'openai';
import { pool } from './db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '200'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const VENDOR = arg('--vendor', 'MSI');
const RECHECK = process.argv.includes('--recheck');
const MODEL = process.env.VISION_MODEL || 'gpt-4o-mini';
const SITE = (process.env.SITE_URL || 'https://www.romaflooringdesigns.com').replace(/\/$/, '');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

await pool.query(`
  CREATE TABLE IF NOT EXISTS gallery_image_checks (
    media_id UUID PRIMARY KEY,
    matches BOOLEAN,
    observed TEXT,
    confidence NUMERIC(3,2),
    note TEXT,
    model TEXT,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

function publicUrl(url, originalUrl) {
  if (url && (url.startsWith('/uploads/') || url.startsWith('/assets/'))) return SITE + url;
  if (url && /^https?:\/\//.test(url)) return url;
  if (originalUrl && /^https?:\/\//.test(originalUrl)) return originalUrl;
  return null;
}

const { rows } = await pool.query(`
  SELECT m.id AS media_id, m.asset_type, m.sku_id, m.url, m.original_url,
         p.id AS product_id, p.name,
         (SELECT value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id WHERE sa.sku_id=m.sku_id AND a.name='Size' LIMIT 1) AS size,
         (SELECT value FROM sku_attributes sa JOIN attributes a ON a.id=sa.attribute_id WHERE sa.sku_id=m.sku_id AND a.name='Finish' LIMIT 1) AS finish,
         prim.url AS prim_url, prim.original_url AS prim_original
  FROM media_assets m
  JOIN products p ON p.id = m.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN LATERAL (
    SELECT url, original_url FROM media_assets pm
    WHERE pm.asset_type = 'primary'
      AND (pm.sku_id = m.sku_id OR (m.sku_id IS NULL AND pm.product_id = m.product_id))
    ORDER BY (pm.sku_id = m.sku_id) DESC NULLS LAST, pm.sort_order LIMIT 1) prim ON true
  WHERE v.code = $1 AND p.status = 'active' AND m.asset_type IN ('alternate','lifestyle')
    AND prim.url IS NOT NULL
    -- skip DAM iso renditions: those are SKU-matched and correct
    AND coalesce(m.original_url, m.url) !~* 'iso.?product.?photo|/renditions/'
    -- suspect: CDN color-name / mosaic / slab / pattern shots
    AND coalesce(m.original_url, m.url) ~* 'cdn\\.msisurfaces\\.com|/mosaics/|/fullslab/|full-slab|hexagon|herringbone|chevron|basketweave|pinwheel|arabesque|dotty|\\blynx\\b|picket|penny|subway|/colornames/'
    ${RECHECK ? '' : 'AND NOT EXISTS (SELECT 1 FROM gallery_image_checks g WHERE g.media_id = m.id)'}
  ORDER BY md5(m.id::text)
  LIMIT ${LIMIT}
`, [VENDOR]);

console.log(`${rows.length} suspect gallery images to check (model ${MODEL}, concurrency ${CONC})`);

const PROMPT = (name, size, finish) =>
  `Image 1 is the MAIN product photo for "${name}"${size ? `, a ${size}${finish ? ' ' + finish : ''} tile` : ''}. ` +
  `Image 2 is another image on the same product listing. ` +
  `Does image 2 show the SAME product as image 1 — same tile FORMAT, pattern and material (a different angle, a close-up, or an installed room scene of the same tile all count as SAME)? ` +
  `Answer same=false ONLY if image 2 clearly shows a DIFFERENT product: a different FORMAT (e.g. a mosaic / hexagon / herringbone / a full stone slab when image 1 is a plain field tile), a different pattern, or a clearly different color. ` +
  `When unsure, answer same=true. ` +
  `Reply ONLY compact JSON: {"same":true|false,"observed":"what image 2 shows","confidence":0.0-1.0,"note":"short"}.`;

let done = 0, checked = 0, diff = 0, errs = 0, ptok = 0, ctok = 0;
let cursor = 0;
async function worker() {
  while (cursor < rows.length) {
    const r = rows[cursor++];
    const primImg = publicUrl(r.prim_url, r.prim_original);
    const galImg = publicUrl(r.url, r.original_url);
    if (!primImg || !galImg || primImg === galImg) { done++; continue; }
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT(r.name, r.size, r.finish) },
          { type: 'image_url', image_url: { url: primImg, detail: 'low' } },
          { type: 'image_url', image_url: { url: galImg, detail: 'low' } },
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
        INSERT INTO gallery_image_checks (media_id, matches, observed, confidence, note, model, checked_at)
        VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
        ON CONFLICT (media_id) DO UPDATE SET matches=EXCLUDED.matches, observed=EXCLUDED.observed,
          confidence=EXCLUDED.confidence, note=EXCLUDED.note, model=EXCLUDED.model, checked_at=CURRENT_TIMESTAMP`,
        [r.media_id, v.same !== false, (v.observed || '').slice(0, 120), v.confidence ?? null, (v.note || '').slice(0, 200), MODEL]);
      checked++;
      if (v.same === false) diff++;
    } catch (e) { errs++; }
    done++;
    if (done % 50 === 0) console.log(`  ${done}/${rows.length} checked=${checked} different=${diff} err=${errs}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
console.log(`\nDone: ${checked} checked, ${diff} DIFFERENT (wrong gallery image), ${errs} errors`);
console.log(`Tokens: ${ptok} in + ${ctok} out = $${cost.toFixed(4)}`);
await pool.end();
