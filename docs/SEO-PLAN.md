# Roma Flooring — Aggressive Product SEO Plan

**Scope chosen:** National catalog + local moat · Full AI content engine · Full programmatic pillar+facet system
**Created:** 2026-09-07

## Strategy in one sentence
We already win the *rendering* game (crawler prerendering via `backend/services/seoRenderer.js`, dynamic sitemap in `backend/server.js`, slug URLs + 301s). We now win the *coverage* game — turn a scraped catalog into tens of thousands of **unique, indexable, internally-linked** pages (product → facet → category → pillar → local), with an AI content engine ensuring none of it reads as thin/duplicate.

The flywheel: unique content (no dup penalty) → programmatic pages (long-tail) → internal-linking mesh (crawl + equity) → reviews/UGC + local (E-E-A-T + rich results) → rankings → more crawl budget → repeat.

---

## Phase 0 — Fix leaks & data foundations *(1–2 days, FIRST)*
1. **Fix SPA routing bug** — client navigates to legacy `/shop/sku/{UUID}`; server canonical is `/shop/{categorySlug}/{productSlug}`. Make `storefront.jsx` build slug URLs on product-card clicks.
2. **Schema additions** (`database/schema.sql` + live `ALTER TABLE`):
   - `products`: `meta_title`, `meta_description`, `seo_h1`, `content_html`, `content_status` (`none|generated|reviewed`), `content_hash`.
   - `media_assets`: `alt_text`.
   - `categories`: `meta_title`, `meta_description`, `intro_html`, `footer_html`.
   - New table `landing_pages`: `id, type, slug, title, meta_*, intro_html, filter_json, is_indexable, product_count, updated_at`.
   - New table `product_reviews`: `id, product_id, rating, author, body, status, source, created_at`.
3. **Wire new fields** into `seoRenderer.js` and SPA `updateSEO()` — prefer stored `meta_*` when present, else fall back to current derived values.

## Phase 1 — AI Content Engine *(1–2 weeks)*
- **Provider: OpenAI** (not Claude as originally sketched) — the platform is OpenAI-native (`openai` SDK installed, `OPENAI_API_KEY` in local+prod, `verify-image-vision.mjs` precedent). Model call is isolated in one `generateContent()` fn so it's swappable. Default model `gpt-4o-mini` (long tail), `gpt-4o` for hero/pillar.
- Batch generator (`backend/scripts/seo/generate-product-content.mjs`) **[SCAFFOLDED]**: product attributes/specs → structured-output `{meta_title, meta_description, seo_h1, content_html, image_alt}`, stored on products + media_assets.alt_text with `content_hash` for idempotent re-runs. Flags: `--limit --concurrency --category --vendor --model --force --dry-run`. Never overwrites `content_status='reviewed'`.
- Guardrails vs AI sameness: distinct per-product attributes, length/keyword templates, near-duplicate detection (regenerate >~80% similar siblings).
- Image alt text for every asset.
- Unique category + landing-page hero copy.
- Admin "SEO Content" review queue; top-200 revenue products human-reviewed, long tail auto-ships.
- Model split (confirm IDs/pricing from claude-api ref): Haiku-tier long tail, Opus hero/pillar.

## Phase 2 — Programmatic Pillar + Facet System *(2–3 weeks)*
Page types: category×color, category×size, material/look, brand, room/application, pillar guides.
- Driven by `landing_pages` table (curated, not infinite combinatorics).
- **Indexation gating**: mint indexable only if ≥ N in-stock products AND real demand; else `noindex,follow`.
- `renderLandingPage()` in `seoRenderer.js` (reuse prerender/cache pattern) → `CollectionPage` + `BreadcrumbList` + `ItemList` JSON-LD + unique intro + grid.
- Auto-populate `sitemap.xml` with only indexable landing pages.
- Nightly recompute of `product_count`/indexability.
- Internal-linking mesh: product→facets, facet→siblings+parent+guide, guides→money pages; every page ≤2 clicks from root; orphan logging.

## Phase 3 — Local Moat *(1 week)*
- City/service pages `/flooring-installation/{city}` with unique copy + `HomeAndConstructionBusiness`/`Service`/`FAQPage`/`areaServed`.
- Google Business Profile alignment spec (NAP, categories, posts).
- Activate dormant `aggregateRating` on product + service pages via `product_reviews` + post-purchase review collection.

## Phase 4 — Authority Content *(ongoing)*
- Pillar buying guides linking into money pages; FAQ schema; link-earning tools (cost calculator, visualizer).

## Phase 5 — Measurement & Safety *(alongside Phase 2)*
- Indexation dashboard (Search Console API), thin-content monitor (quality-rules engine), canonical/orphan/sitemap regression guards, rank/traffic tracking.

---

## Sequencing
Phase 0 → Phase 1 (unique content is precondition for safely indexing programmatic pages) → Phase 2 → Phase 3/4 in parallel → Phase 5 throughout. **Never mint facet pages before the content engine exists.**

## The one risk
Mass thin/duplicate pages cause sitewide algorithmic suppression. Every aggressive lever is paired with a guardrail: dup-detection (P1), indexation-gating (P2), thin-content monitor (P5).

---

## Progress
- [x] Phase 0: routing fix (shipped prod 72e7d69), schema migrations + field wiring (local; migration NOT yet applied to prod).
- [~] Phase 1: AI content engine — generator (`generate-product-content.mjs`) + batch variant done. RUN LOCALLY: **10,535 products** have `content_status='generated'` + **78,764 media alt_texts** backfilled. 0 human-reviewed yet. Admin review queue = follow-up. NOT on prod.
- [~] Phase 2: programmatic facet/pillar system — facet landing pages DONE (`build-landing-pages.mjs` + seoRenderer `renderLandingPage` + sitemap + SPA route + resolver API); **3,972 facet pages built (670 indexable)**. Content engine applied: `generate-landing-content.mjs` → all **3,972 facet pages have unique meta+intro** (0 dup descriptions), and `generate-category-content.mjs` → all **72 non-empty categories** have unique copy. Internal-linking mesh DONE (product→facets, category→top facets, facet→siblings+parent). All LOCAL only. FOLLOW-UPS: standalone material/brand/room page types, /guides (Phase 4), nightly cron for the generators, mirror the mesh into the SPA browse view, filter collection-name values out of facet build.
- [ ] Phase 3: local moat
- [ ] Phase 4: authority content
- [ ] Phase 5: measurement & safety

## Known follow-ups / notes
- **Not on prod:** the Phase 0 migration (`database/migrations/2026-09-07-seo-phase0.sql`), all generated content, and all landing pages are LOCAL only. Prod ship = apply migration → run all four generators in the prod api container → verify sitemap/crawler.
- **Category URL:** category pages canonicalize to `/shop?category={slug}` (query-param); the clean `/shop/{slug}` path is reserved for facet landing pages, so a bare `/shop/{categorySlug}` 404s. Consider giving categories clean paths and moving facets under a prefix (e.g. `/shop/f/{slug}`) later.
- **Facet quality:** a few facet values are really collection names (e.g. `bay-of-plenty-lvp-plank`) — all noindex/below-floor, low risk; `build-landing-pages.mjs` could filter collection-name values.
