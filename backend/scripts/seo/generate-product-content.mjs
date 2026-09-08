// SEO Phase 1 — AI product content engine.
//
// Batch-generates UNIQUE per-product SEO content (meta title/description, H1, a
// short long-form body, and primary-image alt text) and stores it on products +
// media_assets (columns added by database/migrations/2026-09-07-seo-phase0.sql).
// The crawler-facing renderer (backend/services/seoRenderer.js) and the SPA both
// PREFER these stored fields over derived defaults, so this is what kills the
// duplicate/thin-content risk on a scraped catalog.
//
//   node scripts/seo/generate-product-content.mjs [--limit N] [--concurrency N]
//       [--category SLUG] [--vendor CODE] [--model NAME] [--force] [--dry-run]
//
// Run inside the api container (env is populated there), e.g.
//   docker compose exec -T api node scripts/seo/generate-product-content.mjs --limit 50
//
// IDEMPOTENT: each product's content_hash is a digest of the exact inputs used to
// generate it (name/brand/collection/category/attributes/description + prompt+model
// version). A product whose hash still matches is SKIPPED, so re-runs are cheap and
// only regenerate rows whose source data (or the prompt/model) actually changed.
// content_status='reviewed' rows are human-approved and NEVER overwritten.
//
// PROVIDER: uses OpenAI to match the existing stack (see verify-image-vision.mjs;
// OPENAI_API_KEY is already provisioned local+prod). The model call is isolated in
// generateContent() below — swapping to another provider is a change to that one
// function, nothing else in the pipeline.

import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '100'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const CATEGORY = arg('--category', null);   // category slug filter
const VENDOR = arg('--vendor', null);       // vendor code filter
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');       // regenerate even if hash matches
const DRY_RUN = process.argv.includes('--dry-run');   // generate + print, write nothing

// Bump when the prompt or output contract changes so every product regenerates.
const PROMPT_VERSION = 'v1';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Candidate products ───────────────────────────────────────────────────────
// Never touch 'reviewed' (human-approved). Prefer untouched ('none') first so a
// bounded run makes maximum forward progress, then fall back to re-checking
// 'generated' rows (which skip in JS unless their source hash changed).
const { rows } = await pool.query(`
  SELECT p.id, COALESCE(p.display_name, p.name) AS name, p.collection,
         p.description_short, p.description_long, p.content_hash, p.content_status,
         c.name AS category_name, c.slug AS category_slug,
         COALESCE(br.name, v.name) AS brand_name,
         (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) AS brand_hidden,
         v.code AS vendor_code,
         COALESCE((
           SELECT json_agg(json_build_object('name', a.name, 'value', sa.value) ORDER BY a.display_order, a.name)
           FROM skus s
           JOIN sku_attributes sa ON sa.sku_id = s.id
           JOIN attributes a ON a.id = sa.attribute_id
           WHERE s.product_id = p.id AND s.status = 'active' AND sa.value <> ''
         ), '[]'::json) AS attributes
  FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN brands br ON br.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id
  WHERE p.status = 'active'
    AND p.content_status <> 'reviewed'
    AND ($1::text IS NULL OR c.slug = $1)
    AND ($2::text IS NULL OR v.code = $2)
  ORDER BY (p.content_status = 'none') DESC, md5(p.id::text)
  LIMIT ${LIMIT}
`, [CATEGORY, VENDOR]);

console.log(`${rows.length} candidate products (model ${MODEL}, concurrency ${CONC}${DRY_RUN ? ', DRY RUN' : ''})`);

// Digest of the exact inputs that shape the generated content. If this is
// unchanged since last run, the stored content is still valid → skip.
function hashInputs(p) {
  const brand = p.brand_hidden ? '' : (p.brand_name || '');
  const payload = JSON.stringify({
    v: PROMPT_VERSION, model: MODEL,
    name: p.name, collection: p.collection, brand,
    category: p.category_name, attrs: p.attributes,
    desc: p.description_short || p.description_long || '',
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ── The one provider-specific function ───────────────────────────────────────
// Structured outputs guarantee a valid, schema-shaped object (no brittle parsing).
const SCHEMA = {
  name: 'seo_product_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'seo_h1', 'content_html', 'image_alt'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars, includes product + a key attribute, ends with " | Roma Flooring Designs" only if it fits' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led, unique, no keyword stuffing' },
      seo_h1: { type: 'string', description: 'Human page heading, distinct from meta_title, no brand suffix' },
      content_html: { type: 'string', description: '2 short <p> paragraphs of UNIQUE body copy about this specific product; plain <p> tags only; no <h1>/<script>/<style>; no fabricated specs or prices' },
      image_alt: { type: 'string', description: '≤125 chars, describes the product image (name + color/finish/size + material), no "image of"' },
    },
  },
};

function buildPrompt(p) {
  const brand = p.brand_hidden ? null : (p.brand_name || null);
  const attrs = (p.attributes || []).map(a => `${a.name}: ${a.value}`).join('; ');
  return (
    `Write SEO content for one product on Roma Flooring Designs, a flooring/tile e-commerce store.\n` +
    `Product: ${p.name}\n` +
    (p.collection ? `Collection: ${p.collection}\n` : '') +
    (p.category_name ? `Category: ${p.category_name}\n` : '') +
    (brand ? `Brand: ${brand}\n` : '') +
    (attrs ? `Attributes: ${attrs}\n` : '') +
    (p.description_short || p.description_long ? `Vendor description (reference only, do NOT copy): ${(p.description_short || p.description_long).slice(0, 500)}\n` : '') +
    `\nRules: Write ORIGINAL copy — do not paraphrase the vendor description. Ground every claim ` +
    `in the attributes above; invent NO specs, prices, warranties, or certifications. Make it ` +
    `distinct from other products in the same collection (lean on this product's specific ` +
    `color/finish/size). Natural, confident tone for a homeowner or designer. American English.`
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Set once the OpenAI *daily* request cap (RPD) is exhausted — no point continuing
// today, so workers drain out cleanly instead of churning thousands of doomed 429s.
let dailyCapHit = false;

async function generateContent(p) {
  let resp;
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(p) }],
        response_format: { type: 'json_schema', json_schema: SCHEMA },
        max_tokens: 700,
        temperature: 0.5,
      });
      break;
    } catch (e) {
      const msg = e?.message || '';
      if (e?.status === 429) {
        // Daily-request cap (RPD) won't clear today — signal a graceful stop.
        if (/per day|\bRPD\b/i.test(msg)) { dailyCapHit = true; throw e; }
        // Transient per-minute limit (RPM/TPM) — respect retry-after, then back off.
        if (attempt < 5) {
          const hinted = parseFloat((msg.match(/try again in ([\d.]+)s/) || [])[1]);
          const wait = Number.isFinite(hinted) ? hinted * 1000 : Math.min(2 ** attempt * 1000, 30000);
          await sleep(wait + 250);
          continue;
        }
      }
      throw e;
    }
  }
  const out = JSON.parse(resp.choices[0].message.content);
  return { out, ptok: resp.usage?.prompt_tokens || 0, ctok: resp.usage?.completion_tokens || 0 };
}

// ── Run ──────────────────────────────────────────────────────────────────────
let done = 0, wrote = 0, skipped = 0, errs = 0, ptok = 0, ctok = 0;
// Lightweight near-duplicate guard: flag generated descriptions that collide with
// another product's this run (a signal the prompt isn't differentiating enough).
// A fuller embedding-based dedup pass is a follow-up (see docs/SEO-PLAN.md P1).
const seenDesc = new Set();
let dupWarnings = 0;
let cursor = 0;

async function worker() {
  while (cursor < rows.length && !dailyCapHit) {
    const p = rows[cursor++];
    const hash = hashInputs(p);
    if (!FORCE && p.content_status === 'generated' && p.content_hash === hash) { skipped++; done++; continue; }

    try {
      const { out, ptok: pt, ctok: ct } = await generateContent(p);
      ptok += pt; ctok += ct;

      const norm = (out.meta_description || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm && seenDesc.has(norm)) { dupWarnings++; console.warn(`  ⚠ duplicate description: ${p.name}`); }
      else seenDesc.add(norm);

      if (DRY_RUN) {
        console.log(`\n— ${p.name}\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  h1:    ${out.seo_h1}\n  alt:   ${out.image_alt}`);
      } else {
        const cx = await pool.connect();
        try {
          await cx.query('BEGIN');
          await cx.query(
            `UPDATE products SET meta_title=$2, meta_description=$3, seo_h1=$4, content_html=$5,
                 content_status='generated', content_hash=$6, updated_at=CURRENT_TIMESTAMP
             WHERE id=$1`,
            [p.id, out.meta_title, out.meta_description, out.seo_h1, out.content_html, hash]
          );
          // Backfill alt text on this product's images that lack it (don't clobber
          // existing alt unless --force).
          await cx.query(
            `UPDATE media_assets SET alt_text=$2
             WHERE product_id=$1 AND asset_type <> 'spec_pdf'
               AND (${FORCE ? 'TRUE' : 'alt_text IS NULL OR alt_text = \'\''})`,
            [p.id, out.image_alt]
          );
          await cx.query('COMMIT');
        } catch (e) { await cx.query('ROLLBACK'); throw e; }
        finally { cx.release(); }
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${p.name}: ${e.message}`); }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${rows.length} wrote=${wrote} skip=${skipped} err=${errs}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// gpt-4o-mini pricing: $0.15 / 1M input, $0.60 / 1M output (override if --model differs).
const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after it resets — idempotent, will skip everything already generated.`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${skipped} skipped (hash unchanged), ${errs} errors, ${dupWarnings} dup-description warnings`);
console.log(`Tokens: ${ptok} in + ${ctok} out ≈ $${cost.toFixed(4)}  (~$${(cost / Math.max(wrote, 1) * 1000).toFixed(2)} per 1000 products)`);
await pool.end();
