// SEO Phase 2 — AI landing-page content engine.
//
// Companion to generate-product-content.mjs, but for the programmatic facet pages
// minted by build-landing-pages.mjs. Each facet page (e.g. "White Porcelain Tile",
// "24x48 Marble-Look Tile") gets UNIQUE meta_title / meta_description / intro_html /
// footer_html stored on the landing_pages row. renderLandingPage() in
// backend/services/seoRenderer.js already PREFERS these stored fields over its
// templated fallback — so this is what turns the 3,972 thin fallback pages into
// distinct, safely-indexable content and removes the mass-duplicate suppression risk.
//
//   node scripts/seo/generate-landing-content.mjs [--limit N] [--concurrency N]
//       [--index-only] [--model NAME] [--force] [--dry-run]
//
// Run inside the api container (env is populated there), e.g.
//   docker compose exec -T api node scripts/seo/generate-landing-content.mjs --limit 20 --dry-run
//
// --index-only: only generate for is_indexable pages (the ones Google will actually
//   index — spend the budget there first; noindex pages can wait or stay templated).
//
// IDEMPOTENT: content_hash is a digest of the page's DURABLE identity (title +
// category + facet attribute + prompt/model version) — NOT the product_count, which
// wiggles nightly. A page whose hash matches is skipped. content_status='reviewed'
// rows are human-approved and NEVER overwritten. Copy is kept EVERGREEN (no baked-in
// counts/prices) so recomputed counts never make stored text stale.
//
// PROVIDER: OpenAI, same as the product engine. The model call is isolated in
// generateContent(); swap providers there and nowhere else.

import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '100'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const INDEX_ONLY = process.argv.includes('--index-only');
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

// Bump when the prompt or output contract changes so every page regenerates.
const PROMPT_VERSION = 'v1';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Candidate landing pages ──────────────────────────────────────────────────
// Never touch 'reviewed'. Prefer indexable + untouched ('none') first so a bounded
// run puts the budget where it matters (pages Google indexes), then re-checks
// 'generated' rows (which skip in JS unless their durable hash changed).
// A CROSS JOIN LATERAL pulls the single facet attribute out of filter_json; a LEFT
// LATERAL grounds each page in up to 8 real matching product names so the copy is
// specific to THIS facet's actual inventory, not generic boilerplate.
const { rows } = await pool.query(`
  SELECT lp.id, lp.slug, lp.title, lp.h1, lp.is_indexable, lp.product_count,
         lp.content_status, lp.content_hash,
         f.category_slug, f.attr_slug, f.attr_value,
         c.name AS category_name, a.name AS attr_name,
         samp.names AS sample_products
  FROM landing_pages lp
  CROSS JOIN LATERAL (
    SELECT lp.filter_json->>'category' AS category_slug, kv.key AS attr_slug, kv.value AS attr_value
    FROM jsonb_each_text(lp.filter_json->'attributes') kv
    LIMIT 1
  ) f
  LEFT JOIN categories c ON c.slug = f.category_slug
  LEFT JOIN attributes a ON a.slug = f.attr_slug
  LEFT JOIN LATERAL (
    SELECT array_agg(pname) AS names FROM (
      SELECT DISTINCT COALESCE(p.display_name, p.name) AS pname
      FROM products p
      JOIN categories cc ON cc.id = p.category_id AND cc.slug = f.category_slug
      JOIN skus s ON s.product_id = p.id AND s.status = 'active' AND s.is_sample = false
      JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.value = f.attr_value
      JOIN attributes aa ON aa.id = sa.attribute_id AND aa.slug = f.attr_slug
      WHERE p.status = 'active'
      LIMIT 8
    ) t
  ) samp ON true
  WHERE lp.type = 'facet'
    AND lp.content_status <> 'reviewed'
    AND (NOT $1::boolean OR lp.is_indexable = true)
  ORDER BY lp.is_indexable DESC, (lp.content_status = 'none') DESC, lp.product_count DESC, md5(lp.id::text)
  LIMIT ${LIMIT}
`, [INDEX_ONLY]);

console.log(`${rows.length} candidate landing pages (model ${MODEL}, concurrency ${CONC}${INDEX_ONLY ? ', index-only' : ''}${DRY_RUN ? ', DRY RUN' : ''})`);

// Durable identity of the facet — deliberately EXCLUDES product_count and sample
// names (both volatile) so nightly count churn doesn't force needless regeneration.
function hashInputs(p) {
  const payload = JSON.stringify({
    v: PROMPT_VERSION, model: MODEL,
    title: p.title, category: p.category_slug, attr: p.attr_slug, value: p.attr_value,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ── The one provider-specific function ───────────────────────────────────────
const SCHEMA = {
  name: 'seo_landing_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'intro_html', 'footer_html'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars; lead with the facet phrase (e.g. "White Porcelain Tile"); append " | Roma Flooring Designs" only if it fits' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led, unique to THIS facet; NO specific product counts, prices, or numbers that could go stale' },
      intro_html: { type: 'string', description: '2 short <p> paragraphs of UNIQUE intro copy for this facet collection — what defines this look/spec, where it works (rooms/applications), how to choose. Plain <p> tags only; no <h1>/<script>/<style>; no fabricated specs, prices, or counts' },
      footer_html: { type: 'string', description: '1 short <p> of evergreen buying/design guidance for this facet (pairings, care, or coordinating options). Plain <p> only; no prices/counts' },
    },
  },
};

function buildPrompt(p) {
  const samples = (p.sample_products || []).filter(Boolean).slice(0, 8);
  return (
    `Write SEO landing-page copy for a product-collection page on Roma Flooring Designs, a flooring/tile e-commerce store.\n` +
    `Page: ${p.title}\n` +
    (p.category_name ? `Category: ${p.category_name}\n` : '') +
    (p.attr_name && p.attr_value ? `Facet: ${p.attr_name} = ${p.attr_value}\n` : '') +
    (samples.length ? `Representative products in this collection (for grounding — mention the look, not these names verbatim): ${samples.join('; ')}\n` : '') +
    `\nThis page lists every ${p.title.toLowerCase()} product we carry. Write copy that helps a ` +
    `homeowner or designer understand this specific look/spec and decide. Rules: ORIGINAL copy, ` +
    `distinct from other facet pages (lean on what makes "${p.attr_value}" ${p.category_name || 'tile'} ` +
    `specific — its look, feel, and typical uses). Invent NO specs, prices, warranties, ` +
    `certifications, or product counts. Keep it evergreen (no numbers that go stale). Natural, ` +
    `confident tone. American English.`
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
        if (/per day|\bRPD\b/i.test(msg)) { dailyCapHit = true; throw e; }
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
const seenIntro = new Set();
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
      if (norm && seenIntro.has(norm)) { dupWarnings++; console.warn(`  ⚠ duplicate description: ${p.title}`); }
      else seenIntro.add(norm);

      if (DRY_RUN) {
        console.log(`\n— ${p.title}  (/shop/${p.slug}, ${p.product_count} products${p.is_indexable ? ', IDX' : ''})\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  intro: ${out.intro_html.replace(/\s+/g, ' ').slice(0, 180)}…`);
      } else {
        await pool.query(
          `UPDATE landing_pages SET meta_title=$2, meta_description=$3, intro_html=$4, footer_html=$5,
               content_status='generated', content_hash=$6, updated_at=CURRENT_TIMESTAMP
           WHERE id=$1`,
          [p.id, out.meta_title, out.meta_description, out.intro_html, out.footer_html, hash]
        );
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${p.title}: ${e.message}`); }
    done++;
    if (done % 25 === 0) console.log(`  ${done}/${rows.length} wrote=${wrote} skip=${skipped} err=${errs}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// gpt-4o-mini pricing: $0.15 / 1M input, $0.60 / 1M output (override if --model differs).
const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after it resets — idempotent, skips everything already generated.`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${skipped} skipped (hash unchanged), ${errs} errors, ${dupWarnings} dup-description warnings`);
console.log(`Tokens: ${ptok} in + ${ctok} out ≈ $${cost.toFixed(4)}  (~$${(cost / Math.max(wrote, 1) * 1000).toFixed(2)} per 1000 pages)`);
await pool.end();
