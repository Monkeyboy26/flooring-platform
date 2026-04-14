import OpenAI from 'openai';
import { upsertSkuAttribute } from '../scrapers/base.js';

// ── Cost constants (GPT-4o-mini) ──
const INPUT_COST_PER_MTOK = 0.15;
const OUTPUT_COST_PER_MTOK = 0.60;

// ── Shared state ──
let openaiClient = null;
const activeJobs = new Map(); // jobId → AbortController

function getClient() {
  if (!openaiClient) {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function estimateCost(promptTokens, completionTokens) {
  return (promptTokens / 1_000_000) * INPUT_COST_PER_MTOK +
         (completionTokens / 1_000_000) * OUTPUT_COST_PER_MTOK;
}

// ── OpenAI wrapper with retry on 429 ──
async function callOpenAI(messages, opts = {}) {
  const client = getClient();
  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: opts.model || 'gpt-4o-mini',
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.max_tokens || 4096,
        ...(opts.response_format ? { response_format: opts.response_format } : {}),
      });
      const usage = response.usage || {};
      return {
        content: response.choices[0]?.message?.content || '',
        prompt_tokens: usage.prompt_tokens || 0,
        completion_tokens: usage.completion_tokens || 0,
      };
    } catch (err) {
      if (err.status === 429 && attempt < maxRetries - 1) {
        // Parse retry-after from error or use escalating backoff (20s base for low-tier accounts)
        const retryAfter = err.headers?.['retry-after'];
        const wait = retryAfter ? (parseInt(retryAfter) + 1) * 1000 : (20 + attempt * 10) * 1000;
        console.log(`[Enrichment] Rate limited, waiting ${Math.round(wait/1000)}s (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ── Generic batch processor ──
async function processBatch(items, { batchSize = 5, concurrency = 3 }, processFn) {
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  let batchIdx = 0;
  const results = { processed: 0, updated: 0, skipped: 0, failed: 0, promptTokens: 0, completionTokens: 0 };

  async function runNext() {
    while (batchIdx < batches.length) {
      const idx = batchIdx++;
      try {
        const batchResult = await processFn(batches[idx]);
        results.processed += batchResult.processed || 0;
        results.updated += batchResult.updated || 0;
        results.skipped += batchResult.skipped || 0;
        results.failed += batchResult.failed || 0;
        results.promptTokens += batchResult.promptTokens || 0;
        results.completionTokens += batchResult.completionTokens || 0;
      } catch (err) {
        console.error(`[Enrichment] Batch ${idx} error:`, err.message);
        results.failed += batches[idx].length;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batches.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ── Job progress updates ──
async function updateJobProgress(pool, jobId, counters) {
  const sets = [];
  const params = [jobId];
  let idx = 2;

  for (const [key, val] of Object.entries(counters)) {
    if (val !== undefined) {
      sets.push(`${key} = $${idx}`);
      params.push(val);
      idx++;
    }
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE enrichment_jobs SET ${sets.join(', ')} WHERE id = $1`, params);
}

async function appendJobLog(pool, jobId, message) {
  const ts = new Date().toISOString().slice(11, 19);
  await pool.query(
    `UPDATE enrichment_jobs SET log = log || $2 WHERE id = $1`,
    [jobId, `[${ts}] ${message}\n`]
  );
}

function checkCancelled(jobId) {
  const ctrl = activeJobs.get(jobId);
  if (ctrl && ctrl.signal.aborted) throw new Error('Job cancelled');
}

// ══════════════════════════════════════════════
// Feature 1: Generate Descriptions
// ══════════════════════════════════════════════

export async function generateDescriptions(pool, jobId, scope) {
  const conditions = [`p.status = 'active'`, `(p.description_long IS NULL OR LENGTH(p.description_long) < 20)`];
  const params = [];
  let idx = 1;

  if (scope.vendor_id) {
    conditions.push(`p.vendor_id = $${idx}`);
    params.push(scope.vendor_id);
    idx++;
  }
  if (scope.category_id) {
    conditions.push(`p.category_id = $${idx}`);
    params.push(scope.category_id);
    idx++;
  }
  if (scope.product_ids?.length) {
    conditions.push(`p.id = ANY($${idx})`);
    params.push(scope.product_ids);
    idx++;
  }

  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_short, p.description_long,
           v.name as vendor_name, c.name as category_name,
           (SELECT json_agg(json_build_object('variant_name', s.variant_name, 'sell_by', s.sell_by))
            FROM skus s WHERE s.product_id = p.id AND s.status = 'active' LIMIT 5) as sku_info,
           (SELECT json_agg(json_build_object('slug', a.slug, 'value', sa.value))
            FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id
            JOIN attributes a ON a.id = sa.attribute_id
            WHERE s.product_id = p.id AND s.status = 'active' LIMIT 10) as attrs
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.created_at
    LIMIT 2000
  `, params);

  await updateJobProgress(pool, jobId, { total_items: products.length, status: 'running', started_at: new Date() });
  await appendJobLog(pool, jobId, `Found ${products.length} products needing descriptions`);

  if (products.length === 0) return;

  const SYSTEM_PROMPT = `You are a product copywriter for Roma Flooring Designs, a premium flooring retailer in Southern California.
Write compelling, varied product descriptions for flooring and surface products.

Rules:
- description_short: 1-2 sentences, highlight the key selling point. Under 160 characters.
- description_long: 150-250 words. Include material benefits, design appeal, practical features, and suggested applications.
- Vary sentence structure and openings — do NOT start every description the same way.
- Mention specific attributes (material, finish, size, color) when provided.
- Professional but approachable tone. Avoid superlatives like "best" or "finest".
- Do NOT invent specifications not provided in the input data.
- Write for homeowners and trade professionals alike.

Return JSON: { "products": [{ "id": "...", "description_short": "...", "description_long": "..." }] }`;

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;

  const result = await processBatch(products, { batchSize: 5, concurrency: 1 }, async (batch) => {
    checkCancelled(jobId);

    const productData = batch.map(p => ({
      id: p.id,
      name: p.name,
      collection: p.collection,
      vendor: p.vendor_name,
      category: p.category_name,
      variants: p.sku_info,
      attributes: p.attrs,
    }));

    const response = await callOpenAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Generate descriptions for these products:\n${JSON.stringify(productData, null, 2)}` }
    ], { response_format: { type: 'json_object' }, temperature: 0.8, max_tokens: 4096 });

    let parsed;
    try { parsed = JSON.parse(response.content); } catch { return { processed: batch.length, failed: batch.length, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens }; }

    let updated = 0;
    for (const item of (parsed.products || [])) {
      if (!item.id || !item.description_long) continue;
      const product = batch.find(p => p.id === item.id);
      if (!product) continue;

      const res = await pool.query(
        `UPDATE products SET description_short = $2, description_long = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND (description_long IS NULL OR LENGTH(description_long) < 20) RETURNING id`,
        [item.id, item.description_short || null, item.description_long]
      );
      if (res.rowCount > 0) {
        updated++;
        await pool.query(
          `INSERT INTO enrichment_results (enrichment_job_id, entity_type, entity_id, field_name, old_value, new_value, confidence, status)
           VALUES ($1, 'product', $2, 'description_long', $3, $4, 0.95, 'applied'),
                  ($1, 'product', $2, 'description_short', $5, $6, 0.95, 'applied')`,
          [jobId, item.id, product.description_long || null, item.description_long, product.description_short || null, item.description_short || null]
        );
      }
    }

    totalProcessed += batch.length;
    totalUpdated += updated;
    totalPrompt += response.prompt_tokens;
    totalCompletion += response.completion_tokens;
    const cost = estimateCost(totalPrompt, totalCompletion);

    await updateJobProgress(pool, jobId, {
      processed_items: totalProcessed,
      updated_items: totalUpdated,
      prompt_tokens_used: totalPrompt,
      completion_tokens_used: totalCompletion,
      estimated_cost_usd: cost,
    });

    return { processed: batch.length, updated, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens };
  });

  await appendJobLog(pool, jobId, `Completed: ${totalUpdated} products updated, ${totalProcessed} processed`);
}

// ══════════════════════════════════════════════
// Feature 2: Extract Attributes
// ══════════════════════════════════════════════

export async function extractAttributes(pool, jobId, scope) {
  // Find SKUs missing required attributes for their category
  const conditions = [`s.status = 'active'`, `p.status = 'active'`, `c.slug IS NOT NULL`];
  const params = [];
  let idx = 1;

  if (scope.vendor_id) {
    conditions.push(`p.vendor_id = $${idx}`);
    params.push(scope.vendor_id);
    idx++;
  }
  if (scope.category_id) {
    conditions.push(`p.category_id = $${idx}`);
    params.push(scope.category_id);
    idx++;
  }

  const { rows: skus } = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.sell_by,
           p.id as product_id, p.name as product_name, p.collection,
           v.name as vendor_name, c.name as category_name, c.slug as category_slug,
           (SELECT json_agg(json_build_object('slug', a.slug, 'value', sa.value))
            FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
            WHERE sa.sku_id = s.id) as existing_attrs,
           (SELECT json_agg(cra.attribute_slug)
            FROM category_required_attributes cra
            WHERE cra.category_slug = c.slug AND cra.is_required = true
            AND NOT EXISTS (
              SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
              WHERE sa.sku_id = s.id AND a.slug = cra.attribute_slug
            )) as missing_attrs
    FROM skus s
    JOIN products p ON p.id = s.product_id
    JOIN vendors v ON v.id = p.vendor_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE ${conditions.join(' AND ')}
    HAVING (SELECT COUNT(*)
            FROM category_required_attributes cra
            WHERE cra.category_slug = c.slug AND cra.is_required = true
            AND NOT EXISTS (
              SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
              WHERE sa.sku_id = s.id AND a.slug = cra.attribute_slug
            )) > 0
    ORDER BY p.created_at
    LIMIT 3000
  `, params);

  await updateJobProgress(pool, jobId, { total_items: skus.length, status: 'running', started_at: new Date() });
  await appendJobLog(pool, jobId, `Found ${skus.length} SKUs with missing required attributes`);

  if (skus.length === 0) return;

  const SYSTEM_PROMPT = `You are a flooring product data specialist. Extract missing product attributes from the available product information.

Attribute definitions:
- material: Primary material (e.g., Porcelain, Ceramic, Oak, Walnut, Vinyl, SPC, WPC, Marble, Travertine, Quartz)
- finish: Surface finish (e.g., Matte, Polished, Honed, Brushed, Wire-Brushed, Textured, Satin, Glossy)
- size: Tile/plank dimensions (e.g., "12x24", "6x48", "3x6"). Use format WxL in inches.
- color: Primary color name (e.g., "Bianco", "Natural Oak", "Charcoal Gray")
- thickness: Total product thickness (e.g., "10mm", "3/4 inch", "6mm")
- species: Wood species for hardwood (e.g., "European Oak", "Hickory", "Walnut")
- fiber: Carpet fiber type (e.g., "Nylon 6,6", "PET Polyester", "Solution-Dyed Nylon")
- wear_layer: Vinyl wear layer thickness (e.g., "20mil", "12mil")

Rules:
- ONLY extract attributes listed in each SKU's "missing" array.
- Extract from product name, collection name, variant name, and existing attributes.
- If you cannot confidently determine an attribute, omit it.
- Do NOT guess or fabricate values.

Return JSON: { "skus": [{ "sku_id": "...", "attributes": { "material": "...", "finish": "..." } }] }`;

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;

  await processBatch(skus, { batchSize: 10, concurrency: 1 }, async (batch) => {
    checkCancelled(jobId);

    const skuData = batch.map(s => ({
      sku_id: s.sku_id,
      product_name: s.product_name,
      collection: s.collection,
      variant_name: s.variant_name,
      vendor: s.vendor_name,
      category: s.category_name,
      existing_attributes: s.existing_attrs || [],
      missing: s.missing_attrs || [],
    }));

    const response = await callOpenAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Extract missing attributes for these SKUs:\n${JSON.stringify(skuData, null, 2)}` }
    ], { response_format: { type: 'json_object' }, temperature: 0.3, max_tokens: 4096 });

    let parsed;
    try { parsed = JSON.parse(response.content); } catch { return { processed: batch.length, failed: batch.length, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens }; }

    let updated = 0;
    for (const item of (parsed.skus || [])) {
      if (!item.sku_id || !item.attributes) continue;
      const sku = batch.find(s => s.sku_id === item.sku_id);
      if (!sku) continue;

      const missingSet = new Set(sku.missing_attrs || []);
      for (const [slug, value] of Object.entries(item.attributes)) {
        if (!value || !missingSet.has(slug)) continue;

        const existingCheck = await pool.query(
          `SELECT 1 FROM sku_attributes sa JOIN attributes a ON a.id = sa.attribute_id
           WHERE sa.sku_id = $1 AND a.slug = $2`, [item.sku_id, slug]
        );
        if (existingCheck.rows.length > 0) continue;

        await upsertSkuAttribute(pool, item.sku_id, slug, value);
        updated++;

        await pool.query(
          `INSERT INTO enrichment_results (enrichment_job_id, entity_type, entity_id, field_name, old_value, new_value, confidence, status)
           VALUES ($1, 'sku', $2, $3, NULL, $4, 0.85, 'applied')`,
          [jobId, item.sku_id, slug, value]
        );
      }
    }

    totalProcessed += batch.length;
    totalUpdated += updated;
    totalPrompt += response.prompt_tokens;
    totalCompletion += response.completion_tokens;
    const cost = estimateCost(totalPrompt, totalCompletion);

    await updateJobProgress(pool, jobId, {
      processed_items: totalProcessed,
      updated_items: totalUpdated,
      prompt_tokens_used: totalPrompt,
      completion_tokens_used: totalCompletion,
      estimated_cost_usd: cost,
    });

    return { processed: batch.length, updated, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens };
  });

  await appendJobLog(pool, jobId, `Completed: ${totalUpdated} attributes extracted across ${totalProcessed} SKUs`);
}

// ══════════════════════════════════════════════
// Feature 3: Auto-Categorize
// ══════════════════════════════════════════════

export async function autoCategorize(pool, jobId, scope) {
  const conditions = [`p.status = 'active'`, `p.category_id IS NULL`];
  const params = [];
  let idx = 1;

  if (scope.vendor_id) {
    conditions.push(`p.vendor_id = $${idx}`);
    params.push(scope.vendor_id);
    idx++;
  }
  if (scope.product_ids?.length) {
    conditions.push(`p.id = ANY($${idx})`);
    params.push(scope.product_ids);
    idx++;
  }

  const { rows: products } = await pool.query(`
    SELECT p.id, p.name, p.collection, p.description_short,
           v.name as vendor_name,
           (SELECT json_agg(json_build_object('variant_name', s.variant_name, 'sell_by', s.sell_by, 'variant_type', s.variant_type))
            FROM skus s WHERE s.product_id = p.id AND s.status = 'active' LIMIT 5) as sku_info,
           (SELECT json_agg(json_build_object('slug', a.slug, 'value', sa.value))
            FROM skus s JOIN sku_attributes sa ON sa.sku_id = s.id
            JOIN attributes a ON a.id = sa.attribute_id
            WHERE s.product_id = p.id AND s.status = 'active' LIMIT 10) as attrs
    FROM products p
    JOIN vendors v ON v.id = p.vendor_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.created_at
    LIMIT 2000
  `, params);

  // Load category tree
  const { rows: categories } = await pool.query(
    `SELECT id, slug, name, parent_id FROM categories WHERE is_active = true ORDER BY sort_order`
  );
  const categoryList = categories.map(c => `${c.slug}: ${c.name}`).join('\n');

  await updateJobProgress(pool, jobId, { total_items: products.length, status: 'running', started_at: new Date() });
  await appendJobLog(pool, jobId, `Found ${products.length} uncategorized products`);

  if (products.length === 0) return;

  const SYSTEM_PROMPT = `You are a flooring product categorization specialist. Classify products into the correct category.

Available categories:
${categoryList}

Rules:
- Choose the most specific matching category slug.
- Include a confidence score (0.0 to 1.0).
- Products with "trim", "molding", "transition", "nosing", "reducer", "quarter round", "t-mold" → accessories category.
- Products sold by "unit" with variant_type "accessory" → accessories.
- If uncertain, prefer the broader parent category and lower confidence.
- Include brief reasoning.

Return JSON: { "products": [{ "id": "...", "category_slug": "...", "confidence": 0.9, "reasoning": "..." }] }`;

  let totalProcessed = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;

  await processBatch(products, { batchSize: 10, concurrency: 1 }, async (batch) => {
    checkCancelled(jobId);

    const productData = batch.map(p => ({
      id: p.id,
      name: p.name,
      collection: p.collection,
      vendor: p.vendor_name,
      description: p.description_short,
      variants: p.sku_info,
      attributes: p.attrs,
    }));

    const response = await callOpenAI([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Categorize these products:\n${JSON.stringify(productData, null, 2)}` }
    ], { response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 4096 });

    let parsed;
    try { parsed = JSON.parse(response.content); } catch { return { processed: batch.length, failed: batch.length, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens }; }

    let updated = 0;
    let skipped = 0;
    for (const item of (parsed.products || [])) {
      if (!item.id || !item.category_slug) continue;
      const product = batch.find(p => p.id === item.id);
      if (!product) continue;

      const confidence = parseFloat(item.confidence) || 0;

      if (confidence >= 0.80) {
        const res = await pool.query(
          `UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = $2),
                  updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND category_id IS NULL
             AND EXISTS (SELECT 1 FROM categories WHERE slug = $2)
           RETURNING id`,
          [item.id, item.category_slug]
        );
        if (res.rowCount > 0) {
          updated++;
          await pool.query(
            `INSERT INTO enrichment_results (enrichment_job_id, entity_type, entity_id, field_name, old_value, new_value, confidence, status)
             VALUES ($1, 'product', $2, 'category_id', NULL, $3, $4, 'applied')`,
            [jobId, item.id, item.category_slug, confidence]
          );
        }
      } else {
        // Low confidence → pending review
        skipped++;
        await pool.query(
          `INSERT INTO enrichment_results (enrichment_job_id, entity_type, entity_id, field_name, old_value, new_value, confidence, status)
           VALUES ($1, 'product', $2, 'category_id', NULL, $3, $4, 'pending_review')`,
          [jobId, item.id, item.category_slug, confidence]
        );
      }
    }

    totalProcessed += batch.length;
    totalUpdated += updated;
    totalSkipped += skipped;
    totalPrompt += response.prompt_tokens;
    totalCompletion += response.completion_tokens;
    const cost = estimateCost(totalPrompt, totalCompletion);

    await updateJobProgress(pool, jobId, {
      processed_items: totalProcessed,
      updated_items: totalUpdated,
      skipped_items: totalSkipped,
      prompt_tokens_used: totalPrompt,
      completion_tokens_used: totalCompletion,
      estimated_cost_usd: cost,
    });

    return { processed: batch.length, updated, skipped, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens };
  });

  await appendJobLog(pool, jobId, `Completed: ${totalUpdated} categorized, ${totalSkipped} pending review, ${totalProcessed} processed`);
}

// ══════════════════════════════════════════════
// Feature 4: Classify Images
// ══════════════════════════════════════════════

// Pass 1: Heuristic rules (free)
function classifyByHeuristic(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.endsWith('.pdf')) return 'spec_pdf';
  if (/swatch|chip|sample/i.test(lower)) return 'swatch';
  if (/lifestyle|roomscene|interior|room[-_]?scene|installed|setting|vignette/i.test(lower)) return 'lifestyle';
  if (/main|primary|hero/i.test(lower)) return 'primary';
  if (/alt|detail|texture|close[-_]?up|zoom/i.test(lower)) return 'alternate';
  return null;
}

export async function classifyImages(pool, jobId, scope) {
  const conditions = [`ma.asset_type = 'primary'`, `p.status = 'active'`];
  const params = [];
  let idx = 1;

  if (scope.vendor_id) {
    conditions.push(`p.vendor_id = $${idx}`);
    params.push(scope.vendor_id);
    idx++;
  }

  // Get images that are all set to 'primary' (the default) — candidates for reclassification
  const { rows: images } = await pool.query(`
    SELECT ma.id, ma.url, ma.original_url, ma.product_id, ma.sku_id, ma.sort_order,
           p.name as product_name
    FROM media_assets ma
    JOIN products p ON p.id = ma.product_id
    WHERE ${conditions.join(' AND ')}
      AND ma.sort_order > 0
    ORDER BY ma.product_id, ma.sort_order
    LIMIT 5000
  `, params);

  await updateJobProgress(pool, jobId, { total_items: images.length, status: 'running', started_at: new Date() });
  await appendJobLog(pool, jobId, `Found ${images.length} images to classify (non-primary sort_order with primary type)`);

  if (images.length === 0) return;

  // Pass 1: Heuristic classification
  const pass1Results = [];
  const needsVision = [];

  for (const img of images) {
    const urlToCheck = img.original_url || img.url;
    const heuristicType = classifyByHeuristic(urlToCheck);
    if (heuristicType && heuristicType !== 'primary') {
      pass1Results.push({ ...img, newType: heuristicType });
    } else {
      needsVision.push(img);
    }
  }

  // Apply heuristic results
  let totalUpdated = 0;
  for (const img of pass1Results) {
    await pool.query(`UPDATE media_assets SET asset_type = $2 WHERE id = $1`, [img.id, img.newType]);
    totalUpdated++;
    await pool.query(
      `INSERT INTO enrichment_results (enrichment_job_id, entity_type, entity_id, field_name, old_value, new_value, confidence, status)
       VALUES ($1, 'media_asset', $2, 'asset_type', 'primary', $3, 1.0, 'applied')`,
      [jobId, img.id, img.newType]
    );
  }

  await appendJobLog(pool, jobId, `Pass 1 (heuristic): ${pass1Results.length} reclassified, ${needsVision.length} need vision API`);
  await updateJobProgress(pool, jobId, { processed_items: pass1Results.length, updated_items: totalUpdated });

  // Pass 2: Vision API for remaining
  if (needsVision.length > 0) {
    const VISION_PROMPT = `Classify each flooring product image into one of these types:
- primary: Main product photo, usually a flat-lay or angled shot of the material
- alternate: Detail shots, texture close-ups, edge profiles
- lifestyle: Room scenes showing the product installed in a space
- swatch: Small color/material sample chips
- spec_pdf: (skip — already handled)

Return JSON: { "images": [{ "id": "...", "asset_type": "primary|alternate|lifestyle|swatch", "confidence": 0.9 }] }`;

    let totalPrompt = 0;
    let totalCompletion = 0;
    let visionProcessed = 0;

    await processBatch(needsVision, { batchSize: 5, concurrency: 1 }, async (batch) => {
      checkCancelled(jobId);

      const content = [{ type: 'text', text: `Classify these ${batch.length} flooring product images:` }];
      for (const img of batch) {
        content.push({
          type: 'text',
          text: `Image ID: ${img.id} (Product: ${img.product_name})`
        });
        content.push({
          type: 'image_url',
          image_url: { url: img.url, detail: 'low' }
        });
      }

      let response;
      try {
        response = await callOpenAI([
          { role: 'system', content: VISION_PROMPT },
          { role: 'user', content }
        ], { max_tokens: 1024 });
      } catch (err) {
        // Vision may fail on invalid URLs — skip batch
        return { processed: batch.length, failed: batch.length };
      }

      let parsed;
      try { parsed = JSON.parse(response.content); } catch { return { processed: batch.length, failed: batch.length, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens }; }

      let updated = 0;
      for (const item of (parsed.images || [])) {
        if (!item.id || !item.asset_type || item.asset_type === 'primary') continue;
        const validTypes = ['alternate', 'lifestyle', 'swatch', 'spec_pdf'];
        if (!validTypes.includes(item.asset_type)) continue;

        await pool.query(`UPDATE media_assets SET asset_type = $2 WHERE id = $1 AND asset_type = 'primary'`, [item.id, item.asset_type]);
        updated++;
        totalUpdated++;
        await pool.query(
          `INSERT INTO enrichment_results (enrichment_job_id, entity_type, entity_id, field_name, old_value, new_value, confidence, status)
           VALUES ($1, 'media_asset', $2, 'asset_type', 'primary', $3, $4, 'applied')`,
          [jobId, item.id, item.asset_type, parseFloat(item.confidence) || 0.8]
        );
      }

      visionProcessed += batch.length;
      totalPrompt += response.prompt_tokens;
      totalCompletion += response.completion_tokens;
      const cost = estimateCost(totalPrompt, totalCompletion);

      await updateJobProgress(pool, jobId, {
        processed_items: pass1Results.length + visionProcessed,
        updated_items: totalUpdated,
        prompt_tokens_used: totalPrompt,
        completion_tokens_used: totalCompletion,
        estimated_cost_usd: cost,
      });

      return { processed: batch.length, updated, promptTokens: response.prompt_tokens, completionTokens: response.completion_tokens };
    });

    await appendJobLog(pool, jobId, `Pass 2 (vision): ${visionProcessed} processed, total ${totalUpdated} images reclassified`);
  }
}

// ══════════════════════════════════════════════
// Job Runner
// ══════════════════════════════════════════════

const JOB_FUNCTIONS = {
  descriptions: generateDescriptions,
  attributes: extractAttributes,
  categorization: autoCategorize,
  image_classification: classifyImages,
};

export async function runEnrichmentJob(pool, jobId) {
  const { rows } = await pool.query('SELECT * FROM enrichment_jobs WHERE id = $1', [jobId]);
  if (!rows.length) throw new Error('Job not found');
  const job = rows[0];

  const fn = JOB_FUNCTIONS[job.job_type];
  if (!fn) throw new Error(`Unknown job type: ${job.job_type}`);

  const abortController = new AbortController();
  activeJobs.set(jobId, abortController);

  try {
    await updateJobProgress(pool, jobId, { status: 'running', started_at: new Date() });
    await fn(pool, jobId, job.scope || {});
    await updateJobProgress(pool, jobId, { status: 'completed', completed_at: new Date() });
  } catch (err) {
    const wasCancelled = abortController.signal.aborted;
    const finalStatus = wasCancelled ? 'cancelled' : 'failed';
    console.error(`[Enrichment] Job ${jobId} ${finalStatus}:`, err.message);
    await pool.query(
      `UPDATE enrichment_jobs SET status = $2, completed_at = CURRENT_TIMESTAMP,
       errors = errors || $3::jsonb WHERE id = $1`,
      [jobId, finalStatus, JSON.stringify([{ message: err.message, time: new Date().toISOString() }])]
    ).catch(() => {});
  } finally {
    activeJobs.delete(jobId);
  }
}

export function cancelEnrichmentJob(jobId) {
  const ctrl = activeJobs.get(jobId);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  return false;
}

// ══════════════════════════════════════════════
// Post-Scraper Hook
// ══════════════════════════════════════════════

export async function maybeQueuePostScrapeEnrichment(pool, scrapeJobId, source) {
  if (!process.env.OPENAI_API_KEY) return;

  try {
    // Get vendor_id from source
    const vendorId = source.vendor_id;
    if (!vendorId) return;

    // Check for missing descriptions
    const descResult = await pool.query(
      `SELECT COUNT(*)::int as cnt FROM products
       WHERE vendor_id = $1 AND status = 'active'
       AND (description_long IS NULL OR LENGTH(description_long) < 20)`,
      [vendorId]
    );

    // Check for uncategorized products
    const catResult = await pool.query(
      `SELECT COUNT(*)::int as cnt FROM products
       WHERE vendor_id = $1 AND status = 'active' AND category_id IS NULL`,
      [vendorId]
    );

    const missingDescs = descResult.rows[0]?.cnt || 0;
    const uncategorized = catResult.rows[0]?.cnt || 0;

    if (missingDescs > 5) {
      const { rows } = await pool.query(
        `INSERT INTO enrichment_jobs (job_type, scope, triggered_by, scrape_job_id, status)
         VALUES ('descriptions', $1, 'post_scrape', $2, 'pending') RETURNING id`,
        [JSON.stringify({ vendor_id: vendorId }), scrapeJobId]
      );
      runEnrichmentJob(pool, rows[0].id).catch(err =>
        console.error('[Enrichment] Post-scrape descriptions failed:', err.message)
      );
      console.log(`[Enrichment] Auto-queued descriptions for vendor ${source.name || vendorId} (${missingDescs} missing)`);
    }

    if (uncategorized > 5) {
      const { rows } = await pool.query(
        `INSERT INTO enrichment_jobs (job_type, scope, triggered_by, scrape_job_id, status)
         VALUES ('categorization', $1, 'post_scrape', $2, 'pending') RETURNING id`,
        [JSON.stringify({ vendor_id: vendorId }), scrapeJobId]
      );
      runEnrichmentJob(pool, rows[0].id).catch(err =>
        console.error('[Enrichment] Post-scrape categorization failed:', err.message)
      );
      console.log(`[Enrichment] Auto-queued categorization for vendor ${source.name || vendorId} (${uncategorized} uncategorized)`);
    }
  } catch (err) {
    console.error('[Enrichment] Post-scrape hook error:', err.message);
  }
}
