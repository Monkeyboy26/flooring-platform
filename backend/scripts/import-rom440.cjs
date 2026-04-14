#!/usr/bin/env node

/**
 * Hardware Resources (ROM440) — Fresh Import
 *
 * Vendor: Hardware Resources   Account: ROM440
 *
 * ~12,212 SKUs across 9 master classes (Decorative Hardware, Bath Hardware,
 * Functional Hardware, Carved Wood, Moulding, Organizers, Light & Power,
 * Sinks, Vanity). Groups SKUs into ~3,500–5,500 families using the
 * xlsx-provided Product Title where available, and a description-based
 * hash (Finish/Species markers stripped) where not.
 *
 * Data sources (staged at /app/data/ROM440/ inside the api container):
 *   - 9 price list CSVs (all 12,212 SKUs) — shared columns:
 *       Product, Master Class, Collection, Description, UPC Code,
 *       Inner Quantity, Outer Quantity, 2026 Broken Carton Price,
 *       2026 Full Carton Price, 2026 List Price
 *   - Hardware_Resources_product_data_2026.xlsx (2,277 rows) — authoritative
 *     Product Title, Finish, rich Description, Salsify image URLs, and
 *     measurements. Joined to CSV rows via `Product Subtitle` = vendor_sku.
 *
 * IMPORTANT — cut_price MUST NEVER BE WRITTEN. The prior import populated
 * pricing.cut_price with broken-carton prices, which triggered the carpet
 * calculator UI on every hardware product (frontend/storefront.jsx:53
 * `isCarpet(sku)` returns true whenever sku.cut_price != null). Broken
 * carton price is permanently dropped from this pipeline.
 *
 * Usage:
 *   docker compose exec -T api node scripts/import-rom440.cjs [flags]
 *
 * Flags:
 *   --dry-run            Parse + group, print stats, write nothing
 *   --limit=N            Process only the first N CSV rows (canary)
 *   --only=<vendorSku>   Repair a single SKU (filters CSV to that row)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pg = require('pg');
const XLSX = require('xlsx');

// ==================== CLI + Preflight ====================

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT_ARG = args.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : Infinity;
const ONLY_ARG = args.find(a => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.split('=')[1].trim().toUpperCase() : null;

const DATA_DIR = process.env.ROM440_DIR || '/app/data/ROM440';

const CSV_FILES = [
  { file: 'price_list_ROM440_decorative_hardware.csv', masterClass: 'Decorative Hardware' },
  { file: 'price_list_ROM440_bath_hardware.csv',       masterClass: 'Bath Hardware' },
  { file: 'price_list_ROM440_functional_hardware.csv', masterClass: 'Functional Hardware' },
  { file: 'price_list_ROM440_carved_wood.csv',         masterClass: 'Carved Wood' },
  { file: 'price_list_ROM440_moulding.csv',            masterClass: 'Moulding' },
  { file: 'price_list_ROM440_organizers.csv',          masterClass: 'Organizers' },
  { file: 'price_list_ROM440_light_power.csv',         masterClass: 'Light & Power' },
  { file: 'price_list_ROM440_sinks.csv',               masterClass: 'Sinks' },
  { file: 'price_list_ROM440_vanity.csv',              masterClass: 'Vanity' },
];
const XLSX_FILE = 'Hardware_Resources_product_data_2026.xlsx';

// ==================== Config ====================

const VENDOR = {
  code: 'ROM440',
  name: 'Hardware Resources',
  website: 'https://www.hardwareresources.com',
};

const PARENT_CATEGORY = { slug: 'hardware-specialty', name: 'Hardware & Specialty' };

const CHILD_CATEGORIES = [
  { slug: 'decorative-hardware', name: 'Decorative Hardware', masterClass: 'Decorative Hardware', variantType: 'hardware' },
  { slug: 'bath-hardware',       name: 'Bath Hardware',       masterClass: 'Bath Hardware',       variantType: 'bath_hardware' },
  { slug: 'functional-hardware', name: 'Functional Hardware', masterClass: 'Functional Hardware', variantType: 'hardware' },
  { slug: 'carved-wood',         name: 'Carved Wood',         masterClass: 'Carved Wood',         variantType: 'carved_wood' },
  { slug: 'moulding',            name: 'Moulding',            masterClass: 'Moulding',            variantType: 'moulding' },
  { slug: 'organizers',          name: 'Organizers',          masterClass: 'Organizers',          variantType: 'organizer' },
  { slug: 'light-power',         name: 'Light & Power',       masterClass: 'Light & Power',       variantType: 'lighting' },
  { slug: 'sinks',               name: 'Sinks',               masterClass: 'Sinks',               variantType: 'sink' },
  { slug: 'vanity',              name: 'Vanity',              masterClass: 'Vanity',              variantType: 'vanity' },
];

const ATTR_SLUGS = [
  'finish', 'species', 'diameter', 'width',
  'center_to_center', 'projection', 'clearance', 'overall_length',
];

// DO NOT add cut_price here. frontend/storefront.jsx:53 isCarpet() returns true
// for any sku.cut_price != null, which renders the carpet calculator on every
// hardware product. Broken-carton price is permanently dropped.
const PRICING_INSERT_SQL = `
  INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
  VALUES ($1, $2, $3, 'per_unit')
  ON CONFLICT (sku_id) DO UPDATE SET
    cost = EXCLUDED.cost,
    retail_price = EXCLUDED.retail_price,
    price_basis = 'per_unit'
`;

// Fail-fast guard: if anyone ever re-adds cut_price to the pricing SQL, abort
// before a single row is written.
if (PRICING_INSERT_SQL.toLowerCase().includes('cut_price')) {
  console.error('FATAL: PRICING_INSERT_SQL contains the token "cut_price".');
  console.error('       Broken-carton price must never be stored in cut_price.');
  console.error('       See frontend/storefront.jsx:53 — isCarpet() returns true');
  console.error('       whenever sku.cut_price != null.');
  process.exit(1);
}

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// ==================== Preflight ====================

function preflightFiles() {
  const missing = [];
  const xlsxPath = path.join(DATA_DIR, XLSX_FILE);
  if (!fs.existsSync(xlsxPath)) missing.push(xlsxPath);
  for (const c of CSV_FILES) {
    const p = path.join(DATA_DIR, c.file);
    if (!fs.existsSync(p)) missing.push(p);
  }
  if (missing.length) {
    console.error('FATAL: missing input files:');
    for (const m of missing) console.error('  - ' + m);
    process.exit(1);
  }
}

// ==================== CSV parser (quoted-field aware) ====================

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function parseCsvFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter(l => l.length > 0);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = fields[j] || '';
    rows.push(obj);
  }
  return rows;
}

function parsePriceToNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[^0-9.]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

// ==================== Normalize CSV row ====================

function normalizeCsvRow(r, masterClass) {
  const vendorSku = String(r['Product'] || '').trim().toUpperCase();
  if (!vendorSku) return null;
  return {
    masterClass,
    collection: String(r['Collection'] || '').trim(),
    vendorSku,
    description: String(r['Description'] || '').trim(),
    upc: String(r['UPC Code'] || '').trim(),
    innerQty: parseIntOrNull(r['Inner Quantity']),
    outerQty: parseIntOrNull(r['Outer Quantity']),
    // NOTE: Broken Carton Price is read and intentionally DISCARDED.
    // Do not map it to pricing.cut_price. See PRICING_INSERT_SQL note above.
    fullCarton: parsePriceToNumber(r['2026 Full Carton Price']),
    listPrice: parsePriceToNumber(r['2026 List Price']),
  };
}

// ==================== XLSX parse ====================

function parseXlsx(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const map = new Map(); // vendorSku (upper) → entry
  for (const r of rows) {
    const vendorSku = String(r['Product Subtitle'] || '').trim().toUpperCase();
    if (!vendorSku) continue;

    const altRaw = String(r['Digital Assets - Alternate Images'] || '').trim();
    const altImages = altRaw
      ? altRaw.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    map.set(vendorSku, {
      productTitle: String(r['Product Title'] || '').trim(),
      finish: String(r['General - Finish'] || '').trim(),
      description: String(r['General - Product Description'] || '').trim(),
      mainImage: String(r['Digital Assets - Main Image'] || '').trim(),
      altImages,
      lifestyle: String(r['Digital Assets - Lifestyle Images'] || '').trim(),
      spec: String(r['Digital Assets - Spec - Image'] || '').trim(),
      measurements: {
        diameter:       String(r['Measurements - Item Diameter'] || '').trim(),
        centerToCenter: String(r['Measurements - Item Center to Center'] || '').trim(),
        overallLength:  String(r['Measurements - Item Overall Length'] || '').trim(),
        width:          String(r['Measurements - Item Width'] || '').trim(),
        projection:     String(r['Measurements - Item Projection'] || '').trim(),
        clearance:      String(r['Measurements - Clearance'] || '').trim(),
      },
    });
  }
  return map;
}

// ==================== Family grouping helpers ====================

const FINISH_RE  = /\s*Finish\s*:\s*([^.]+?)\.?\s*$/im;
const SPECIES_RE = /\s*Species\s*:\s*([^.]+?)\.?\s*$/im;

function stripMarkers(desc) {
  if (!desc) return '';
  let s = desc.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(FINISH_RE, '').replace(SPECIES_RE, '').trim();
    if (s === before) break;
  }
  return s
    .replace(/\*+NRB\*+/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/[,;]\s*$/, '')
    .trim();
}

function extractVariantName(desc) {
  if (!desc) return 'Standard';
  const f = desc.match(FINISH_RE);
  if (f) return f[1].trim();
  const s = desc.match(SPECIES_RE);
  if (s) return s[1].trim();
  return 'Standard';
}

function familyKey(masterClass, collection, normDesc) {
  const h = crypto.createHash('sha1').update(normDesc.toLowerCase()).digest('hex').slice(0, 12);
  return `${masterClass}|${collection || ''}|${h}`;
}

function familyDisplayName(normDesc) {
  const firstSentence = normDesc.split(/\.\s+/)[0].trim();
  const titled = firstSentence
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bMm\b/g, 'mm')
    .replace(/\bCc\b/g, 'CC')
    .replace(/\bLed\b/g, 'LED')
    .replace(/\bUsb\b/g, 'USB');
  return titled.length > 120 ? titled.slice(0, 117) + '...' : titled;
}

function familySlug(name, firstVendorSku) {
  const base = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const suffix = (firstVendorSku || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 20);
  return `rom440-${base || 'item'}-${suffix || 'sku'}`;
}

function randomHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

// ==================== Main ====================

async function main() {
  const t0 = Date.now();

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ROM440 Hardware Resources — Fresh Import');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  if (Number.isFinite(LIMIT)) console.log(`Limit: ${LIMIT} CSV rows`);
  if (ONLY) console.log(`Only vendor_sku: ${ONLY}`);
  console.log('');

  // ─── Phase 0: Preflight ─────────────────────────────────────────────
  preflightFiles();
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('FATAL: database connection failed:', err.message);
    process.exit(1);
  }
  console.log('[Phase 0] Preflight OK (files + db)');

  // ─── Phase 2a: Parse XLSX ───────────────────────────────────────────
  const xlsxPath = path.join(DATA_DIR, XLSX_FILE);
  const xlsxByVendorSku = parseXlsx(xlsxPath);
  console.log(`[Phase 2] xlsx rows: ${xlsxByVendorSku.size}`);

  // ─── Phase 2b: Parse CSVs ───────────────────────────────────────────
  let csvRows = [];
  for (const { file, masterClass } of CSV_FILES) {
    const p = path.join(DATA_DIR, file);
    const raw = parseCsvFile(p);
    let count = 0;
    for (const r of raw) {
      const row = normalizeCsvRow(r, masterClass);
      if (row) { csvRows.push(row); count++; }
    }
    console.log(`  ${masterClass.padEnd(22)} ${String(count).padStart(5)} rows`);
  }
  console.log(`[Phase 2] total CSV rows: ${csvRows.length}`);

  // Apply --only / --limit filters
  if (ONLY) {
    csvRows = csvRows.filter(r => r.vendorSku === ONLY);
    console.log(`[Phase 2] after --only filter: ${csvRows.length} rows`);
    if (!csvRows.length) {
      console.error(`FATAL: vendor_sku ${ONLY} not found in any CSV`);
      process.exit(1);
    }
  }
  if (Number.isFinite(LIMIT)) {
    csvRows = csvRows.slice(0, LIMIT);
    console.log(`[Phase 2] after --limit filter: ${csvRows.length} rows`);
  }

  const covered = csvRows.filter(r => xlsxByVendorSku.has(r.vendorSku)).length;
  const pct = csvRows.length ? ((covered / csvRows.length) * 100).toFixed(1) : '0.0';
  console.log(`[Phase 2] xlsx coverage: ${covered}/${csvRows.length} (${pct}%)`);

  // ─── Phase 3: Family grouping ───────────────────────────────────────
  const families = new Map();
  for (const row of csvRows) {
    const xlsx = xlsxByVendorSku.get(row.vendorSku);
    let key, name, normDesc, variantName;

    if (xlsx && xlsx.productTitle) {
      // xlsx-covered: family = Product Title within master class
      key = `${row.masterClass}|XLSX|${xlsx.productTitle}`;
      name = xlsx.productTitle;
      normDesc = stripMarkers(xlsx.description || row.description);
      variantName = xlsx.finish || extractVariantName(row.description);
    } else {
      normDesc = stripMarkers(row.description);
      if (!normDesc) {
        // Empty description → singleton keyed on vendor_sku
        key = `${row.masterClass}|SINGLETON|${row.vendorSku}`;
        name = (row.description || row.vendorSku).slice(0, 80) || row.vendorSku;
      } else {
        key = familyKey(row.masterClass, row.collection, normDesc);
        name = familyDisplayName(normDesc);
      }
      variantName = extractVariantName(row.description);
    }

    if (!variantName || !variantName.trim()) variantName = 'Standard';

    if (!families.has(key)) {
      families.set(key, {
        masterClass: row.masterClass,
        collection: row.collection || '',
        name,
        normDesc,
        descriptionLong: (xlsx?.description || row.description || '').trim(),
        skuRows: [],
        xlsxCovered: !!xlsx,
      });
    }
    families.get(key).skuRows.push({ ...row, variantName, xlsx });
  }

  console.log(`[Phase 3] families: ${families.size}`);
  {
    // Per master class family & SKU counts (for logging only)
    const byMc = new Map();
    for (const f of families.values()) {
      const prev = byMc.get(f.masterClass) || { products: 0, skus: 0 };
      prev.products++;
      prev.skus += f.skuRows.length;
      byMc.set(f.masterClass, prev);
    }
    for (const [mc, { products, skus }] of [...byMc.entries()].sort((a, b) => b[1].skus - a[1].skus)) {
      console.log(`  ${mc.padEnd(22)} ${String(products).padStart(5)} products  ${String(skus).padStart(6)} skus`);
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No database writes performed.');
    console.log(`Elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await pool.end();
    return;
  }

  // ─── Phase 1: Schema bootstrap (vendor, categories, attributes) ─────
  // These upserts run OUTSIDE the main transaction so they are committed
  // even if a later row fails during a partial import.
  console.log('\n[Phase 1] Bootstrapping vendor / categories / attributes');

  const vRes = await pool.query(
    `INSERT INTO vendors (id, name, code, website)
     VALUES (gen_random_uuid(), $1, $2, $3)
     ON CONFLICT (code) DO UPDATE SET
       name = EXCLUDED.name,
       website = EXCLUDED.website
     RETURNING id`,
    [VENDOR.name, VENDOR.code, VENDOR.website]
  );
  const vendorId = vRes.rows[0].id;
  console.log(`  vendor ${VENDOR.code} → ${vendorId}`);

  const parentRes = await pool.query(
    `INSERT INTO categories (slug, name, parent_id, is_active)
     VALUES ($1, $2, NULL, true)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       parent_id = NULL,
       is_active = true
     RETURNING id`,
    [PARENT_CATEGORY.slug, PARENT_CATEGORY.name]
  );
  const parentId = parentRes.rows[0].id;
  console.log(`  parent category ${PARENT_CATEGORY.slug} → ${parentId}`);

  const categoryByMasterClass = {};
  const variantTypeByMasterClass = {};
  for (const c of CHILD_CATEGORIES) {
    const cRes = await pool.query(
      `INSERT INTO categories (slug, name, parent_id, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         parent_id = EXCLUDED.parent_id,
         is_active = true
       RETURNING id`,
      [c.slug, c.name, parentId]
    );
    categoryByMasterClass[c.masterClass] = cRes.rows[0].id;
    variantTypeByMasterClass[c.masterClass] = c.variantType;
  }
  console.log(`  ${CHILD_CATEGORIES.length} child categories upserted`);

  for (const slug of ATTR_SLUGS) {
    const name = slug.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    await pool.query(
      `INSERT INTO attributes (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING`,
      [name, slug]
    );
  }
  const attrRes = await pool.query(
    `SELECT id, slug FROM attributes WHERE slug = ANY($1)`,
    [ATTR_SLUGS]
  );
  const attrIds = {};
  for (const r of attrRes.rows) attrIds[r.slug] = r.id;
  console.log(`  attributes: ${Object.keys(attrIds).join(', ')}`);

  // ─── Phases 4–6: Products, SKUs, pricing, packaging, attrs, media ───
  console.log('\n[Phase 4–6] Writing products / skus / pricing / media (single transaction)');

  const client = await pool.connect();
  const stats = {
    products: 0, productsInserted: 0,
    skus: 0, pricing: 0, packaging: 0, attrs: 0,
    media: { primary: 0, alternate: 0, lifestyle: 0, spec_pdf: 0 },
  };

  try {
    await client.query('BEGIN');

    async function setAttr(skuId, slug, value) {
      if (value === null || value === undefined) return;
      const s = String(value).trim();
      if (!s) return;
      const attrId = attrIds[slug];
      if (!attrId) return;
      await client.query(
        `INSERT INTO sku_attributes (sku_id, attribute_id, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
        [skuId, attrId, s]
      );
      stats.attrs++;
    }

    let famIdx = 0;
    for (const fam of families.values()) {
      famIdx++;
      const categoryId = categoryByMasterClass[fam.masterClass] || null;
      const variantType = variantTypeByMasterClass[fam.masterClass] || 'hardware';

      // Generate slug (with retry on unique violation).
      const firstVs = fam.skuRows[0]?.vendorSku || 'sku';
      let slug = familySlug(fam.name, firstVs);

      const descShort = (fam.normDesc || fam.name || '').slice(0, 255);
      const descLong = fam.descriptionLong || null;

      // Upsert product, retrying slug on collision
      let productId = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const pRes = await client.query(
            `INSERT INTO products (vendor_id, name, collection, category_id, status,
                                   description_short, description_long, slug, is_active)
             VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, true)
             ON CONFLICT ON CONSTRAINT products_vendor_collection_name_unique DO UPDATE SET
               category_id       = EXCLUDED.category_id,
               description_short = COALESCE(EXCLUDED.description_short, products.description_short),
               description_long  = COALESCE(EXCLUDED.description_long,  products.description_long),
               slug              = COALESCE(products.slug, EXCLUDED.slug),
               updated_at        = CURRENT_TIMESTAMP
             RETURNING id, (xmax = 0) AS is_new`,
            [vendorId, fam.name, fam.collection || '', categoryId, descShort, descLong, slug]
          );
          productId = pRes.rows[0].id;
          if (pRes.rows[0].is_new) stats.productsInserted++;
          break;
        } catch (err) {
          if (err.code === '23505' && /slug/i.test(err.message || '')) {
            slug = `${familySlug(fam.name, firstVs)}-${randomHex(4)}`;
            continue;
          }
          throw err;
        }
      }
      if (!productId) {
        throw new Error(`Failed to upsert product after retries: ${fam.name}`);
      }
      stats.products++;

      // ── SKU loop ──
      for (const row of fam.skuRows) {
        const internalSku = `ROM440-${row.vendorSku}`;

        const sRes = await client.query(
          `INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name,
                             sell_by, variant_type, is_sample, status)
           VALUES ($1, $2, $3, $4, 'unit', $5, false, 'active')
           ON CONFLICT (internal_sku) DO UPDATE SET
             product_id   = EXCLUDED.product_id,
             vendor_sku   = EXCLUDED.vendor_sku,
             variant_name = EXCLUDED.variant_name,
             sell_by      = 'unit',
             variant_type = EXCLUDED.variant_type,
             updated_at   = CURRENT_TIMESTAMP
           RETURNING id`,
          [productId, row.vendorSku, internalSku, row.variantName, variantType]
        );
        const skuId = sRes.rows[0].id;
        stats.skus++;

        // Pricing — NEVER write cut_price.
        const cost = row.fullCarton;
        const retail = row.listPrice ?? row.fullCarton;
        if (cost !== null && retail !== null && cost >= 0 && retail >= 0) {
          await client.query(PRICING_INSERT_SQL, [
            skuId,
            cost.toFixed(2),
            retail.toFixed(2),
          ]);
          stats.pricing++;
        }

        // Packaging (only if inner or outer qty present)
        if (row.innerQty !== null || row.outerQty !== null) {
          await client.query(
            `INSERT INTO packaging (sku_id, pieces_per_box, boxes_per_pallet)
             VALUES ($1, $2, $3)
             ON CONFLICT (sku_id) DO UPDATE SET
               pieces_per_box   = COALESCE(EXCLUDED.pieces_per_box, packaging.pieces_per_box),
               boxes_per_pallet = COALESCE(EXCLUDED.boxes_per_pallet, packaging.boxes_per_pallet)`,
            [skuId, row.innerQty, row.outerQty]
          );
          stats.packaging++;
        }

        // Attributes
        const finishVal = row.xlsx?.finish
          || (extractVariantName(row.description) !== 'Standard'
              ? extractVariantName(row.description)
              : null);
        await setAttr(skuId, 'finish', finishVal);

        if (row.xlsx?.measurements) {
          const m = row.xlsx.measurements;
          await setAttr(skuId, 'diameter',         m.diameter);
          await setAttr(skuId, 'center_to_center', m.centerToCenter);
          await setAttr(skuId, 'overall_length',   m.overallLength);
          await setAttr(skuId, 'width',            m.width);
          await setAttr(skuId, 'projection',       m.projection);
          await setAttr(skuId, 'clearance',        m.clearance);
        }

        const spMatch = row.description?.match(SPECIES_RE);
        if (spMatch) await setAttr(skuId, 'species', spMatch[1].trim());

        // Media (xlsx-covered SKUs only) — delete-then-insert
        if (row.xlsx) {
          await client.query(
            `DELETE FROM media_assets WHERE product_id = $1 AND sku_id = $2`,
            [productId, skuId]
          );

          const upgrade = url => (url || '').replace(/^http:\/\//i, 'https://').trim();

          const mainImg = upgrade(row.xlsx.mainImage);
          if (mainImg) {
            await client.query(
              `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
               VALUES ($1, $2, 'primary', $3, $4, 0)`,
              [productId, skuId, mainImg, row.xlsx.mainImage || null]
            );
            stats.media.primary++;
          }

          const alts = (row.xlsx.altImages || [])
            .map(upgrade)
            .filter(Boolean);
          for (let i = 0; i < alts.length; i++) {
            await client.query(
              `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
               VALUES ($1, $2, 'alternate', $3, $4, $5)`,
              [productId, skuId, alts[i], row.xlsx.altImages[i] || null, i]
            );
            stats.media.alternate++;
          }

          const lifestyle = upgrade(row.xlsx.lifestyle);
          if (lifestyle) {
            await client.query(
              `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
               VALUES ($1, $2, 'lifestyle', $3, $4, 0)`,
              [productId, skuId, lifestyle, row.xlsx.lifestyle || null]
            );
            stats.media.lifestyle++;
          }

          const spec = upgrade(row.xlsx.spec);
          if (spec) {
            await client.query(
              `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
               VALUES ($1, $2, 'spec_pdf', $3, $4, 0)`,
              [productId, skuId, spec, row.xlsx.spec || null]
            );
            stats.media.spec_pdf++;
          }
        }
      }

      if (famIdx % 250 === 0) {
        console.log(`  [${famIdx}/${families.size}] products processed (${stats.skus} skus so far)`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nFATAL: import failed, rolled back:');
    console.error(err);
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  // ─── Phase 7: Verification summary ──────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Import Complete');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Families (products upserted):  ${stats.products}`);
  console.log(`  of which newly inserted:     ${stats.productsInserted}`);
  console.log(`SKUs:                          ${stats.skus}`);
  console.log(`Pricing rows:                  ${stats.pricing}`);
  console.log(`Packaging rows:                ${stats.packaging}`);
  console.log(`SKU attributes upserted:       ${stats.attrs}`);
  console.log(`Media assets:`);
  console.log(`  primary:   ${stats.media.primary}`);
  console.log(`  alternate: ${stats.media.alternate}`);
  console.log(`  lifestyle: ${stats.media.lifestyle}`);
  console.log(`  spec_pdf:  ${stats.media.spec_pdf}`);

  // Per master class post-write verification (queries the DB)
  try {
    const mcRes = await pool.query(
      `SELECT c.name AS master_class,
              COUNT(DISTINCT p.id) AS products,
              COUNT(s.id) AS skus
         FROM products p
         JOIN vendors v    ON v.id = p.vendor_id
         JOIN categories c ON c.id = p.category_id
         JOIN skus s       ON s.product_id = p.id
        WHERE v.code = $1
        GROUP BY c.name
        ORDER BY skus DESC`,
      [VENDOR.code]
    );
    console.log('\nPer-category (DB):');
    for (const row of mcRes.rows) {
      console.log(`  ${row.master_class.padEnd(22)} ${String(row.products).padStart(5)} products  ${String(row.skus).padStart(6)} skus`);
    }

    // cut_price regression guard
    const cpRes = await pool.query(
      `SELECT COUNT(*)::int AS n
         FROM pricing pr
         JOIN skus s    ON s.id = pr.sku_id
         JOIN products p ON p.id = s.product_id
         JOIN vendors v ON v.id = p.vendor_id
        WHERE v.code = $1 AND pr.cut_price IS NOT NULL`,
      [VENDOR.code]
    );
    const cutPriceRows = cpRes.rows[0].n;
    console.log(`\nROM440 rows with cut_price set: ${cutPriceRows}  ${cutPriceRows === 0 ? '✓' : '✗ REGRESSION'}`);
    if (cutPriceRows !== 0) {
      console.error('FATAL: cut_price is populated for ROM440 SKUs — carpet UI will trigger.');
      await pool.end();
      process.exit(1);
    }
  } catch (err) {
    console.error('Post-import verification query failed:', err.message);
  }

  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await pool.end();
}

main().catch(async err => {
  console.error('Unhandled error:', err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
