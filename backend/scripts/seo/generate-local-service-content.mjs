// AI content engine for per-city service pages (local_material + remodel).
//
// Fills unique meta_title / meta_description / intro_html / content_html / footer_html and a
// FAQ (stored in filter_json.faq) on the rows minted by build-local-service-pages.mjs.
// renderMaterialPage / renderRemodelPage prefer these stored fields, else templated copy.
//
//   node scripts/seo/generate-local-service-content.mjs [--kind material|remodel|all]
//       [--limit N] [--concurrency N] [--model NAME] [--force] [--dry-run]
//   docker compose exec -T api node scripts/seo/generate-local-service-content.mjs
//
// IDEMPOTENT via content_hash (city + service + prompt/model version). Never overwrites
// content_status='reviewed'. Evergreen copy — no prices, project counts, fake landmarks,
// or invented reviews. Each page is written to be genuinely distinct (material-/room- and
// city-specific), not a template city-swap.

import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const KIND = arg('--kind', 'all'); // material | remodel | all
const LIMIT = parseInt(arg('--limit', '500'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const PROMPT_VERSION = 'v1';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const types = KIND === 'material' ? ['local_material'] : KIND === 'remodel' ? ['remodel'] : ['local_material', 'remodel'];
const { rows } = await pool.query(`
  SELECT id, type, slug, title, content_status, content_hash, filter_json
  FROM landing_pages
  WHERE type = ANY($1) AND content_status <> 'reviewed'
  ORDER BY (content_status = 'none') DESC, type, slug
  LIMIT ${LIMIT}
`, [types]);
console.log(`${rows.length} service pages (kind=${KIND}, model ${MODEL}${DRY_RUN ? ', DRY RUN' : ''})`);

function subjectKey(p) {
  const fj = p.filter_json || {};
  if (p.type === 'local_material') return `mat:${fj.materialSlug}`;
  return `remodel:${fj.room ? fj.room.slug : 'hub'}`;
}
function hashInputs(p) {
  const fj = p.filter_json || {};
  return crypto.createHash('sha256').update(JSON.stringify({
    v: PROMPT_VERSION, model: MODEL, city: fj.city, county: fj.county, subject: subjectKey(p),
  })).digest('hex');
}

const SCHEMA = {
  name: 'seo_local_service_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'intro_html', 'content_html', 'footer_html', 'faq'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars, includes the service + city; may append "| Roma Flooring Designs" only if it fits' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led, unique to THIS city+service; mention the city; NO prices/counts' },
      intro_html: { type: 'string', description: '2 short <p> paragraphs, unique to this city + service. Reference the city/county naturally and the licensed local crew. Plain <p> only; no headings/script/style; no fabricated prices, project counts, or landmarks' },
      content_html: { type: 'string', description: '3–4 <h2> sections (each with 1–2 <p>, optionally one <ul>) of genuinely useful, service- and city-specific body copy — e.g. what the install/remodel involves, subfloor/site considerations for the area, materials & options, the process, and why licensed local matters. ~500–700 words. Only <h2>/<h3>/<p>/<ul>/<li>/<strong>/<em> tags; no <h1>/<script>/<style>; no fabricated prices, stats, or landmarks' },
      footer_html: { type: 'string', description: '1 short <p> of evergreen trust copy (licensed/insured, Anaheim showroom, workmanship warranty, free estimate). Plain <p> only; no prices/counts' },
      faq: { type: 'array', minItems: 3, maxItems: 5, description: '3–5 genuinely useful Q&As specific to this service + city',
        items: { type: 'object', additionalProperties: false, required: ['question', 'answer'],
          properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
    },
  },
};

function buildPrompt(p) {
  const fj = p.filter_json || {};
  const base = `You are writing SEO copy for Roma Flooring Designs — a licensed flooring, tile, stone, and countertop retailer and installer based in Anaheim, CA (CA Contractor License #830966), serving Orange County and nearby LA & Riverside counties.\n` +
    `City: ${fj.city}\nCounty: ${fj.county}\n`;
  const rules = `\nWrite ORIGINAL copy distinct from other city and service pages. Reference ${fj.city} and ${fj.county} naturally, but do NOT invent specific landmarks, neighborhoods, prices, project counts, timelines in dollars, or review quotes. Natural, confident, trustworthy tone. American English.`;
  if (p.type === 'local_material') {
    const m = fj.material || {};
    return base +
      `Page: ${m.name} installation in ${fj.city}.\n` +
      `Focus specifically on ${m.name} — its installation methods, subfloor/moisture/site prep relevant to homes in this area, durability and style options, the install process, and the value of a licensed local crew. Mention that customers can shop ${m.name.toLowerCase()} in the Anaheim showroom and get a free estimate.` +
      rules;
  }
  // remodel
  const room = fj.room;
  if (!room) {
    return base +
      `Page: kitchen & bathroom remodeling in ${fj.city} (a hub page).\n` +
      `Cover full-surface kitchen and bath remodeling — flooring, wall/shower/backsplash tile, countertops, and cabinetry — supplied and installed by one licensed crew from the Anaheim showroom. Explain the single-point-of-accountability advantage, material selection help, and free estimates. Do not overstate scope beyond flooring/tile/countertops/cabinetry.` +
      rules;
  }
  return base +
    `Page: ${room.name} in ${fj.city}.\n` +
    `Focus on ${room.name.toLowerCase()} — the surfaces Roma supplies and installs (${room.slug === 'kitchen' ? 'flooring, backsplash/wall tile, countertops, cabinetry' : 'waterproofed shower & floor tile, vanities, countertops, natural stone'}), the process, site considerations, and the value of one licensed crew handling supply + install. Mention showroom material selection and free estimates. Do not overstate scope beyond flooring/tile/countertops/cabinetry.` +
    rules;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let dailyCapHit = false;

async function generate(p) {
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(p) }],
        response_format: { type: 'json_schema', json_schema: SCHEMA },
        max_tokens: 1600, temperature: 0.6,
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
const seen = new Set(); let dup = 0;

async function worker() {
  while (cursor < rows.length && !dailyCapHit) {
    const p = rows[cursor++];
    const hash = hashInputs(p);
    if (!FORCE && p.content_status === 'generated' && p.content_hash === hash) { skipped++; done++; continue; }
    try {
      const { out, ptok: pt, ctok: ct } = await generate(p);
      ptok += pt; ctok += ct;
      const norm = (out.meta_description || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm && seen.has(norm)) { dup++; console.warn(`  ⚠ duplicate description: ${p.slug}`); } else seen.add(norm);
      const faq = JSON.stringify({ faq: (out.faq || []).map(f => [f.question, f.answer]) });
      if (DRY_RUN) {
        console.log(`\n— ${p.slug} [${p.type}]\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  body:  ${out.content_html.replace(/\s+/g, ' ').slice(0, 140)}…  (${out.faq.length} FAQ)`);
      } else {
        await pool.query(
          `UPDATE landing_pages SET meta_title=$2, meta_description=$3, intro_html=$4, content_html=$5, footer_html=$6,
               filter_json = filter_json || $7::jsonb,
               content_status='generated', content_hash=$8, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [p.id, out.meta_title, out.meta_description, out.intro_html, out.content_html, out.footer_html, faq, hash]);
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${p.slug}: ${e.message}`); }
    done++;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after reset (idempotent).`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${skipped} skipped, ${errs} errors, ${dup} dup warnings ≈ $${cost.toFixed(4)}`);
await pool.end();
