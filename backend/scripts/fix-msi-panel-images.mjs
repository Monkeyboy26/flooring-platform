#!/usr/bin/env node
/**
 * MSI — Fix stacked-stone panel image matching (2026-08-31)
 *
 * Root causes:
 *   1. Earlier image passes assigned SOURCE-STONE swatches (colornames/
 *      white-oak-marble.jpg etc.) and field-tile shots (/images/skus/
 *      white-oak-12x24-honed.jpg) to ledger PANEL SKUs — right stone, wrong
 *      product form. The DAM importer's skip-if-occupied rule then kept the
 *      correct panel images (already on disk) out of the DB.
 *   2. Travertine pattern/field SKUs (TTPHIL-PAT-*, TTSCAB-PAT-*, TTSCAB*HF)
 *      were grouped under stacked-stone panel products, and blind sibling
 *      inheritance gave some of them the PANEL's image (and vice versa the
 *      panel PDP shows a flat travertine pattern).
 *   3. A few standalone field-tile/mosaic products sit in the stacked-stone
 *      category (Scabas Hf, Autumnx.50 Gauged, Chestnut Brown, Scabas 2x2).
 *
 * Actions (in order):
 *   A. Category flips: field-tile/mosaic products out of stacked-stone.
 *   B. Regroup: TTPHIL-PAT-HUCB -> "Philadelphia Travertine Pattern";
 *      TTSCAB-PAT-* + TTSCABVC1224HF -> "Tuscany Scabas Travertine"
 *      (natural-stone). Borrowed panel images on the moved SKUs are deleted.
 *   C. Purge: delete source-stone swatch / field-tile media on SKUs and
 *      products still in stacked-stone (Terrado veneer + acoustic wood-slat
 *      colornames images are NOT in this class and are kept).
 *   D. Refill: for active stacked-stone SKUs without a primary — exact-SKU
 *      DAM file first, else CDN probe of hardscaping panel URL patterns
 *      (finish-aware; never colornames).
 *   E. Finish-mismatch: primaries showing 3d-honed/3d-wave/multi-finish/mini
 *      shots on SKUs that aren't that finish get re-probed for the plain shot.
 *
 * Idempotent — safe to re-run after MSI re-scrapes.
 *
 * Usage:
 *   node backend/scripts/fix-msi-panel-images.mjs --dry-run
 *   node backend/scripts/fix-msi-panel-images.mjs
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In the api container uploads mounts at $UPLOADS_PATH (/app/uploads), not ../../uploads
const UPLOADS_BASE = process.env.UPLOADS_PATH || path.resolve(__dirname, '..', '..', 'uploads');
const DAM_DIR = path.join(UPLOADS_BASE, 'msi-dam');
const CDN = 'https://cdn.msisurfaces.com/images';

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const log = (m) => console.log(m);

// ── Bad-image detector (stacked-stone context only) ─────────────────────────
// Source-stone swatches and field-tile SKU shots. Deliberately does NOT match
// colornames of the panel lines themselves (…-stacked-stone-panels.jpg,
// …-manufactured-stone-veneers.jpg, …-wood-slat-panels.jpg).
const STONE_SWATCH_RE = /\/colornames\/(?:videos\/)?[^/]*-(marble|granite|slate|travertine|quartzite|limestone|sandstone|onyx)\.jpg$/i;
const FIELD_TILE_RE = /\/images\/skus\//i;
const isBadPanelImage = (url) =>
  !!url && (FIELD_TILE_RE.test(url) || STONE_SWATCH_RE.test(url));

// ── CDN probing ─────────────────────────────────────────────────────────────
function headUrl(url) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = https.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
      res.resume();
      fin(res.statusCode === 200 ? url : null);
    });
    req.on('error', () => fin(null));
    req.on('timeout', () => { req.destroy(); fin(null); });
    req.end();
  });
}

async function probeFirst(urls) {
  for (const u of urls) {
    const hit = await headUrl(u);
    if (hit) return hit;
  }
  return null;
}

const slugify = (t) => (t || '').toLowerCase()
  .replace(/['']/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const DROP_WORDS = new Set([
  'panel', 'panels', 'pnl', 'splitface', 'split', 'face', 'mini', 'corner',
  'corners', 'flats', 'flat', 'xl', 'rockmount', 'terrado', 'sqft', 'sf',
  'pencil', 'pencilledger', '3d', 'honed', 'wave', 'multi', 'finish', 'l',
]);
const STONE_WORDS = new Set(['marble', 'granite', 'slate', 'travertine', 'quartzite', 'limestone']);

function baseSlugs(name) {
  const words = slugify(name).split('-').filter((w) => w && !DROP_WORDS.has(w) && !/^\d/.test(w));
  const full = words.join('-');
  const noStone = words.filter((w) => !STONE_WORDS.has(w)).join('-');
  return [...new Set([full, noStone])].filter(Boolean);
}

function finishVariants(vendorSku) {
  const u = vendorSku.toUpperCase();
  const v = [];
  if (u.includes('3DH')) v.push('3d-honed');
  if (u.includes('3DW')) v.push('3d-wave');
  if (u.includes('MULTI')) v.push('multi-finish');
  if (u.includes('MINI')) v.push('mini');
  if (u.includes('PEN')) v.push('pencil');
  return v;
}

function cdnCandidates(productName, vendorSku) {
  const urls = [];
  for (const base of baseSlugs(productName)) {
    const stems = [];
    // Finish-specific shots first so e.g. a 3DH SKU prefers the 3d-honed image
    for (const f of finishVariants(vendorSku)) stems.push(`${base}-${f}`);
    stems.push(base, `${base}-splitface`, `${base}-terrado`);
    for (const stem of stems) {
      urls.push(`${CDN}/hardscaping/detail/${stem}-stacked-stone-panels.jpg`);
      urls.push(`${CDN}/hardscaping/${stem}-stacked-stone-panels.jpg`);
      urls.push(`${CDN}/hardscaping/thumbnails/${stem}-stacked-stone-panels.jpg`);
      urls.push(`${CDN}/hardscaping/detail/${stem}.jpg`);
    }
  }
  return [...new Set(urls)];
}

// ── DB helpers ──────────────────────────────────────────────────────────────
async function setPrimary(client, { productId, skuId, url, originalUrl }) {
  const { rows } = await client.query(
    `SELECT id FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary' AND sort_order = 0`,
    [skuId]
  );
  if (rows.length) {
    await client.query(
      `UPDATE media_assets SET url = $1, original_url = $2 WHERE id = $3`,
      [url, originalUrl || url, rows[0].id]
    );
  } else {
    await client.query(
      `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
       VALUES ($1, $2, 'primary', $3, $4, 0)`,
      [productId, skuId, url, originalUrl || url]
    );
  }
}

async function addAlternateIfFree(client, { productId, skuId, url, sortOrder }) {
  const { rows } = await client.query(
    `SELECT 1 FROM media_assets WHERE sku_id = $1 AND asset_type = 'alternate' AND sort_order = $2`,
    [skuId, sortOrder]
  );
  const { rows: dupe } = await client.query(
    `SELECT 1 FROM media_assets WHERE sku_id = $1 AND url = $2`,
    [skuId, url]
  );
  if (rows.length || dupe.length) return false;
  await client.query(
    `INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
     VALUES ($1, $2, 'alternate', $3, $3, $4)`,
    [productId, skuId, url, sortOrder]
  );
  return true;
}

async function run() {
  const backup = { deleted: [], updated: [], moved_skus: [], category_flips: [] };
  const client = await pool.connect();
  try {
    const { rows: vrows } = await client.query(`SELECT id FROM vendors WHERE code = 'MSI'`);
    const msiId = vrows[0].id;
    const { rows: crows } = await client.query(
      `SELECT id, slug FROM categories WHERE slug IN ('stacked-stone','natural-stone','mosaic-tile')`
    );
    const cat = Object.fromEntries(crows.map((r) => [r.slug, r.id]));

    // ═══ A. Category flips: field tiles / mosaic out of stacked-stone ═══════
    log('── A. Category flips ──');
    const FLIPS = [
      { vendorSku: 'TTSCAB1818HF', to: 'natural-stone' },  // Scabas 18x18 honed-filled field tile
      { vendorSku: 'SAUT1616G-C', to: 'natural-stone' },   // Autumn 16x16 gauged slate field tile
      { vendorSku: 'TCB1616H', to: 'natural-stone' },      // Chestnut Brown 16x16 honed field tile
      { vendorSku: 'SMOT-SCAB-2X2T', to: 'mosaic-tile' },  // Scabas 2x2 tumbled mosaic
    ];
    for (const f of FLIPS) {
      const { rows } = await client.query(
        `SELECT p.id, p.name FROM products p
         JOIN skus s ON s.product_id = p.id
         WHERE p.vendor_id = $1 AND s.vendor_sku = $2 AND p.category_id = $3`,
        [msiId, f.vendorSku, cat['stacked-stone']]
      );
      if (!rows.length) { log(`  skip (already moved): ${f.vendorSku}`); continue; }
      log(`  ${rows[0].name} (${f.vendorSku}) stacked-stone -> ${f.to}`);
      backup.category_flips.push({ product_id: rows[0].id, from: 'stacked-stone', to: f.to });
      if (!DRY_RUN) {
        await client.query(
          `UPDATE products SET category_id = $1, category_needs_review = false, updated_at = NOW() WHERE id = $2`,
          [cat[f.to], rows[0].id]
        );
      }
    }

    // ═══ B. Regroup travertine pattern/field SKUs out of panel products ═════
    log('── B. Regroup pattern/field SKUs ──');
    const REGROUPS = [
      {
        newName: 'Philadelphia Travertine Pattern',
        donorName: 'Philadelphia Panel',
        skus: [{ vendorSku: 'TTPHIL-PAT-HUCB', variantName: 'Pattern (HUCB)' }],
      },
      {
        newName: 'Tuscany Scabas Travertine',
        donorName: 'Tuscany Scabas Travertine Panel',
        skus: [
          { vendorSku: 'TTSCAB-PAT-HUCB', variantName: 'Pattern (HUCB)' },
          { vendorSku: 'TTSCAB-PAT-HUFC', variantName: 'Pattern (HUFC)' },
          { vendorSku: 'TTSCAB-PAT-TUM', variantName: 'Pattern (Tumbled)' },
          { vendorSku: 'TTSCABVC1224HF', variantName: '12x24 Honed Filled' },
        ],
        // The stone's own colornames swatch is a correct depiction for a
        // natural-stone travertine product (standard treatment for stone tile).
        fallbackPrimary: `${CDN}/colornames/tuscany-scabas-travertine.jpg`,
      },
    ];

    for (const rg of REGROUPS) {
      const { rows: skuRows } = await client.query(
        `SELECT s.id, s.vendor_sku, s.product_id, p.name AS product_name, p.collection, p.brand_id, p.status
         FROM skus s JOIN products p ON p.id = s.product_id
         WHERE p.vendor_id = $1 AND s.vendor_sku = ANY($2)`,
        [msiId, rg.skus.map((x) => x.vendorSku)]
      );
      const toMove = skuRows.filter((r) => r.product_name === rg.donorName);
      if (!toMove.length) { log(`  skip (already moved): ${rg.newName}`); continue; }

      // Find or create the target product
      let { rows: target } = await client.query(
        `SELECT id FROM products WHERE vendor_id = $1 AND name = $2`,
        [msiId, rg.newName]
      );
      let targetId = target[0]?.id;
      if (!targetId) {
        log(`  create product: ${rg.newName} (natural-stone)`);
        if (!DRY_RUN) {
          const donor = toMove[0];
          const { rows: ins } = await client.query(
            `INSERT INTO products (vendor_id, brand_id, name, collection, category_id, status)
             VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
            [msiId, donor.brand_id, rg.newName, donor.collection || '', cat['natural-stone']]
          );
          targetId = ins[0].id;
        }
      }

      for (const row of toMove) {
        const spec = rg.skus.find((x) => x.vendorSku === row.vendor_sku);
        log(`  move ${row.vendor_sku}: "${rg.donorName}" -> "${rg.newName}"`);
        backup.moved_skus.push({ sku_id: row.id, from_product: row.product_id });
        if (DRY_RUN) continue;

        // Drop images borrowed from the panel product (sibling inheritance / panel DAM)
        const { rows: borrowed } = await client.query(
          `SELECT id, url, asset_type FROM media_assets
           WHERE sku_id = $1 AND (url ~* 'LPNL' OR url ~* 'stacked-stone-panels')`,
          [row.id]
        );
        for (const b of borrowed) {
          backup.deleted.push({ ...b, sku_id: row.id, reason: 'borrowed-panel-image' });
          await client.query(`DELETE FROM media_assets WHERE id = $1`, [b.id]);
        }

        await client.query(
          `UPDATE skus SET product_id = $1, variant_name = COALESCE(variant_name, $2), updated_at = NOW() WHERE id = $3`,
          [targetId, spec?.variantName || null, row.id]
        );
        await client.query(
          `UPDATE media_assets SET product_id = $1 WHERE sku_id = $2`,
          [targetId, row.id]
        );

        // Ensure a primary: own DAM file, else the regroup's fallback swatch
        const { rows: hasPrimary } = await client.query(
          `SELECT 1 FROM media_assets WHERE sku_id = $1 AND asset_type = 'primary'`, [row.id]
        );
        if (!hasPrimary.length) {
          const damFile = path.join(DAM_DIR, `${row.vendor_sku}.jpg`);
          const url = fs.existsSync(damFile) ? `/uploads/msi-dam/${row.vendor_sku}.jpg` : rg.fallbackPrimary;
          if (url) {
            await setPrimary(client, { productId: targetId, skuId: row.id, url });
            log(`    primary <- ${url}`);
          }
        }
      }
    }

    // ═══ C. Purge source-stone swatches / field-tile shots in stacked-stone ═
    log('── C. Purge wrong-form images on stacked-stone ──');
    const { rows: badRows } = await client.query(
      `SELECT ma.id, ma.url, ma.asset_type, ma.sku_id, ma.product_id, s.vendor_sku, p.name AS product_name
       FROM media_assets ma
       JOIN products p ON p.id = ma.product_id
       LEFT JOIN skus s ON s.id = ma.sku_id
       WHERE p.vendor_id = $1 AND p.category_id = $2
         AND (ma.url ~* '/images/skus/'
              OR ma.url ~* '/colornames/(videos/)?[^/]*-(marble|granite|slate|travertine|quartzite|limestone|sandstone|onyx)\\.jpg$')`,
      [msiId, cat['stacked-stone']]
    );
    for (const b of badRows) {
      if (!isBadPanelImage(b.url)) continue; // belt & suspenders vs regex drift
      log(`  del [${b.asset_type}] ${b.product_name} ${b.vendor_sku || '(product-level)'}: ${b.url}`);
      backup.deleted.push({ id: b.id, url: b.url, asset_type: b.asset_type, sku_id: b.sku_id, product_id: b.product_id, reason: 'wrong-form-swatch' });
      if (!DRY_RUN) await client.query(`DELETE FROM media_assets WHERE id = $1`, [b.id]);
    }
    log(`  purged: ${badRows.length}`);

    // ═══ D. Refill primaries: DAM exact -> CDN hardscaping probe ════════════
    log('── D. Refill missing panel primaries ──');
    const { rows: missing } = await client.query(
      `SELECT s.id, s.vendor_sku, s.product_id, p.name AS product_name
       FROM skus s JOIN products p ON p.id = s.product_id
       LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
       WHERE p.vendor_id = $1 AND p.category_id = $2 AND s.status = 'active' AND ma.id IS NULL
       ORDER BY p.name`,
      [msiId, cat['stacked-stone']]
    );
    let filledDam = 0, filledCdn = 0, unresolved = 0;
    for (const m of missing) {
      const damFile = path.join(DAM_DIR, `${m.vendor_sku}.jpg`);
      if (fs.existsSync(damFile)) {
        const url = `/uploads/msi-dam/${m.vendor_sku}.jpg`;
        log(`  DAM  ${m.product_name} ${m.vendor_sku} <- ${url}`);
        if (!DRY_RUN) {
          await setPrimary(client, { productId: m.product_id, skuId: m.id, url });
          for (const [suffix, sort] of [['-iso', 1], ['-alternate', 2]]) {
            const alt = path.join(DAM_DIR, `${m.vendor_sku}${suffix}.jpg`);
            if (fs.existsSync(alt)) {
              await addAlternateIfFree(client, {
                productId: m.product_id, skuId: m.id,
                url: `/uploads/msi-dam/${m.vendor_sku}${suffix}.jpg`, sortOrder: sort,
              });
            }
          }
        }
        filledDam++;
        continue;
      }
      const hit = await probeFirst(cdnCandidates(m.product_name, m.vendor_sku));
      if (hit) {
        log(`  CDN  ${m.product_name} ${m.vendor_sku} <- ${hit}`);
        if (!DRY_RUN) await setPrimary(client, { productId: m.product_id, skuId: m.id, url: hit });
        filledCdn++;
      } else {
        log(`  MISS ${m.product_name} ${m.vendor_sku} (stays imageless)`);
        unresolved++;
      }
    }
    log(`  filled: ${filledDam} DAM + ${filledCdn} CDN, unresolved: ${unresolved}`);

    // ═══ E. Finish-mismatch primaries (plain SKU wearing 3d-honed etc.) ═════
    log('── E. Finish-mismatch primaries ──');
    const { rows: prim } = await client.query(
      `SELECT ma.id, ma.url, s.vendor_sku, p.name AS product_name
       FROM media_assets ma
       JOIN skus s ON s.id = ma.sku_id
       JOIN products p ON p.id = s.product_id
       WHERE p.vendor_id = $1 AND p.category_id = $2 AND ma.asset_type = 'primary'
         AND s.status = 'active' AND ma.url ~* '(3d-honed|3d-wave|multi-finish|-mini-)'`,
      [msiId, cat['stacked-stone']]
    );
    let refit = 0;
    for (const r of prim) {
      const sku = r.vendor_sku.toUpperCase();
      const urlHas = {
        '3d-honed': /3d-honed/i.test(r.url), '3d-wave': /3d-wave/i.test(r.url),
        'multi-finish': /multi-finish/i.test(r.url), mini: /-mini-/i.test(r.url),
      };
      const skuHas = {
        '3d-honed': sku.includes('3DH'), '3d-wave': sku.includes('3DW'),
        'multi-finish': sku.includes('MULTI'), mini: sku.includes('MINI'),
      };
      const mismatch = Object.keys(urlHas).some((k) => urlHas[k] && !skuHas[k]);
      if (!mismatch) continue;
      // Probe for the SKU's own finish (or plain) shot
      const hit = await probeFirst(cdnCandidates(r.product_name, r.vendor_sku).filter((u) => u !== r.url));
      if (hit && hit !== r.url) {
        log(`  refit ${r.product_name} ${r.vendor_sku}: ${r.url} -> ${hit}`);
        backup.updated.push({ id: r.id, old_url: r.url, new_url: hit });
        if (!DRY_RUN) await client.query(
          `UPDATE media_assets SET url = $1, original_url = $1 WHERE id = $2`, [hit, r.id]
        );
        refit++;
      }
    }
    log(`  refit: ${refit}`);

    // ═══ Backup + summary ═══════════════════════════════════════════════════
    if (!DRY_RUN) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.resolve(__dirname, '..', 'data', `msi-panel-image-fix-backup-${ts}.json`);
      fs.writeFileSync(file, JSON.stringify(backup, null, 2));
      log(`Backup written: ${file}`);
    }
    log(DRY_RUN ? 'DRY RUN — no changes applied.' : 'Done.');
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
