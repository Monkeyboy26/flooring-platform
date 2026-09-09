// SEO Phase 3 — AI local-page content engine.
//
// Fills unique meta_title / meta_description / intro_html / footer_html on the
// type='local' landing_pages rows (minted by build-local-pages.mjs). Without this
// every city page shares near-identical templated copy — the duplicate-content risk
// that matters most across 30+ near-identical local pages. renderLocalPage prefers
// these stored fields, else falls back to templated per-city copy.
//
//   node scripts/seo/generate-local-content.mjs [--limit N] [--concurrency N]
//       [--model NAME] [--force] [--dry-run]
//   docker compose exec -T api node scripts/seo/generate-local-content.mjs
//
// IDEMPOTENT via content_hash (city + county + prompt/model version). Never
// overwrites content_status='reviewed'. Evergreen copy (no counts/prices).

import crypto from 'crypto';
import OpenAI from 'openai';
import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '100'), 10);
const CONC = parseInt(arg('--concurrency', '4'), 10);
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const PROMPT_VERSION = 'v1';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const { rows } = await pool.query(`
  SELECT id, slug, title, content_status, content_hash,
         filter_json->>'city' AS city, filter_json->>'county' AS county
  FROM landing_pages
  WHERE type = 'local' AND content_status <> 'reviewed'
  ORDER BY (content_status = 'none') DESC, slug
  LIMIT ${LIMIT}
`);
console.log(`${rows.length} local pages (model ${MODEL}${DRY_RUN ? ', DRY RUN' : ''})`);

function hashInputs(p) {
  return crypto.createHash('sha256').update(JSON.stringify({
    v: PROMPT_VERSION, model: MODEL, city: p.city, county: p.county,
  })).digest('hex');
}

const SCHEMA = {
  name: 'seo_local_content',
  strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    required: ['meta_title', 'meta_description', 'intro_html', 'footer_html'],
    properties: {
      meta_title: { type: 'string', description: '≤60 chars; e.g. "Flooring Installation in {City}, CA | Roma Flooring Designs" — trim to fit' },
      meta_description: { type: 'string', description: '140–155 chars, benefit-led, unique to THIS city; mention the city; NO prices/counts' },
      intro_html: { type: 'string', description: '2 short <p> paragraphs of UNIQUE intro copy for flooring installation in this specific city — reference the city/area naturally, the licensed/insured local crew, materials installed, and free estimates. Plain <p> tags only; no <h1>/<script>/<style>; no fabricated prices, specific project counts, or fake local landmarks' },
      footer_html: { type: 'string', description: '1 short <p> of evergreen guidance (why choose a licensed local installer, showroom in Anaheim, workmanship warranty). Plain <p> only; no prices/counts' },
    },
  },
};

function buildPrompt(p) {
  return (
    `Write SEO copy for a local flooring-installation service page for Roma Flooring Designs, ` +
    `a licensed flooring/tile retailer and installer based in Anaheim, CA (CA Contractor License #830966).\n` +
    `City: ${p.city}\nCounty: ${p.county}\n` +
    `This page targets homeowners in ${p.city} searching for flooring installation. Write ORIGINAL copy ` +
    `distinct from other city pages — reference ${p.city} and ${p.county} naturally, but do NOT invent ` +
    `specific landmarks, neighborhoods, prices, project counts, or review quotes. Cover: licensed & insured ` +
    `installation, materials (hardwood, tile, luxury vinyl, natural stone, carpet, laminate), free estimates, ` +
    `and the Anaheim showroom serving the area. Natural, confident, trustworthy tone. American English.`
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
        max_tokens: 700, temperature: 0.6,
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
      const { out, ptok: pt, ctok: ct } = await generateContent(p);
      ptok += pt; ctok += ct;
      const norm = (out.meta_description || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (norm && seen.has(norm)) { dup++; console.warn(`  ⚠ duplicate description: ${p.city}`); } else seen.add(norm);
      if (DRY_RUN) {
        console.log(`\n— ${p.city}, ${p.county}\n  title: ${out.meta_title}\n  desc:  ${out.meta_description}\n  intro: ${out.intro_html.replace(/\s+/g, ' ').slice(0, 160)}…`);
      } else {
        await pool.query(
          `UPDATE landing_pages SET meta_title=$2, meta_description=$3, intro_html=$4, footer_html=$5,
               content_status='generated', content_hash=$6, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [p.id, out.meta_title, out.meta_description, out.intro_html, out.footer_html, hash]);
      }
      wrote++;
    } catch (e) { errs++; console.error(`  ✗ ${p.city}: ${e.message}`); }
    done++;
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const cost = (ptok / 1e6) * 0.15 + (ctok / 1e6) * 0.60;
if (dailyCapHit) console.log(`\n⚠ Stopped early: OpenAI daily request cap (RPD) reached. Re-run after reset (idempotent).`);
console.log(`\nDone: ${wrote} ${DRY_RUN ? 'generated (dry run)' : 'written'}, ${skipped} skipped, ${errs} errors, ${dup} dup warnings ≈ $${cost.toFixed(4)}`);
await pool.end();
