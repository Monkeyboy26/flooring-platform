// SEO Phase 4 — AI pillar-guide content engine.
//
// Fills meta_title/meta_description/intro_html/content_html + a FAQ (stored in
// filter_json.faq) on type='guide' rows (from build-guides.mjs). renderGuidePage
// emits the body + Article/FAQPage JSON-LD. Long-form (600–900 words) authority copy.
//
//   node scripts/seo/generate-guide-content.mjs [--limit N] [--concurrency N]
//       [--model NAME] [--force] [--dry-run]
//   docker compose exec -T api node scripts/seo/generate-guide-content.mjs
//
// IDEMPOTENT via content_hash (slug + angle + prompt/model version). Never overwrites
// content_status='reviewed'. Grounded in the guide's angle + related categories;
// invents no prices/specs/warranties. gpt-4o (default) for higher-quality long-form.

import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '50'), 10);
const CONC = parseInt(arg('--concurrency', '3'), 10);
const MODEL = arg('--model', process.env.SEO_GUIDE_MODEL || 'gpt-4o');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const PROMPT_VERSION = 'v1';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { rows } = await pool.query(`
  SELECT id, slug, title, content_status, content_hash, filter_json
  FROM landing_pages
  WHERE type = 'guide' AND content_status <> 'reviewed'
  ORDER BY (content_status = 'none') DESC, slug
  LIMIT ${LIMIT}
`);
console.log(`${rows.length} guides (model ${MODEL}${DRY_RUN ? ', DRY RUN' : ''})`);

function hashInputs(p) {
  return crypto.createHash('sha256').update(JSON.stringify({
    v: PROMPT_VERSION, model: MODEL, slug: p.slug, angle: (p.filter_json || {}).angle || '',
  })).digest('hex');
}

const SCHEMA = {
  name: 'seo_guide_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'intro_html', 'content_html', 'faq'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars; compelling, includes the core topic' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led summary of the guide' },
      intro_html: { type: 'string', description: '1 short <p> lede (2–3 sentences) that frames the guide' },
      content_html: { type: 'string', description: '600–900 words of ORIGINAL, genuinely useful buying-guide body. Use <h2> section headings and <p>/<ul>/<li>. NO <h1>/<script>/<style>. Practical, specific, honest. Do NOT invent prices, specific product names, warranties, or brand claims — give guidance and ranges/tradeoffs. American English.' },
      faq: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string', description: '1–3 sentence answer, no fabricated specifics' } } } },
    },
  },
};

function buildPrompt(p) {
  const fj = p.filter_json || {};
  return (
    `Write an original, expert flooring/tile BUYING GUIDE for Roma Flooring Designs (an Anaheim, CA flooring & tile retailer + installer).\n` +
    `Guide title: ${p.title}\n` +
    (fj.angle ? `Cover these angles: ${fj.angle}\n` : '') +
    (fj.related && fj.related.length ? `Relevant product categories we sell (reference the material types naturally, do not list our SKUs): ${fj.related.join(', ')}\n` : '') +
    `\nWrite for a homeowner or designer researching a purchase. Be genuinely helpful, specific, and honest about tradeoffs. ` +
    `Do NOT invent prices, dollar figures, specific product/brand names, warranties, or statistics — give practical guidance, ` +
    `comparisons, and ranges/rules-of-thumb only. Natural, authoritative, non-salesy tone. American English.`
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let dailyCapHit = false;

async function generateContent(p) {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(p) }],
        response_format: { type: 'json_schema', json_schema: SCHEMA },
        max_tokens: 2200, temperature: 0.6,
      });
      return { out: JSON.parse(resp.choices[0].message.content), ptok: resp.usage?.prompt_tokens || 0, ctok: resp.usage?.completion_tokens || 0 };
    } catch (e) {
      const msg = e?.message || '';
      if (e?.status === 429) {
        if (/per day|\bRPD\b/i.test(msg)) { dailyCapHit = true; throw e; }
        if (attempt < 5) { const h = parseFloat((msg.match(/try again in ([\d.]+)s/) || [])[1]); await sleep((Number.isFinite(h) ? h * 1000 : Math.min(2 ** attempt * 1000, 30000)) + 250); continue; }
      }
      throw e;
    }
  }
}

let done = 0, wrote = 0, skipped = 0, errs = 0, ptok = 0, ctok = 0, cursor = 0;

async function worker() {
  while (cursor < rows.length && !dailyCapHit) {
    const p = rows[cursor++];
    const hash = hashInputs(p);
    if (!FORCE && p.content_status === 'generated' && p.content_hash === hash) { skipped++; done++; continue; }
    try {
      const { out, ptok: pt, ctok: ct } = await generateContent(p);
      ptok += pt; ctok += ct;
      if (DRY_RUN) {
        console.log(`\n— ${p.slug}\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  body:  ${out.content_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}…\n  faq:   ${out.faq.length} Q`);
      } else {
        await pool.query(
          `UPDATE landing_pages SET meta_title=$2, meta_description=$3, intro_html=$4, content_html=$5,
               filter_json = filter_json || jsonb_build_object('faq', $6::jsonb),
               content_status='generated', content_hash=$7, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [p.id, out.meta_title, out.meta_description, out.intro_html, out.content_html, JSON.stringify(out.faq), hash]);
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${p.slug}: ${e.message}`); }
    done++;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// gpt-4o pricing: $2.50 / 1M in, $10 / 1M out (override if --model differs).
const cost = (ptok / 1e6) * 2.5 + (ctok / 1e6) * 10;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after reset (idempotent).`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${skipped} skipped, ${errs} errors ≈ $${cost.toFixed(4)}`);
await pool.end();
