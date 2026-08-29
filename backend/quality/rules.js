// Product data conformance rules.
//
// Each rule checks the DATABASE (not scraper output) so it catches drift from
// any source: re-imports, manual admin edits, new scrapers. Rules return
// violation rows; backend/quality/runner.js diffs them against the
// quality_violations table (open/fixed/waived lifecycle).
//
// Rule shape:
//   key         stable identifier (never rename — fingerprints depend on it)
//   title       short human label
//   severity    'error' (customer-visible wrongness) | 'warn' (suspicious)
//   heavy       true = only runs when opts.checkImages (network-bound rules)
//   run(pool, { vendorId }) -> [{ sku_id, product_id, vendor_id, summary, detail, discriminator }]
//
// discriminator distinguishes multiple violations of the same rule on the same
// entity (defaults to ''). Keep summaries self-contained — they appear in the
// admin list and alert emails without further joins.

// Leaf categories where flooring is sold by the box with a coverage calculator.
const BOX_FLOORING_SLUGS = [
  'engineered-hardwood', 'solid-hardwood', 'waterproof-wood',
  'laminate', 'lvp-plank', 'lvt-tile',
];

// Mosaics / stacked stone sell per sheet (sell_by=unit, price_basis=per_unit).
const SHEET_SLUGS = ['mosaic-tile', 'stacked-stone'];

// Trim pieces inside mosaic categories legitimately sell by other conventions.
const TRIM_NAME_RE = '(bullnose|pencil|liner|\\mtrim\\M|corner|jolly|quarter round|chair rail|\\mrail\\M|molding|moulding|edge piece)';

// Slab categories: sell_by=unit + price_basis=per_sqft without packaging area
// is a legitimate pattern (area-less slabs get rep-entered dimensions).
const SLAB_SLUGS = [
  'granite-countertops', 'marble-countertops', 'porcelain-slabs', 'quartz-countertops',
  'quartzite-countertops', 'sintered-surfaces', 'soapstone-countertops',
  'prefab-countertops', 'vanity-tops', 'countertops',
];

// Base FROM clause shared by sku-level rules.
const SKU_FROM = `
  FROM skus s
  JOIN products p ON p.id = s.product_id
  JOIN vendors v ON v.id = p.vendor_id
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN pricing pr ON pr.sku_id = s.id
  LEFT JOIN packaging pk ON pk.sku_id = s.id
  WHERE s.status = 'active' AND p.status = 'active' AND s.is_sample IS NOT TRUE
    AND ($1::uuid IS NULL OR v.id = $1)
`;

export const RULES = [
  {
    key: 'name-artifacts',
    title: 'Name contains artifacts (N/A, null, double spaces, stray commas)',
    severity: 'error',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name
        ${SKU_FROM}
          AND (
            p.name ~* '(^|[^a-z0-9])n/a([^a-z0-9]|$)' OR s.variant_name ~* '(^|[^a-z0-9])n/a([^a-z0-9]|$)'
            OR p.name ~* '\\m(null|undefined)\\M' OR s.variant_name ~* '\\m(null|undefined)\\M'
            OR p.name ~ '  ' OR s.variant_name ~ '  '
            OR s.variant_name ~ '(^\\s*,|,\\s*,|,\\s*$)'
            OR p.name ~ '(^\\s*,|,\\s*,|,\\s*$)'
            OR s.variant_name ~* '(^|, )([^,]+), \\2(,|$)'
          )
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" has naming artifacts`,
        detail: { name: r.name, variant_name: r.variant_name },
      }));
    },
  },

  {
    key: 'variant-echoes-product',
    title: 'Variant name repeats the product name ("Lisbon — Lisbon Bullnose 3X12")',
    severity: 'warn',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name
        ${SKU_FROM}
          AND s.variant_name IS NOT NULL
          AND (
            LOWER(TRIM(s.variant_name)) = LOWER(TRIM(p.name))
            OR LOWER(s.variant_name) LIKE LOWER(p.name) || ' %'
            OR LOWER(s.variant_name) LIKE LOWER(p.name) || ',%'
          )
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: variant "${r.variant_name}" repeats product name "${r.name}" — displays doubled`,
        detail: { name: r.name, variant_name: r.variant_name },
      }));
    },
  },

  {
    key: 'non-leaf-category',
    title: 'Product sits in a parent (non-leaf) category — not browsable to a specific type',
    severity: 'warn',
    async run(pool, { vendorId }) {
      // A parent bucket (e.g. "Luxury Vinyl", "Installation & Sundries") isn't a
      // browsable leaf — the product needs a specific subtype (lvp-plank,
      // tools-trowels, …). This is the durable guard: anything a scraper couldn't
      // classify to a leaf, or that regresses, surfaces here for the nightly diff.
      const { rows } = await pool.query(`
        SELECT p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code, p.name,
               c.name AS cat_name, c.slug
        FROM products p
        JOIN vendors v ON v.id = p.vendor_id
        JOIN categories c ON c.id = p.category_id
        WHERE p.status = 'active'
          AND EXISTS (SELECT 1 FROM categories ch WHERE ch.parent_id = p.category_id)
          AND ($1::uuid IS NULL OR v.id = $1)
      `, [vendorId]);
      return rows.map(r => ({
        product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}" is in parent category "${r.cat_name}" — needs a specific subtype`,
        detail: { parent_category: r.slug },
      }));
    },
  },

  {
    key: 'name-abbrev-soup',
    title: 'Product name is abbreviation soup (e.g. "Spectra Matte Bo/Ce/Ho/Na")',
    severity: 'warn',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT DISTINCT p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code, p.name
        ${SKU_FROM}
          AND (
            p.name ~ '\\m[A-Za-z]{2}(/[A-Za-z]{2}){2,}\\M'
            OR p.name ~ '( [A-Z][a-z]?){3}( |$)'
          )
      `, [vendorId]);
      return rows.map(r => ({
        product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: product name "${r.name}" looks like glued abbreviations`,
        detail: { name: r.name },
      }));
    },
  },

  {
    key: 'indistinguishable-variants',
    title: 'Multiple SKUs share the same display name (missing finish/size axis)',
    severity: 'error',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code, p.name,
               LOWER(COALESCE(s.variant_name, '')) AS vkey,
               MAX(s.variant_name) AS variant_name,
               COUNT(*)::int AS sku_count,
               ARRAY_AGG(s.internal_sku ORDER BY s.internal_sku) AS skus
        ${SKU_FROM}
        GROUP BY p.id, v.id, v.code, p.name, LOWER(COALESCE(s.variant_name, ''))
        HAVING COUNT(*) > 1
      `, [vendorId]);
      return rows.map(r => ({
        product_id: r.product_id, vendor_id: r.vendor_id,
        discriminator: r.vkey,
        summary: `${r.vendor_code}: ${r.sku_count} SKUs all display as "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" — customers can't tell them apart`,
        detail: { name: r.name, variant_name: r.variant_name, sku_count: r.sku_count, skus: r.skus.slice(0, 25) },
      }));
    },
  },

  {
    key: 'wood-vinyl-not-box',
    title: 'Wood/vinyl flooring not sold by box with coverage calc',
    severity: 'error',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, s.sell_by, pr.price_basis, pk.sqft_per_box, c.slug AS category
        ${SKU_FROM}
          AND c.slug = ANY($2)
          AND s.variant_type IS DISTINCT FROM 'accessory'
          AND (
            s.sell_by IS DISTINCT FROM 'box'
            OR pr.price_basis IS DISTINCT FROM 'per_sqft'
            OR COALESCE(pk.sqft_per_box, 0) <= 0
          )
      `, [vendorId, BOX_FLOORING_SLUGS]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: ${r.category} "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" is ${r.sell_by || 'no sell_by'}/${r.price_basis || 'no basis'}${!(r.sqft_per_box > 0) ? ', no sqft_per_box' : ''} — should be box/per_sqft with coverage`,
        detail: { category: r.category, sell_by: r.sell_by, price_basis: r.price_basis, sqft_per_box: r.sqft_per_box },
      }));
    },
  },

  {
    key: 'mosaic-not-per-sheet',
    title: 'Mosaic / stacked stone not sold per sheet',
    severity: 'error',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, s.sell_by, pr.price_basis, c.slug AS category
        ${SKU_FROM}
          AND c.slug = ANY($2)
          AND s.variant_type IS DISTINCT FROM 'accessory'
          AND p.name !~* $3 AND COALESCE(s.variant_name, '') !~* $3
          AND (s.sell_by IS DISTINCT FROM 'unit' OR pr.price_basis IS DISTINCT FROM 'per_unit')
      `, [vendorId, SHEET_SLUGS, TRIM_NAME_RE]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: ${r.category} "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" is ${r.sell_by || 'no sell_by'}/${r.price_basis || 'no basis'} — mosaics/ledger sell per sheet (unit/per_unit)`,
        detail: { category: r.category, sell_by: r.sell_by, price_basis: r.price_basis },
      }));
    },
  },

  {
    key: 'nonstandard-units',
    title: 'Nonstandard sell_by or price_basis value',
    severity: 'error',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, s.sell_by, pr.price_basis
        ${SKU_FROM}
          AND (
            s.sell_by IS NULL OR s.sell_by NOT IN ('box', 'unit', 'roll')
            OR (pr.sku_id IS NOT NULL AND (pr.price_basis IS NULL OR pr.price_basis NOT IN ('per_sqft', 'per_unit', 'per_sqyd')))
          )
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" has nonstandard units (sell_by=${r.sell_by || '∅'}, price_basis=${r.price_basis || '∅'})`,
        detail: { sell_by: r.sell_by, price_basis: r.price_basis },
      }));
    },
  },

  {
    key: 'unit-basis-mismatch',
    title: 'sell_by / price_basis combination inconsistent',
    severity: 'warn',
    async run(pool, { vendorId }) {
      // Canonical pairs: box+per_sqft, unit+per_unit, roll+per_sqyd.
      // Allowed exception: unit+per_sqft with packaging area (natural stone
      // per-piece model) or in slab categories (rep enters dimensions).
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, s.sell_by, pr.price_basis, c.slug AS category
        ${SKU_FROM}
          AND s.sell_by IN ('box', 'unit', 'roll')
          AND pr.price_basis IN ('per_sqft', 'per_unit', 'per_sqyd')
          AND NOT (
            (s.sell_by = 'box' AND pr.price_basis = 'per_sqft')
            OR (s.sell_by = 'unit' AND pr.price_basis = 'per_unit')
            OR (s.sell_by = 'roll' AND pr.price_basis = 'per_sqyd')
            OR (s.sell_by = 'unit' AND pr.price_basis = 'per_sqft'
                AND (COALESCE(pk.sqft_per_box, 0) > 0 OR c.slug = ANY($2)))
          )
      `, [vendorId, SLAB_SLUGS]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" mixes sell_by=${r.sell_by} with price_basis=${r.price_basis}`,
        detail: { sell_by: r.sell_by, price_basis: r.price_basis, category: r.category },
      }));
    },
  },

  {
    key: 'missing-box-packaging',
    title: 'Sold per sqft by the box but sqft_per_box missing',
    severity: 'error',
    async run(pool, { vendorId }) {
      // Wood/vinyl leaves excluded — wood-vinyl-not-box already covers them.
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, c.slug AS category
        ${SKU_FROM}
          AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
          AND COALESCE(pk.sqft_per_box, 0) <= 0
          AND (c.slug IS NULL OR NOT (c.slug = ANY($2)))
      `, [vendorId, BOX_FLOORING_SLUGS]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" sells per sqft by box but has no sqft_per_box — coverage calc broken`,
        detail: { category: r.category },
      }));
    },
  },

  {
    key: 'negative-margin',
    title: 'Retail price below cost',
    severity: 'error',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, pr.cost, pr.retail_price
        ${SKU_FROM}
          AND pr.cost > 0 AND pr.retail_price > 0 AND pr.retail_price < pr.cost
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" retails at $${parseFloat(r.retail_price).toFixed(2)} below cost $${parseFloat(r.cost).toFixed(2)}`,
        detail: { cost: parseFloat(r.cost), retail_price: parseFloat(r.retail_price) },
      }));
    },
  },

  {
    key: 'cost-outlier',
    title: 'Per-sqft cost is a statistical outlier for its category (unit-basis error?)',
    severity: 'warn',
    async run(pool, { vendorId }) {
      // Catches per-each stored as per-SF and vice versa (the MSI 2026-08 bug):
      // cost wildly outside the category's median band. Medians computed over
      // ALL vendors, violations filtered to scope afterward.
      const { rows } = await pool.query(`
        WITH persqft AS (
          SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
                 p.name, s.variant_name, c.slug AS category, pr.cost
          FROM skus s
          JOIN products p ON p.id = s.product_id
          JOIN vendors v ON v.id = p.vendor_id
          JOIN categories c ON c.id = p.category_id
          JOIN pricing pr ON pr.sku_id = s.id
          WHERE s.status = 'active' AND p.status = 'active' AND s.is_sample IS NOT TRUE
            AND pr.price_basis = 'per_sqft' AND pr.cost > 0
            AND s.variant_type IS DISTINCT FROM 'accessory'
        ),
        stats AS (
          SELECT category,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cost) AS median,
                 COUNT(*)::int AS n
          FROM persqft GROUP BY category HAVING COUNT(*) >= 30
        )
        SELECT ps.*, st.median, st.n
        FROM persqft ps
        JOIN stats st ON st.category = ps.category
        WHERE (ps.cost > st.median * 6 OR ps.cost < st.median * 0.15)
          AND ($1::uuid IS NULL OR ps.vendor_id = $1)
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" costs $${parseFloat(r.cost).toFixed(2)}/sqft vs category median $${parseFloat(r.median).toFixed(2)} (${r.category}) — check price basis`,
        detail: { cost: parseFloat(r.cost), category_median: parseFloat(r.median), category: r.category, category_n: r.n },
      }));
    },
  },

  {
    key: 'suspected-slab',
    title: 'Large single-piece "tile" is probably a slab (per-slab convention)',
    severity: 'warn',
    async run(pool, { vendorId }) {
      // Slabs are priced per-slab (unit/per_unit) and live under countertops.
      // A single piece >= 25 sqft sitting in a tile category as box/per_sqft
      // is how the Roca 63x126 slabs (and Emser Zambia 47x109) hid.
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, c.slug AS category, pk.sqft_per_box
        ${SKU_FROM}
          AND c.slug IN ('porcelain-tile', 'ceramic-tile', 'natural-stone', 'large-format-tile', 'wood-look-tile')
          AND pk.sqft_per_box >= 25 AND COALESCE(pk.pieces_per_box, 1) = 1
          AND s.sell_by = 'box' AND pr.price_basis = 'per_sqft'
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" is a ${parseFloat(r.sqft_per_box).toFixed(1)} sqft single piece in ${r.category} — probably a slab (should be per-slab under countertops)`,
        detail: { category: r.category, sqft_per_box: parseFloat(r.sqft_per_box) },
      }));
    },
  },

  {
    key: 'undercounted-pieces',
    title: 'Single-piece box whose area is a clean multiple of the piece (piece count undercounted)',
    severity: 'warn',
    async run(pool, { vendorId }) {
      // A box marked pieces_per_box=1 whose sqft_per_box is a clean integer
      // multiple (2-30) of the single-piece face area really holds that many
      // pieces (BED plank boxes, Daltile Assemble/Delegate). The clean-multiple
      // test is what separates this from area corruption (SlimLite, non-integer
      // 40x ratios). Slabs/mosaics excluded — their name size is thickness/chip,
      // not a face dimension. Mirrors fix-packaging-piececount-accessories-2026-08.mjs.
      const CATS = ['porcelain-tile', 'ceramic-tile', 'wood-look-tile', 'large-format-tile',
        'backsplash-wall', 'engineered-hardwood', 'solid-hardwood', 'laminate', 'lvp-plank', 'lvt-tile'];
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, pk.sqft_per_box AS sf,
               (regexp_match(s.variant_name,'([0-9]+(?:\\.[0-9]+)?)x([0-9]+(?:\\.[0-9]+)?)'))[1]::numeric AS w,
               (regexp_match(s.variant_name,'([0-9]+(?:\\.[0-9]+)?)x([0-9]+(?:\\.[0-9]+)?)'))[2]::numeric AS h
        ${SKU_FROM}
          AND s.sell_by = 'box' AND pk.pieces_per_box = 1 AND pk.sqft_per_box > 0
          AND s.variant_type IS DISTINCT FROM 'accessory'
          AND c.slug = ANY($2)
          AND s.variant_name ~ '[0-9]+(\\.[0-9]+)?x[0-9]+'
      `, [vendorId, CATS]);
      const out = [];
      for (const r of rows) {
        const w = parseFloat(r.w), h = parseFloat(r.h), sf = parseFloat(r.sf);
        if (!(w >= 3 && w <= 130 && h >= 3 && h <= 130)) continue;
        const pieceArea = w * h / 144;
        if (sf < pieceArea * 1.8) continue;
        const pcs = Math.round(sf / pieceArea);
        if (pcs < 2 || pcs > 30) continue;
        if (Math.abs(sf - pcs * pieceArea) > sf * 0.08) continue;
        out.push({
          sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
          summary: `${r.vendor_code}: "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" is 1 piece/box but ${sf} sqft ≈ ${pcs}× the ${w}x${h} piece — piece count likely ${pcs}`,
          detail: { sqft_per_box: sf, size: `${w}x${h}`, implied_pieces: pcs },
        });
      }
      return out;
    },
  },

  {
    key: 'missing-roll-width',
    title: 'Roll goods without roll_width_ft (cut math incomplete)',
    severity: 'warn',
    async run(pool, { vendorId }) {
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, p.id AS product_id, v.id AS vendor_id, v.code AS vendor_code,
               p.name, s.variant_name, c.slug AS category
        ${SKU_FROM}
          AND s.sell_by = 'roll'
          AND COALESCE(pk.roll_width_ft, 0) <= 0
      `, [vendorId]);
      return rows.map(r => ({
        sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
        summary: `${r.vendor_code}: roll-sold "${r.name}${r.variant_name ? ' — ' + r.variant_name : ''}" has no roll_width_ft`,
        detail: { category: r.category },
      }));
    },
  },

  {
    key: 'image-color-mismatch',
    title: 'Primary image shows a different color (encodes a sibling SKU’s color)',
    severity: 'warn',
    async run(pool, { vendorId }) {
      // Deterministic color-correctness for the two vendors whose image URLs
      // encode a color code (EF Cloudinary, Shaw Widen). A naive "url code !=
      // sku code" check drowns in false positives: both vendors use a merch vs
      // PHOTO style-code offset (EF style 4940 -> photo 4960, all same color),
      // so ~1000 codes "disagree" while the color is right. The false-positive-
      // free signal is a CONFIRMED LEAK: the image's color matches a DIFFERENT
      // active sibling SKU's color in the same product — i.e. it literally shows
      // another color's photo. Reads COALESCE(original_url, url) so it still sees
      // the vendor URL after an image is mirrored to /uploads. Generalizes the
      // per-scraper guards (shaw-data-api.js, enrich-ef-cloudinary.cjs).
      const fnOf = (u) => (u || '').split('/').pop().split('?')[0];
      const EXTRACT = {
        EF: {
          sku: (vs) => { const p = (vs || '').split('-'); return p.length >= 3 ? (p[2] || '').replace(/^0+/, '') : null; },
          url: (u) => { const p = fnOf(u).split('_'); return p.length >= 2 ? (p[1] || '').replace(/^0+/, '') : null; },
        },
        SHAW: {
          sku: (vs) => { const m = String(vs || '').match(/(\d{3})(?!.*\d)/); return m ? m[1] : null; },
          url: (u) => { const m = fnOf(u).match(/_[0]*(\d{3,6})\./); return m ? m[1].slice(-3) : null; },
        },
      };
      const { rows } = await pool.query(`
        SELECT s.id AS sku_id, s.product_id, s.internal_sku, s.vendor_sku, v.code AS vendor_code,
               v.id AS vendor_id, p.name, COALESCE(ma.original_url, ma.url) AS src
        FROM skus s
        JOIN products p ON p.id = s.product_id
        JOIN vendors v ON v.id = p.vendor_id
        JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
        WHERE s.status = 'active' AND p.status = 'active'
          AND v.code IN ('EF', 'SHAW')
          AND COALESCE(ma.original_url, ma.url) ~ '^https?://'
          AND ($1::uuid IS NULL OR v.id = $1)
      `, [vendorId]);

      // Sibling color sets per product (to confirm a leak points at a real sibling).
      const skuColor = new Map();
      const prodColors = new Map();
      for (const r of rows) {
        const c = EXTRACT[r.vendor_code].sku(r.vendor_sku);
        if (!c) continue;
        skuColor.set(r.sku_id, c);
        if (!prodColors.has(r.product_id)) prodColors.set(r.product_id, new Set());
        prodColors.get(r.product_id).add(c);
      }
      const out = [];
      for (const r of rows) {
        const mine = skuColor.get(r.sku_id);
        const urlColor = EXTRACT[r.vendor_code].url(r.src);
        if (!mine || !urlColor || urlColor === mine) continue;
        const sibs = prodColors.get(r.product_id);
        if (!sibs || !sibs.has(urlColor)) continue; // not a sibling => code-offset, not a leak
        out.push({
          sku_id: r.sku_id, product_id: r.product_id, vendor_id: r.vendor_id,
          summary: `${r.vendor_code}: "${r.name}" primary image shows color ${urlColor} but this SKU is color ${mine} — image belongs to a sibling`,
          detail: { sku_color: mine, image_color: urlColor, src: r.src },
        });
      }
      return out;
    },
  },

  // NOTE: the AI-vision correctness rule ('image-vision-mismatch') is deliberately
  // NOT in the active ruleset yet — owner is holding off on the AI image check.
  // The runner (verify-image-vision.mjs) + image_vision_checks table stay in the
  // repo, dormant. To activate: run the vision scan, then re-add the rule object
  // here (it reads the cached verdicts). See [[image-management]].

  {
    key: 'broken-image',
    title: 'Primary image URL does not resolve',
    severity: 'warn',
    heavy: true, // network-bound; only runs when opts.checkImages
    async run(pool, { vendorId, imageLimit }) {
      const { rows } = await pool.query(`
        SELECT DISTINCT ON (ma.url)
               ma.id AS media_id, ma.url, p.id AS product_id, v.id AS vendor_id,
               v.code AS vendor_code, p.name
        FROM media_assets ma
        JOIN products p ON p.id = ma.product_id
        JOIN vendors v ON v.id = p.vendor_id
        WHERE ma.asset_type = 'primary' AND p.status = 'active'
          AND ma.url ~* '^https?://'
          AND ($1::uuid IS NULL OR v.id = $1)
        ORDER BY ma.url
        ${imageLimit ? 'LIMIT ' + parseInt(imageLimit, 10) : ''}
      `, [vendorId]);

      const CONCURRENCY = 16;
      const violations = [];
      let cursor = 0;
      async function worker() {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          const status = await checkUrl(row.url);
          if (status !== 'ok') {
            violations.push({
              product_id: row.product_id, vendor_id: row.vendor_id,
              discriminator: row.url,
              summary: `${row.vendor_code}: primary image for "${row.name}" is broken (${status}): ${row.url}`,
              detail: { url: row.url, media_id: row.media_id, status },
            });
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return violations;
    },
  },
];

async function checkUrl(url) {
  for (const method of ['HEAD', 'GET']) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) RomaQualityBot/1.0' },
      });
      clearTimeout(timer);
      if (res.body && method === 'GET') { try { await res.body.cancel(); } catch {} }
      if (res.ok) return 'ok';
      // Some CDNs reject HEAD — retry with GET before flagging.
      if (method === 'GET') return `http ${res.status}`;
      if (res.status !== 405 && res.status !== 403 && res.status !== 400) return `http ${res.status}`;
    } catch (err) {
      if (method === 'GET') return err.name === 'AbortError' ? 'timeout' : 'unreachable';
    }
  }
  return 'ok';
}
