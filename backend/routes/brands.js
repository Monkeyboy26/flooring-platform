import { Router } from 'express';

// Customer-facing brand landing pages (/brands + /brands/:slug).
//
// The customer "brand" is COALESCE(brand.name, vendor.name) over active products
// (a merged universe — some are brands-table rows, some are vendors acting as a
// brand, e.g. Emser). White-labeled names (hide_public_name on brand OR vendor)
// are excluded. Product listing reuses the existing /api/storefront/skus?brand=
// filter, so these endpoints only serve brand metadata + the enumerated index.
//
// brand_pages holds the slug↔name mapping plus AI-generated SEO copy
// (populated by scripts/seo/generate-brand-content.mjs). The table is created
// defensively here so the feature works even before the migration runs.

const BRAND_PAGES_DDL = `
  CREATE TABLE IF NOT EXISTS brand_pages (
    slug              text PRIMARY KEY,
    brand_name        text NOT NULL UNIQUE,
    meta_title        text,
    meta_description  text,
    intro_html        text,
    footer_html       text,
    product_count     integer DEFAULT 0,
    is_active         boolean DEFAULT true,
    created_at        timestamp DEFAULT CURRENT_TIMESTAMP,
    updated_at        timestamp DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_brand_pages_active ON brand_pages (is_active) WHERE is_active = true;
`;

// Live public brand universe with current active-product counts. Used to seed the
// index when brand_pages is empty (and by the generator). Excludes hidden names.
const BRAND_UNIVERSE_SQL = `
  SELECT COALESCE(br.name, v.name) AS brand_name, count(DISTINCT p.id)::int AS product_count
  FROM products p
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN brands br ON br.id = p.brand_id
  WHERE p.status = 'active'
    AND NOT (COALESCE(br.hide_public_name, false) OR COALESCE(v.hide_public_name, false))
  GROUP BY 1
  HAVING count(DISTINCT p.id) > 0
  ORDER BY 2 DESC
`;

export default function createBrandRoutes(ctx) {
  const router = Router();
  const { pool } = ctx;

  // Fire-and-forget table creation; endpoints tolerate its absence.
  pool.query(BRAND_PAGES_DDL).catch(err => console.error('[Brands] DDL error:', err.message));

  // GET /api/storefront/brands — index of brand landing pages (A–Z friendly).
  // Prefers brand_pages rows (with copy); falls back to the live universe so the
  // index is never empty even before content generation has run.
  router.get('/api/storefront/brands', async (req, res) => {
    try {
      // Live counts keyed by brand name.
      const universe = await pool.query(BRAND_UNIVERSE_SQL);
      const liveCounts = new Map(universe.rows.map(r => [r.brand_name, r.product_count]));

      let pages = [];
      try {
        const bp = await pool.query(
          `SELECT slug, brand_name, meta_description FROM brand_pages WHERE is_active = true`
        );
        pages = bp.rows;
      } catch { /* table may not exist yet */ }

      const pageByName = new Map(pages.map(p => [p.brand_name, p]));
      const out = [];
      for (const [brand_name, product_count] of liveCounts) {
        const page = pageByName.get(brand_name);
        out.push({
          brand_name,
          slug: page ? page.slug : slugifyBrand(brand_name),
          product_count,
          has_page: !!page,
          blurb: page ? page.meta_description : null,
        });
      }
      out.sort((a, b) => a.brand_name.localeCompare(b.brand_name));
      res.json({ brands: out, total: out.length });
    } catch (err) {
      console.error('[Brands] index error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/storefront/brands/:slug — brand metadata + copy for one landing page.
  // Products are loaded by the client via /api/storefront/skus?brand=<brand_name>.
  router.get('/api/storefront/brands/:slug', async (req, res) => {
    try {
      const slug = (req.params.slug || '').toLowerCase();
      let page = null;
      try {
        const bp = await pool.query(`SELECT * FROM brand_pages WHERE slug = $1 AND is_active = true`, [slug]);
        page = bp.rows[0] || null;
      } catch { /* table may not exist */ }

      // Resolve brand_name: from the page row, else by matching the live universe
      // (so a page works even before its content row exists).
      let brandName = page ? page.brand_name : null;
      const universe = await pool.query(BRAND_UNIVERSE_SQL);
      if (!brandName) {
        const match = universe.rows.find(r => slugifyBrand(r.brand_name) === slug);
        if (!match) return res.status(404).json({ error: 'Brand not found' });
        brandName = match.brand_name;
      }
      const live = universe.rows.find(r => r.brand_name === brandName);
      if (!live) return res.status(404).json({ error: 'Brand not found' });

      res.json({
        brand: {
          slug: page ? page.slug : slugifyBrand(brandName),
          brand_name: brandName,
          meta_title: page?.meta_title || null,
          meta_description: page?.meta_description || null,
          intro_html: page?.intro_html || null,
          footer_html: page?.footer_html || null,
          product_count: live.product_count,
        },
      });
    } catch (err) {
      console.error('[Brands] detail error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Deterministic brand→slug (shared shape with the frontend + seoRenderer). Keep in
// sync: lowercase, non-alphanumerics → single hyphen, trim hyphens.
export function slugifyBrand(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
