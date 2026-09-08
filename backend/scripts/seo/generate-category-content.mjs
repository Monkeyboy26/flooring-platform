// SEO Phase 2 — AI category content engine.
//
// Fills unique meta_title / meta_description / intro_html / footer_html on the
// categories table (columns added by database/migrations/2026-09-07-seo-phase0.sql).
// renderCategoryPage() in backend/services/seoRenderer.js already PREFERS these
// stored fields over its templated fallback, so this makes every category page
// (money pages: /shop/{category}) read as unique, authoritative copy instead of a
// bare product grid.
//
//   node scripts/seo/generate-category-content.mjs [--limit N] [--concurrency N]
//       [--model NAME] [--force] [--dry-run]
//
// Run inside the api container:
//   docker compose exec -T api node scripts/seo/generate-category-content.mjs --dry-run
//
// Only ~81 active categories, so idempotency is simple: a category that already has
// intro_html is SKIPPED unless --force (no content_hash column needed). Copy is kept
// EVERGREEN (no baked-in counts/prices). Grounds each category in its real top
// brands, colors/looks, and sample products so intros are specific, not boilerplate.
//
// PROVIDER: OpenAI, same as the product/landing engines. Model call isolated in
// generateContent().

import OpenAI from 'openai';
import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '200'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Candidate categories ─────────────────────────────────────────────────────
// Active categories, untouched (no intro_html) first unless --force. Grounding:
// parent name for hierarchy, plus top brands / top color & look values / sample
// product names drawn from live active inventory in that category (and descendants).
const { rows } = await pool.query(`
  WITH cat_tree AS (
    -- products in this category OR any descendant category
    SELECT c.id AS cat_id, p.id AS product_id
    FROM categories c
    JOIN categories d ON (d.id = c.id OR d.parent_id = c.id)
    JOIN products p ON p.category_id = d.id AND p.status = 'active'
    WHERE c.is_active = true
  )
  SELECT c.id, c.name, c.slug, c.description, c.intro_html,
         par.name AS parent_name,
         (SELECT count(DISTINCT ct.product_id) FROM cat_tree ct WHERE ct.cat_id = c.id) AS product_count,
         (SELECT array_agg(x.b) FROM (
            SELECT DISTINCT COALESCE(br.name, v.name) AS b
            FROM cat_tree ct JOIN products p ON p.id = ct.product_id
            JOIN vendors v ON v.id = p.vendor_id
            LEFT JOIN brands br ON br.id = p.brand_id
            WHERE ct.cat_id = c.id
              AND NOT (COALESCE(br.hide_public_name,false) OR COALESCE(v.hide_public_name,false))
            LIMIT 8
          ) x) AS brands,
         (SELECT array_agg(x.v) FROM (
            SELECT sa.value AS v, count(*) n
            FROM cat_tree ct JOIN skus s ON s.product_id = ct.product_id AND s.status='active'
            JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.value<>''
            JOIN attributes a ON a.id = sa.attribute_id AND a.slug IN ('color','look','material','finish')
            WHERE ct.cat_id = c.id
            GROUP BY sa.value ORDER BY n DESC LIMIT 10
          ) x) AS top_values,
         (SELECT array_agg(x.pn) FROM (
            SELECT DISTINCT COALESCE(p.display_name, p.name) AS pn
            FROM cat_tree ct JOIN products p ON p.id = ct.product_id
            WHERE ct.cat_id = c.id LIMIT 8
          ) x) AS sample_products
  FROM categories c
  LEFT JOIN categories par ON par.id = c.parent_id
  WHERE c.is_active = true
  ORDER BY (c.intro_html IS NULL OR c.intro_html = '') DESC, c.name
  LIMIT ${LIMIT}
`);

// Skip empty categories — a page with no products is thin/nothing to describe.
const candidates = rows
  .filter(r => parseInt(r.product_count, 10) > 0)
  .filter(r => FORCE || !(r.intro_html && r.intro_html.trim()));
const empties = rows.filter(r => parseInt(r.product_count, 10) === 0).length;
console.log(`${candidates.length} categories to generate (${rows.length} active total, ${empties} empty skipped, model ${MODEL}${DRY_RUN ? ', DRY RUN' : ''})`);

const SCHEMA = {
  name: 'seo_category_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'intro_html', 'footer_html'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars; lead with the category name; append " | Roma Flooring Designs" only if it fits' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led, unique to THIS category; NO specific product counts, prices, or numbers that could go stale' },
      intro_html: { type: 'string', description: '2 short <p> paragraphs introducing this category — what it is, its range (looks/colors/uses), and how to choose. Plain <p> tags only; no <h1>/<script>/<style>; no fabricated specs, prices, or counts' },
      footer_html: { type: 'string', description: '1 short <p> of evergreen buying/design guidance for this category (e.g. where it fits, coordinating options, care). Plain <p> only; no prices/counts' },
    },
  },
};

function buildPrompt(c) {
  const brands = (c.brands || []).filter(Boolean).slice(0, 8);
  const vals = (c.top_values || []).filter(Boolean).slice(0, 10);
  const samples = (c.sample_products || []).filter(Boolean).slice(0, 8);
  return (
    `Write SEO copy for a product category page on Roma Flooring Designs, a flooring/tile e-commerce store.\n` +
    `Category: ${c.name}\n` +
    (c.parent_name ? `Parent category: ${c.parent_name}\n` : '') +
    (c.description ? `Existing description (reference only, do NOT copy): ${c.description.slice(0, 400)}\n` : '') +
    (brands.length ? `Brands carried: ${brands.join(', ')}\n` : '') +
    (vals.length ? `Common colors/looks/finishes here: ${vals.join(', ')}\n` : '') +
    (samples.length ? `Representative products: ${samples.join('; ')}\n` : '') +
    `\nThis page lists every ${c.name.toLowerCase()} product we carry. Write ORIGINAL copy that ` +
    `helps a homeowner or designer understand this category and choose. Ground claims in the ` +
    `brands/looks above; invent NO specs, prices, warranties, certifications, or counts. Keep it ` +
    `evergreen. Distinct from sibling categories. Natural, confident tone. American English.`
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let dailyCapHit = false;

async function generateContent(c) {
  let resp;
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(c) }],
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
let done = 0, wrote = 0, errs = 0, ptok = 0, ctok = 0;
const seenDesc = new Set();
let dupWarnings = 0;
let cursor = 0;

async function worker() {
  while (cursor < candidates.length && !dailyCapHit) {
    const c = candidates[cursor++];
    try {
      const { out, ptok: pt, ctok: ct } = await generateContent(c);
      ptok += pt; ctok += ct;

      const norm = (out.meta_description || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm && seenDesc.has(norm)) { dupWarnings++; console.warn(`  ⚠ duplicate description: ${c.name}`); }
      else seenDesc.add(norm);

      if (DRY_RUN) {
        console.log(`\n— ${c.name}  (/shop/${c.slug}, ${c.product_count} products)\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  intro: ${out.intro_html.replace(/\s+/g, ' ').slice(0, 180)}…`);
      } else {
        await pool.query(
          `UPDATE categories SET meta_title=$2, meta_description=$3, intro_html=$4, footer_html=$5
           WHERE id=$1`,
          [c.id, out.meta_title, out.meta_description, out.intro_html, out.footer_html]
        );
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${c.name}: ${e.message}`); }
    done++;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after it resets (skips categories that already have intro_html).`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${errs} errors, ${dupWarnings} dup-description warnings`);
console.log(`Tokens: ${ptok} in + ${ctok} out ≈ $${cost.toFixed(4)}`);
await pool.end();
