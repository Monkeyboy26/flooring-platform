// SEO Phase 5 — thin/duplicate content monitor (READ-ONLY).
//
// Guards the aggressive programmatic-SEO surface (products, facet landing pages,
// categories) against the one systemic risk of a scraped catalog: mass thin or
// duplicate INDEXABLE pages triggering sitewide algorithmic suppression. It never
// writes — it reports, and exits non-zero on a hard breach so it can gate a cron
// or CI step.
//
//   node scripts/seo/seo-content-monitor.mjs [--intro-min N] [--body-min N]
//       [--floor N] [--samples N] [--json]
//
// Run inside the api container:
//   docker compose exec -T api node scripts/seo/seo-content-monitor.mjs
//
// HARD breaches (exit 1) — an indexable page Google will crawl that is thin/dup:
//   • indexable landing page with no unique generated content
//   • indexable landing page below the product floor (build-landing-pages drift)
//   • duplicate meta_description among indexable landing pages
//   • active category with no intro copy (categories are money pages)
// WARN (exit 0) — informational / long-tail-in-progress:
//   • generated pages with suspiciously short body/intro
//   • sellable products missing generated content or meta (tracks batch backfill)
//   • duplicate meta_description among products
//
// The "sellable product" predicate mirrors the sitemap's (server.js) so this
// audits exactly the product set Google can index.

import { pool } from '../../db.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const INTRO_MIN = parseInt(arg('--intro-min', '200'), 10);
const BODY_MIN = parseInt(arg('--body-min', '200'), 10);
const FLOOR = parseInt(arg('--floor', '8'), 10);       // must match build-landing-pages INDEX_MIN
const SAMPLES = parseInt(arg('--samples', '5'), 10);
const JSON_OUT = process.argv.includes('--json');

// Sellable/indexable product predicate — identical to the sitemap query.
const SELLABLE_SKU = `s.status = 'active' AND s.is_sample = false
  AND COALESCE(s.variant_type,'') NOT IN ('accessory','trim','floor_trim','wall_trim','lvt_trim','quarry_trim','mosaic_trim')`;

const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
const one = (sql, params = []) => q(sql, params).then(r => r[0]);

// Must match build-landing-pages.mjs slugify (NOT its size-normalizing facetSlug).
const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ── LANDING PAGES (the highest-risk surface — just shipped 1000s) ─────────────
const lpTotals = await one(`
  SELECT count(*) FILTER (WHERE is_indexable) AS idx,
         count(*) FILTER (WHERE is_indexable AND content_status='generated') AS idx_generated,
         count(*) AS total
  FROM landing_pages WHERE type='facet'`);

const lpMissing = await q(`
  SELECT slug, product_count FROM landing_pages
  WHERE type='facet' AND is_indexable AND content_status <> 'generated'
  ORDER BY product_count DESC LIMIT ${SAMPLES}`);
const lpMissingN = (await one(`SELECT count(*) n FROM landing_pages WHERE type='facet' AND is_indexable AND content_status <> 'generated'`)).n;

const lpBelowFloor = await q(`
  SELECT slug, product_count FROM landing_pages
  WHERE type='facet' AND is_indexable AND product_count < ${FLOOR}
  ORDER BY product_count LIMIT ${SAMPLES}`);
const lpBelowFloorN = (await one(`SELECT count(*) n FROM landing_pages WHERE type='facet' AND is_indexable AND product_count < ${FLOOR}`)).n;

const lpShortIntro = (await one(`
  SELECT count(*) n FROM landing_pages
  WHERE type='facet' AND is_indexable AND content_status='generated'
    AND COALESCE(length(intro_html),0) < ${INTRO_MIN}`)).n;

const lpDupDesc = await q(`
  SELECT lower(trim(meta_description)) d, count(*) c
  FROM landing_pages
  WHERE type='facet' AND is_indexable AND COALESCE(meta_description,'') <> ''
  GROUP BY 1 HAVING count(*) > 1 ORDER BY c DESC LIMIT ${SAMPLES}`);
const lpDupDescN = (await one(`
  SELECT COALESCE(sum(c-1),0) n FROM (
    SELECT count(*) c FROM landing_pages
    WHERE type='facet' AND is_indexable AND COALESCE(meta_description,'') <> ''
    GROUP BY lower(trim(meta_description)) HAVING count(*) > 1) x`)).n;

// ── CATEGORIES (money pages) ──────────────────────────────────────────────────
const catTotals = await one(`
  SELECT count(*) AS active,
         count(*) FILTER (WHERE COALESCE(intro_html,'')='') AS no_intro,
         count(*) FILTER (WHERE COALESCE(meta_title,'')='') AS no_meta_title
  FROM categories WHERE is_active = true`);
// Only categories that actually have sellable products are true money pages;
// an empty active category with no intro is expected, not a breach.
const catNoIntroPopulated = (await one(`
  SELECT count(*) n FROM categories c
  WHERE c.is_active AND COALESCE(c.intro_html,'')=''
    AND EXISTS (SELECT 1 FROM products p JOIN skus s ON s.product_id=p.id
                WHERE p.category_id=c.id AND p.status='active' AND ${SELLABLE_SKU})`)).n;
const catNoIntroSamples = await q(`
  SELECT c.slug FROM categories c
  WHERE c.is_active AND COALESCE(c.intro_html,'')=''
    AND EXISTS (SELECT 1 FROM products p JOIN skus s ON s.product_id=p.id
                WHERE p.category_id=c.id AND p.status='active' AND ${SELLABLE_SKU})
  LIMIT ${SAMPLES}`);

// ── PRODUCTS (long tail — tracks the batch backfill) ──────────────────────────
const prodTotals = await one(`
  SELECT count(DISTINCT p.id) AS sellable,
         count(DISTINCT p.id) FILTER (WHERE p.content_status='generated') AS generated
  FROM products p JOIN skus s ON s.product_id = p.id AND ${SELLABLE_SKU}
  WHERE p.status='active'`);
const prodThinBody = (await one(`
  SELECT count(DISTINCT p.id) n
  FROM products p JOIN skus s ON s.product_id = p.id AND ${SELLABLE_SKU}
  WHERE p.status='active' AND p.content_status='generated'
    AND COALESCE(length(p.content_html),0) < ${BODY_MIN}`)).n;
const prodNoMeta = (await one(`
  SELECT count(DISTINCT p.id) n
  FROM products p JOIN skus s ON s.product_id = p.id AND ${SELLABLE_SKU}
  WHERE p.status='active' AND p.content_status='generated' AND COALESCE(p.meta_description,'')=''`)).n;
const prodDupDescN = (await one(`
  SELECT COALESCE(sum(c-1),0) n FROM (
    SELECT count(*) c FROM (
      SELECT DISTINCT p.id, lower(trim(p.meta_description)) md
      FROM products p JOIN skus s ON s.product_id = p.id AND ${SELLABLE_SKU}
      WHERE p.status='active' AND COALESCE(p.meta_description,'') <> '') t
    GROUP BY md HAVING count(*) > 1) x`)).n;

// ── ORPHANS & FILTER REGRESSIONS (internal-link mesh integrity) ──────────────
// The mesh in seoRenderer links a facet page from: (a) its category page + sibling
// facets — but only the TOP 12 by product_count per category; and (b) member
// product PDPs — but only if the facet's slug equals slugify(attrValue)-category.
// Size facets carry a normalized slug (24x48-… vs slugify's 24-x-48-…), so they
// miss (b). A facet outside its category's top-12 AND not product-reachable has
// ZERO inbound internal links → orphaned (won't be discovered/get equity).
const idxFacets = await q(`
  SELECT slug, filter_json->>'category' AS cat,
         (SELECT value FROM jsonb_each_text(filter_json->'attributes') LIMIT 1) AS attr_value,
         product_count
  FROM landing_pages WHERE type='facet' AND is_indexable`);
const byCat = {};
for (const f of idxFacets) (byCat[f.cat] ||= []).push(f);
const orphans = [];
for (const [cat, list] of Object.entries(byCat)) {
  list.sort((a, b) => b.product_count - a.product_count);
  const top12 = new Set(list.slice(0, 12).map(f => f.slug));
  for (const f of list) {
    const productReachable = f.slug === `${slugify(f.attr_value || '')}-${cat}`;
    if (!top12.has(f.slug) && !productReachable) orphans.push(f);
  }
}

// Indexable facet whose filter category no longer maps to an active category →
// renders an empty/mismatched grid (thin/broken page in the index).
const badFilterN = (await one(`
  SELECT count(*) n FROM landing_pages lp
  WHERE lp.type='facet' AND lp.is_indexable AND (lp.filter_json->>'category') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.slug = lp.filter_json->>'category' AND c.is_active)`)).n;
const badFilter = await q(`
  SELECT slug, filter_json->>'category' cat FROM landing_pages lp
  WHERE lp.type='facet' AND lp.is_indexable AND (lp.filter_json->>'category') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.slug = lp.filter_json->>'category' AND c.is_active)
  LIMIT ${SAMPLES}`);

// Sitemap-set integrity: the sitemap query emits exactly is_indexable facet pages,
// so the sitemap URL set should equal this count (external curl confirms the number).
const idxForSitemap = idxFacets.length;

// ── Verdict ──────────────────────────────────────────────────────────────────
const hard = [];
if (+lpMissingN > 0) hard.push(`${lpMissingN} indexable landing pages with NO unique content`);
if (+lpBelowFloorN > 0) hard.push(`${lpBelowFloorN} indexable landing pages below product floor (<${FLOOR})`);
if (+lpDupDescN > 0) hard.push(`${lpDupDescN} duplicate meta_descriptions among indexable landing pages`);
if (+catNoIntroPopulated > 0) hard.push(`${catNoIntroPopulated} populated categories missing intro copy`);
if (+badFilterN > 0) hard.push(`${badFilterN} indexable landing pages with a dead filter category`);

const warn = [];
if (orphans.length > 0) warn.push(`${orphans.length} indexable landing pages orphaned (no inbound internal links)`);
if (+lpShortIntro > 0) warn.push(`${lpShortIntro} indexable landing pages with short intro (<${INTRO_MIN} chars)`);
if (+prodThinBody > 0) warn.push(`${prodThinBody} generated products with thin body (<${BODY_MIN} chars)`);
if (+prodNoMeta > 0) warn.push(`${prodNoMeta} generated products missing meta_description`);
if (+prodDupDescN > 0) warn.push(`${prodDupDescN} duplicate meta_descriptions among products`);

if (JSON_OUT) {
  console.log(JSON.stringify({
    landing: { ...lpTotals, missing_content: +lpMissingN, below_floor: +lpBelowFloorN, short_intro: +lpShortIntro, dup_desc: +lpDupDescN },
    categories: { ...catTotals, no_intro_populated: +catNoIntroPopulated },
    products: { ...prodTotals, thin_body: +prodThinBody, no_meta: +prodNoMeta, dup_desc: +prodDupDescN },
    mesh: { indexable_facets: idxForSitemap, orphans: orphans.length, dead_filter: +badFilterN,
            orphan_samples: orphans.slice(0, SAMPLES).map(o => ({ slug: o.slug, product_count: o.product_count })) },
    hard, warn, pass: hard.length === 0,
  }, null, 2));
} else {
  const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : 'n/a';
  console.log(`\nSEO thin/duplicate content monitor  (floor=${FLOOR}, intro-min=${INTRO_MIN}, body-min=${BODY_MIN})\n`);
  console.log(`── Indexable facet landing pages (${lpTotals.idx} indexable / ${lpTotals.total} total) ──`);
  console.log(`   unique content:  ${lpTotals.idx_generated}/${lpTotals.idx}  (${pct(lpTotals.idx_generated, lpTotals.idx)})`);
  console.log(`   ${+lpMissingN ? '✗' : '✓'} missing content: ${lpMissingN}${lpMissing.length ? '   e.g. ' + lpMissing.map(r => `${r.slug}(${r.product_count})`).join(', ') : ''}`);
  console.log(`   ${+lpBelowFloorN ? '✗' : '✓'} below floor:     ${lpBelowFloorN}${lpBelowFloor.length ? '   e.g. ' + lpBelowFloor.map(r => `${r.slug}(${r.product_count})`).join(', ') : ''}`);
  console.log(`   ${+lpDupDescN ? '✗' : '✓'} dup descriptions:${lpDupDescN}`);
  console.log(`   ${+lpShortIntro ? '⚠' : '✓'} short intro:     ${lpShortIntro}`);
  console.log(`\n── Categories (${catTotals.active} active) ──`);
  console.log(`   ${+catNoIntroPopulated ? '✗' : '✓'} populated w/o intro: ${catNoIntroPopulated}${catNoIntroSamples.length ? '   e.g. ' + catNoIntroSamples.map(r => r.slug).join(', ') : ''}`);
  console.log(`   (${catTotals.no_intro} total active w/o intro incl. empty; ${catTotals.no_meta_title} w/o meta_title)`);
  console.log(`\n── Sellable products (${prodTotals.sellable}) ──`);
  console.log(`   generated:        ${prodTotals.generated}/${prodTotals.sellable}  (${pct(prodTotals.generated, prodTotals.sellable)})`);
  console.log(`   ${+prodThinBody ? '⚠' : '✓'} thin body:       ${prodThinBody}`);
  console.log(`   ${+prodNoMeta ? '⚠' : '✓'} missing meta:    ${prodNoMeta}`);
  console.log(`   ${+prodDupDescN ? '⚠' : '✓'} dup descriptions:${prodDupDescN}`);
  console.log(`\n── Internal-link mesh (${idxForSitemap} indexable facets) ──`);
  console.log(`   ${orphans.length ? '⚠' : '✓'} orphaned (no inbound links): ${orphans.length}${orphans.length ? '   e.g. ' + orphans.slice(0, SAMPLES).map(o => `${o.slug}(${o.product_count})`).join(', ') : ''}`);
  console.log(`   ${+badFilterN ? '✗' : '✓'} dead filter category:       ${badFilterN}${badFilter.length ? '   e.g. ' + badFilter.map(r => `${r.slug}→${r.cat}`).join(', ') : ''}`);
  console.log(`\n${hard.length ? 'VERDICT: ✗ FAIL' : 'VERDICT: ✓ PASS'}`);
  if (hard.length) hard.forEach(h => console.log(`   HARD: ${h}`));
  if (warn.length) warn.forEach(w => console.log(`   warn: ${w}`));
}

await pool.end();
process.exit(hard.length ? 1 : 0);
