// SEO — AI brand content engine.
//
// Populates brand_pages (slug, brand_name, meta_*, intro_html, footer_html,
// product_count) for the customer-facing brand universe = COALESCE(brand.name,
// vendor.name) over active products, excluding white-labeled (hide_public_name)
// names. renderBrandPage() in seoRenderer.js and the storefront /brands/:slug
// page PREFER these stored fields, so each brand page reads as unique, authoritative
// copy instead of a bare grid.
//
//   node scripts/seo/generate-brand-content.mjs [--limit N] [--concurrency N]
//       [--model NAME] [--force] [--dry-run]
//
// Run inside the api container:
//   docker compose exec -T api node scripts/seo/generate-brand-content.mjs --dry-run
//
// Idempotent: a brand that already has intro_html is SKIPPED unless --force. Copy is
// EVERGREEN (no baked-in counts/prices). Grounds each brand in its real categories,
// looks/colors, and sample products. PROVIDER: OpenAI, same as the category engine.

import OpenAI from 'openai';
import { pool } from '../../db.js';
import { slugifyBrand } from '../../routes/brands.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '500'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Ensure the table exists (mirrors routes/brands.js DDL) so the generator is
// self-sufficient on a fresh environment.
await pool.query(`
  CREATE TABLE IF NOT EXISTS brand_pages (
    slug text PRIMARY KEY, brand_name text NOT NULL UNIQUE,
    meta_title text, meta_description text, intro_html text, footer_html text,
    product_count integer DEFAULT 0, is_active boolean DEFAULT true,
    created_at timestamp DEFAULT CURRENT_TIMESTAMP, updated_at timestamp DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_brand_pages_active ON brand_pages (is_active) WHERE is_active = true;
`);

// Per-brand grounding: product count, top categories, top colors/looks/materials,
// and sample product names — from live active inventory. Keyed by public brand name.
const { rows } = await pool.query(`
  WITH brand_products AS (
    SELECT COALESCE(br.name, v.name) AS brand_name, p.id AS product_id, p.category_id,
           COALESCE(p.display_name, p.name) AS pname
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN brands br ON br.id = p.brand_id
    WHERE p.status = 'active'
      AND NOT (COALESCE(br.hide_public_name,false) OR COALESCE(v.hide_public_name,false))
  )
  SELECT bp.brand_name,
         count(DISTINCT bp.product_id)::int AS product_count,
         (SELECT array_agg(x.cn) FROM (
            SELECT c.name AS cn, count(*) n FROM brand_products b2
            JOIN categories c ON c.id = b2.category_id
            WHERE b2.brand_name = bp.brand_name GROUP BY c.name ORDER BY n DESC LIMIT 6
          ) x) AS top_categories,
         (SELECT array_agg(x.v) FROM (
            SELECT sa.value AS v, count(*) n FROM brand_products b2
            JOIN skus s ON s.product_id = b2.product_id AND s.status='active'
            JOIN sku_attributes sa ON sa.sku_id = s.id AND sa.value<>''
            JOIN attributes a ON a.id = sa.attribute_id AND a.slug IN ('color','look','material','finish')
            WHERE b2.brand_name = bp.brand_name GROUP BY sa.value ORDER BY n DESC LIMIT 10
          ) x) AS top_values,
         (SELECT array_agg(x.pn) FROM (
            SELECT DISTINCT b2.pname AS pn FROM brand_products b2
            WHERE b2.brand_name = bp.brand_name LIMIT 8
          ) x) AS sample_products
  FROM brand_products bp
  GROUP BY bp.brand_name
  HAVING count(DISTINCT bp.product_id) > 0
  ORDER BY product_count DESC
  LIMIT ${LIMIT}
`);

// Existing copy (to honor idempotency without --force).
const existing = new Map();
try {
  const e = await pool.query(`SELECT brand_name, intro_html FROM brand_pages`);
  e.rows.forEach(r => existing.set(r.brand_name, r.intro_html));
} catch { /* fresh */ }

const candidates = rows.filter(r => FORCE || !(existing.get(r.brand_name) && existing.get(r.brand_name).trim()));
console.log(`${candidates.length} brands to generate (${rows.length} public brands total, model ${MODEL}${DRY_RUN ? ', DRY RUN' : ''})`);

const SCHEMA = {
  name: 'seo_brand_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'intro_html', 'footer_html'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars; lead with the brand name; append " | Roma Flooring Designs" only if it fits' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led, unique to THIS brand; NO specific product counts, prices, or numbers that could go stale' },
      intro_html: { type: 'string', description: '2 short <p> paragraphs introducing this brand as carried by Roma — who the brand is, the kinds of products/looks they offer, and why a shopper might choose them. Plain <p> tags only; no <h1>/<script>/<style>; no fabricated specs, prices, counts, awards, or history you are unsure of' },
      footer_html: { type: 'string', description: '1 short <p> of evergreen guidance on shopping this brand at Roma (e.g. requesting samples, coordinating products, getting a quote). Plain <p> only; no prices/counts' },
    },
  },
};

function buildPrompt(b) {
  const cats = (b.top_categories || []).filter(Boolean).slice(0, 6);
  const vals = (b.top_values || []).filter(Boolean).slice(0, 10);
  const samples = (b.sample_products || []).filter(Boolean).slice(0, 8);
  return (
    `Write SEO copy for a BRAND landing page on Roma Flooring Designs, a flooring/tile e-commerce store in Anaheim, CA.\n` +
    `Brand: ${b.brand_name}\n` +
    (cats.length ? `Product categories carried from this brand: ${cats.join(', ')}\n` : '') +
    (vals.length ? `Common colors/looks/finishes/materials: ${vals.join(', ')}\n` : '') +
    (samples.length ? `Representative products: ${samples.join('; ')}\n` : '') +
    `\nThis page lists every ${b.brand_name} product Roma carries. Write ORIGINAL copy that helps a ` +
    `homeowner or designer understand what ${b.brand_name} offers and why to consider it, grounded ONLY ` +
    `in the categories/looks above. Do NOT invent company history, founding dates, awards, ` +
    `certifications, specs, prices, or counts. Keep it evergreen and distinct from other brands. ` +
    `Natural, confident tone. American English.`
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let dailyCapHit = false;

async function generateContent(b) {
  let resp;
  for (let attempt = 0; ; attempt++) {
    try {
      resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(b) }],
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

let wrote = 0, errs = 0, ptok = 0, ctok = 0, dupWarnings = 0;
const seenDesc = new Set();
let cursor = 0;

async function worker() {
  while (cursor < candidates.length && !dailyCapHit) {
    const b = candidates[cursor++];
    const slug = slugifyBrand(b.brand_name);
    try {
      const { out, ptok: pt, ctok: ct } = await generateContent(b);
      ptok += pt; ctok += ct;

      const norm = (out.meta_description || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm && seenDesc.has(norm)) { dupWarnings++; console.warn(`  ⚠ duplicate description: ${b.brand_name}`); }
      else seenDesc.add(norm);

      if (DRY_RUN) {
        console.log(`\n— ${b.brand_name}  (/brands/${slug}, ${b.product_count} products)\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  intro: ${out.intro_html.replace(/\s+/g, ' ').slice(0, 180)}…`);
      } else {
        await pool.query(
          `INSERT INTO brand_pages (slug, brand_name, meta_title, meta_description, intro_html, footer_html, product_count, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP)
           ON CONFLICT (slug) DO UPDATE SET
             brand_name=EXCLUDED.brand_name, meta_title=EXCLUDED.meta_title,
             meta_description=EXCLUDED.meta_description, intro_html=EXCLUDED.intro_html,
             footer_html=EXCLUDED.footer_html, product_count=EXCLUDED.product_count,
             updated_at=CURRENT_TIMESTAMP`,
          [slug, b.brand_name, out.meta_title, out.meta_description, out.intro_html, out.footer_html, b.product_count]
        );
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${b.brand_name}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after reset (skips brands that already have intro_html).`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${errs} errors, ${dupWarnings} dup-description warnings`);
console.log(`Tokens: ${ptok} in + ${ctok} out ≈ $${cost.toFixed(4)}`);
await pool.end();
