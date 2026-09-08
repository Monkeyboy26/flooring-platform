// SEO Phase 1 — AI product content via the OpenAI BATCH API.
//
// Same output as generate-product-content.mjs, but routed through OpenAI's Batch API:
//   • 50% cheaper  • async (results within 24h)  • uses a SEPARATE, much larger quota
//     than the per-model daily request cap (RPD) — so it sidesteps the Tier-1 10k/day
//     limit that blocks the synchronous script on large catalogs.
//
// Three subcommands:
//   node scripts/seo/batch-product-content.mjs submit  [--limit N] [--chunk N] [--category SLUG] [--vendor CODE] [--model M] [--dry-run]
//   node scripts/seo/batch-product-content.mjs status
//   node scripts/seo/batch-product-content.mjs ingest  [--force]
//
// Flow: submit → (wait ≤24h) → status (poll) → ingest (writes results to DB).
// State lives in OpenAI: batches are tagged metadata.purpose='seo-content'; status and
// ingest auto-discover them, so there is no local state file. Ingest is idempotent
// (content_hash guard, never overwrites content_status='reviewed'), so re-running is safe.
//
// Run inside the api container:
//   docker compose exec -T api node scripts/seo/batch-product-content.mjs submit
//
// ⚠️ The prompt/schema/hash/candidate-query below are DUPLICATED from
//    generate-product-content.mjs and MUST be kept in sync (mirrored copies, per the
//    repo's classifier convention). Bump PROMPT_VERSION in BOTH when the contract changes.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import OpenAI from 'openai';
import { pool } from '../../db.js';

const CMD = process.argv[2];
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '26000'), 10);
const CHUNK = parseInt(arg('--chunk', '10000'), 10);   // requests per batch file (≤50k API cap)
const CATEGORY = arg('--category', null);
const VENDOR = arg('--vendor', null);
const MODEL = arg('--model', process.env.SEO_CONTENT_MODEL || 'gpt-4o-mini');
const FORCE = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
const TAG = 'seo-content';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── keep-in-sync block (mirror of generate-product-content.mjs) ───────────────
const PROMPT_VERSION = 'v1';
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
const CANDIDATE_COLS = `
  p.id, COALESCE(p.display_name, p.name) AS name, p.collection,
  p.description_short, p.description_long, p.content_hash, p.content_status,
  c.name AS category_name, c.slug AS category_slug,
  COALESCE(br.name, v.name) AS brand_name,
  (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false)) AS brand_hidden,
  v.code AS vendor_code,
  COALESCE((
    SELECT json_agg(json_build_object('name', a.name, 'value', sa.value) ORDER BY a.display_order, a.name)
    FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id JOIN attributes a ON a.id = sa.attribute_id
    WHERE s.product_id = p.id AND s.status = 'active' AND sa.value <> ''
  ), '[]'::json) AS attributes`;
const CANDIDATE_JOINS = `
  FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN brands br ON br.id = p.brand_id
  LEFT JOIN categories c ON c.id = p.category_id`;
// ── end keep-in-sync block ────────────────────────────────────────────────────

const seoBatches = async () => {
  const out = [];
  for await (const b of client.batches.list({ limit: 100 })) {
    if (b.metadata && b.metadata.purpose === TAG) out.push(b);
  }
  return out;
};

async function writeDbRow(cx, id, out, hash) {
  await cx.query(
    `UPDATE products SET meta_title=$2, meta_description=$3, seo_h1=$4, content_html=$5,
         content_status='generated', content_hash=$6, updated_at=CURRENT_TIMESTAMP
     WHERE id=$1`,
    [id, out.meta_title, out.meta_description, out.seo_h1, out.content_html, hash]
  );
  await cx.query(
    `UPDATE media_assets SET alt_text=$2
     WHERE product_id=$1 AND asset_type <> 'spec_pdf'
       AND (${FORCE ? 'TRUE' : "alt_text IS NULL OR alt_text = ''"})`,
    [id, out.image_alt]
  );
}

// ── submit ────────────────────────────────────────────────────────────────────
async function submit() {
  const { rows } = await pool.query(`
    SELECT ${CANDIDATE_COLS}
    ${CANDIDATE_JOINS}
    WHERE p.status = 'active' AND p.content_status = 'none'
      AND ($1::text IS NULL OR c.slug = $1)
      AND ($2::text IS NULL OR v.code = $2)
    ORDER BY md5(p.id::text)
    LIMIT ${LIMIT}
  `, [CATEGORY, VENDOR]);

  console.log(`${rows.length} candidate products → ${Math.ceil(rows.length / CHUNK)} batch(es) of ≤${CHUNK} (model ${MODEL})`);
  if (!rows.length) { console.log('Nothing to submit.'); return; }

  // Batch pricing = 50% of sync. gpt-4o-mini batch: $0.075/1M in, $0.30/1M out.
  console.log(`Est. cost ≈ $${(rows.length * 0.21 / 1000 / 2).toFixed(2)} (batch is 50% off sync).`);
  if (DRY_RUN) { console.log('DRY RUN — not uploading.'); return; }

  const submitted = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const jsonl = chunk.map(p => JSON.stringify({
      custom_id: p.id,                       // product UUID (36 chars, < 64 cap)
      method: 'POST', url: '/v1/chat/completions',
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: buildPrompt(p) }],
        response_format: { type: 'json_schema', json_schema: SCHEMA },
        max_tokens: 700, temperature: 0.5,
      },
    })).join('\n');

    const tmp = path.join(os.tmpdir(), `seo-batch-${i}-${chunk.length}.jsonl`);
    fs.writeFileSync(tmp, jsonl);
    try {
      const file = await client.files.create({ file: fs.createReadStream(tmp), purpose: 'batch' });
      const batch = await client.batches.create({
        input_file_id: file.id,
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        metadata: { purpose: TAG, model: MODEL, prompt_version: PROMPT_VERSION },
      });
      submitted.push(batch.id);
      console.log(`  ✓ batch ${batch.id} — ${chunk.length} requests (${batch.status})`);
    } catch (e) {
      console.error(`  ✗ chunk ${i}-${i + chunk.length} failed: ${e.message}`);
      console.error(`    (likely the Tier-1 batch queue-token limit — let the submitted batches finish, then re-run 'submit' to enqueue the rest.)`);
      break;
    } finally {
      fs.unlinkSync(tmp);
    }
  }
  console.log(`\nSubmitted ${submitted.length} batch(es). Poll with 'status', then 'ingest' once completed.`);
}

// ── status ─────────────────────────────────────────────────────────────────────
async function status() {
  const batches = await seoBatches();
  if (!batches.length) { console.log('No seo-content batches found.'); return; }
  for (const b of batches) {
    const c = b.request_counts || {};
    console.log(`${b.id}  ${b.status.padEnd(11)}  ${c.completed || 0}/${c.total || 0} done, ${c.failed || 0} failed  ${b.output_file_id ? '(output ready)' : ''}`);
  }
}

// ── ingest ───────────────────────────────────────────────────────────────────
async function ingest() {
  const batches = (await seoBatches()).filter(b => b.status === 'completed' && b.output_file_id);
  if (!batches.length) { console.log('No completed seo-content batches to ingest.'); return; }

  let wrote = 0, skipped = 0, failed = 0;
  for (const b of batches) {
    const resp = await client.files.content(b.output_file_id);
    const text = await resp.text();
    const lines = text.split('\n').filter(Boolean);

    // Parse results → custom_id (product id) → content object.
    const byId = new Map();
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { failed++; continue; }
      const body = r.response && r.response.body;
      const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
      if (r.response?.status_code !== 200 || !content) { failed++; continue; }
      try { byId.set(r.custom_id, JSON.parse(content)); } catch { failed++; }
    }
    if (!byId.size) continue;

    // Re-fetch product rows to compute the current hash + honor 'reviewed'.
    const ids = [...byId.keys()];
    const { rows } = await pool.query(`SELECT ${CANDIDATE_COLS} ${CANDIDATE_JOINS} WHERE p.id = ANY($1)`, [ids]);
    const rowById = new Map(rows.map(r => [r.id, r]));

    for (const [id, out] of byId) {
      const p = rowById.get(id);
      if (!p || p.content_status === 'reviewed') { skipped++; continue; }
      const hash = hashInputs(p);
      const cx = await pool.connect();
      try {
        await cx.query('BEGIN');
        await writeDbRow(cx, id, out, hash);
        await cx.query('COMMIT');
        wrote++;
      } catch (e) { await cx.query('ROLLBACK'); failed++; console.error(`  ✗ ${id}: ${e.message}`); }
      finally { cx.release(); }
    }
    console.log(`  ingested batch ${b.id}`);
  }
  console.log(`\nDone: ${wrote} written, ${skipped} skipped (reviewed/missing), ${failed} failed lines`);
}

// ── dispatch ──────────────────────────────────────────────────────────────────
try {
  if (CMD === 'submit') await submit();
  else if (CMD === 'status') await status();
  else if (CMD === 'ingest') await ingest();
  else console.log('Usage: batch-product-content.mjs <submit|status|ingest> [flags]');
} finally {
  await pool.end();
}
