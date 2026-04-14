#!/usr/bin/env node
/**
 * msi-image-overhaul.cjs
 *
 * Conservative image fix strategy — never leave a product worse off:
 * 1. For SHARED primary images: find the rightful owner, find unique images for others
 * 2. Only remove a shared image from a product if a unique replacement was found
 * 3. Remove images that are clearly from a DIFFERENT collection/product entirely
 * 4. For products with NO images, try CDN probes + sibling sharing
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const VENDOR_ID = '550e8400-e29b-41d4-a716-446655440001';
const CDN_BASE = 'https://cdn.msisurfaces.com/images';

function slugify(str) {
  return (str || '').toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractSlugWords(url) {
  const m = url.match(/\/([^/]+?)(?:\.(jpg|png|jpeg|webp))?$/i);
  if (!m) return [];
  return m[1].toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(w => w.length > 2);
}

const NOISE = new Set([
  'iso', 'front', 'edge', 'detail', 'two', 'matte', 'polished', 'honed', 'glossy',
  'porcelain', 'ceramic', 'vinyl', 'flooring', 'tile', 'marble', 'granite',
  'travertine', 'limestone', 'quartzite', 'sandstone', 'onyx', 'slab',
  'pavers', 'paver', 'panels', 'panel', 'stacked', 'stone', 'ledger',
  'mosaic', 'hexagon', 'hex', 'herringbone', 'chevron', 'subway',
  'picket', 'basketweave', 'penny', 'pencil', 'arabesque',
  'trim', 'accessories', 'bullnose', 'molding', 'reducer', 'threshold',
  'stairnose', 'cap', 'corner', 'quarter', 'liner',
  'multi', 'finish', 'pattern', 'interlocking', 'mesh', 'backed',
  'tumbled', 'splitface', 'split', 'face', 'brushed', 'flamed',
  'jpg', 'png', 'jpeg', 'webp', 'medium', 'large', 'small',
  'room', 'scene', 'roomscene', 'video', 'banner',
  '2cm', '3cm', '4mm', '6mm', '8mm', '12mm', 'variation',
  'manufactured', 'veneers', 'veneer',
]);

// Returns significant words (non-noise, length > 2) from a text
function sigWords(text) {
  return slugify(text).split('-').filter(w => w.length > 2 && !NOISE.has(w));
}

// Check if a URL matches a product's collection
function urlMatchesCollection(url, collection) {
  if (!collection) return false;
  const urlW = extractSlugWords(url).filter(w => !NOISE.has(w));
  const collW = sigWords(collection);
  if (collW.length === 0) return false;
  // All collection words must appear in the URL
  const matched = collW.filter(cw => urlW.some(uw => uw === cw || (uw.length >= 4 && cw.length >= 4 && (uw.startsWith(cw) || cw.startsWith(uw)))));
  return matched.length >= Math.max(1, Math.ceil(collW.length * 0.6));
}

// Score: how well does a URL match a specific product? Higher = better
function matchScore(url, name, collection) {
  const urlW = extractSlugWords(url).filter(w => !NOISE.has(w));
  const nameW = sigWords(name);
  const collW = sigWords(collection || '');
  const allW = [...new Set([...nameW, ...collW])];
  if (allW.length === 0 || urlW.length === 0) return 0;

  let matches = 0;
  for (const pw of allW) {
    if (urlW.some(uw => uw === pw || (uw.length >= 4 && pw.length >= 4 && (uw.startsWith(pw) || pw.startsWith(uw))))) {
      matches++;
    }
  }
  return matches / allW.length;
}

// Check if URL is clearly a generic/banner image
function isGenericImage(url) {
  return /\/(banners?|hardscape-redesign)\//i.test(url) ||
    /most-popular|hero-image|category-page/i.test(url);
}

function probeUrl(url) {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 5000 }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Generate CDN URL candidates for a product
function cdnCandidates(name, collection, catSlug) {
  const urls = [];
  const ns = slugify(name.replace(/\s*Trim & Accessories$/i, ''));
  const cs = slugify(collection || '');

  // Extract color from name (last word after collection)
  const nameAfterColl = collection ? name.replace(new RegExp(`^${collection.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '') : '';
  const colorSlug = slugify(nameAfterColl.replace(/\s*Trim & Accessories$/i, ''));
  const collColor = colorSlug ? `${cs}-${colorSlug}` : cs;

  const cat = (catSlug || '').toLowerCase();

  // Porcelain/Ceramic
  if (/porcelain|ceramic|backsplash|large/i.test(cat)) {
    urls.push(`${CDN_BASE}/porcelainceramic/iso/${collColor}-iso.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/iso/${cs}-${colorSlug}-iso.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/${collColor}-porcelain.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/${colorSlug}-${cs}-porcelain.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/iso/${colorSlug}-${cs}-porcelain-iso.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/edge/${collColor}-porcelain-edge.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/edge/${collColor}-edge.jpg`);
    urls.push(`${CDN_BASE}/porcelainceramic/edge/${colorSlug}-${cs}-porcelain-edge.jpg`);
  }
  // LVP
  if (/lvp|plank|vinyl|waterproof|transition|molding/i.test(cat)) {
    urls.push(`${CDN_BASE}/lvt/detail/${collColor}-vinyl-flooring.jpg`);
    urls.push(`${CDN_BASE}/lvt/detail/${cs}-${colorSlug}-vinyl-flooring.jpg`);
    urls.push(`${CDN_BASE}/lvt/detail/${ns}.jpg`);
    urls.push(`${CDN_BASE}/lvt/front/${collColor}-front.jpg`);
    urls.push(`${CDN_BASE}/lvt/iso/${collColor}-iso.jpg`);
    urls.push(`${CDN_BASE}/lvt/Detail/${collColor.split('-').map(w=>w[0].toUpperCase()+w.slice(1)).join('-')}-Vinyl-Flooring.jpg`);
  }
  // Stone/Hardscaping
  if (/stone|hardscaping|paver|stacked|ledger/i.test(cat)) {
    urls.push(`${CDN_BASE}/hardscaping/detail/${ns}.jpg`);
    urls.push(`${CDN_BASE}/hardscaping/detail/${collColor}-stacked-stone-panels.jpg`);
    urls.push(`${CDN_BASE}/hardscaping/detail/${ns}-stacked-stone-panels.jpg`);
    urls.push(`${CDN_BASE}/naturalstone/detail/${ns}.jpg`);
    urls.push(`${CDN_BASE}/naturalstone/${ns}.jpg`);
  }
  // Mosaic
  if (/mosaic/i.test(cat)) {
    urls.push(`${CDN_BASE}/mosaics/${ns}.jpg`);
    urls.push(`${CDN_BASE}/mosaics/${collColor}.jpg`);
    urls.push(`${CDN_BASE}/mosaics/iso/${ns}-iso.jpg`);
    urls.push(`${CDN_BASE}/mosaics/variations/${ns}.jpg`);
  }
  // Colornames (universal fallback)
  urls.push(`${CDN_BASE}/colornames/${ns}.jpg`);
  urls.push(`${CDN_BASE}/colornames/${collColor}.jpg`);
  urls.push(`${CDN_BASE}/colornames/${cs}.jpg`);

  return [...new Set(urls.filter(u => u && !u.includes('--') && !u.endsWith('-.jpg') && !u.includes('-undefined')))];
}

async function main() {
  console.log(`\n=== MSI Image Overhaul (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===\n`);
  const client = await pool.connect();

  try {
    // Load data
    const { rows: products } = await client.query(`
      SELECT p.id, p.name, p.collection, c.slug as cat_slug
      FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.vendor_id = $1 AND p.is_active = true ORDER BY p.name
    `, [VENDOR_ID]);

    const { rows: allMedia } = await client.query(`
      SELECT ma.id, ma.product_id, ma.url, ma.asset_type, ma.sort_order
      FROM media_assets ma JOIN products p ON p.id = ma.product_id
      WHERE p.vendor_id = $1 AND p.is_active = true ORDER BY ma.product_id, ma.sort_order
    `, [VENDOR_ID]);

    const prodMap = new Map(products.map(p => [p.id, p]));
    const mediaByProduct = new Map();
    for (const m of allMedia) {
      if (!mediaByProduct.has(m.product_id)) mediaByProduct.set(m.product_id, []);
      mediaByProduct.get(m.product_id).push(m);
    }

    // Build URL → products map for shared image detection
    const primaryByUrl = new Map();
    for (const m of allMedia) {
      if (m.asset_type !== 'primary') continue;
      if (!primaryByUrl.has(m.url)) primaryByUrl.set(m.url, []);
      primaryByUrl.get(m.url).push({ mediaId: m.id, productId: m.product_id });
    }

    const noImage = products.filter(p => !mediaByProduct.has(p.id));
    console.log(`  Products: ${products.length}, With images: ${mediaByProduct.size}, Without: ${noImage.length}`);

    // === Phase 1: Remove clearly wrong images (generic banners, cross-collection) ===
    console.log(`\n  Phase 1: Identifying clearly wrong images...`);

    const toDelete = []; // {mediaId, productId, reason}

    for (const [pid, media] of mediaByProduct) {
      const prod = prodMap.get(pid);
      if (!prod) continue;

      for (const m of media) {
        if (m.url.startsWith('/uploads/')) continue; // Skip uploads

        if (isGenericImage(m.url)) {
          toDelete.push({ mediaId: m.id, productId: pid, url: m.url, assetType: m.asset_type, reason: 'generic_banner' });
          continue;
        }

        // Check: does the URL match this product's collection at all?
        const collMatch = urlMatchesCollection(m.url, prod.collection);
        const nameScore = matchScore(m.url, prod.name, prod.collection);

        if (!collMatch && nameScore === 0) {
          // URL has NO connection to this product — definitely wrong
          toDelete.push({ mediaId: m.id, productId: pid, url: m.url, assetType: m.asset_type, reason: 'no_connection' });
        }
      }
    }

    console.log(`  Clearly wrong images: ${toDelete.length}`);
    console.log(`    generic_banner: ${toDelete.filter(d => d.reason === 'generic_banner').length}`);
    console.log(`    no_connection: ${toDelete.filter(d => d.reason === 'no_connection').length}`);

    // Identify products that will lose their primary
    const deleteIds = new Set(toDelete.map(d => d.mediaId));
    const losingPrimary = new Set();
    for (const d of toDelete) {
      if (d.assetType === 'primary') {
        const media = mediaByProduct.get(d.productId) || [];
        const hasSurvivingPrimary = media.some(m => m.asset_type === 'primary' && !deleteIds.has(m.id));
        if (!hasSurvivingPrimary) losingPrimary.add(d.productId);
      }
    }

    // === Phase 2: For shared primary images, find unique CDN images ===
    console.log(`\n  Phase 2: Finding unique images for shared-image products...`);

    const sharedUrls = [...primaryByUrl.entries()].filter(([url, entries]) => entries.length > 1);
    console.log(`  Shared primary images: ${sharedUrls.length} URLs across ${sharedUrls.reduce((s, [, e]) => s + e.length, 0)} products`);

    // For each shared URL, find the best owner and try to find unique images for others
    const replacements = new Map(); // productId -> {url, replaces: mediaId}
    const replaceAfterProbe = []; // products that need CDN probing for unique images

    for (const [url, entries] of sharedUrls) {
      // Score each product against this URL
      const scored = entries.map(e => {
        const p = prodMap.get(e.productId);
        return { ...e, score: p ? matchScore(url, p.name, p.collection) : 0, product: p };
      }).sort((a, b) => b.score - a.score);

      // Best match keeps the image; others need unique images
      for (let i = 1; i < scored.length; i++) {
        if (!scored[i].product) continue;
        replaceAfterProbe.push({
          productId: scored[i].productId,
          currentMediaId: scored[i].mediaId,
          productName: scored[i].product.name,
          collection: scored[i].product.collection,
          catSlug: scored[i].product.cat_slug,
        });
      }
    }

    // Also add products losing primary from phase 1 + products with no image
    const allNeedImage = new Map();
    for (const r of replaceAfterProbe) {
      allNeedImage.set(r.productId, r);
    }
    for (const pid of losingPrimary) {
      if (!allNeedImage.has(pid)) {
        const p = prodMap.get(pid);
        allNeedImage.set(pid, { productId: pid, productName: p.name, collection: p.collection, catSlug: p.cat_slug });
      }
    }
    for (const p of noImage) {
      if (!allNeedImage.has(p.id)) {
        allNeedImage.set(p.id, { productId: p.id, productName: p.name, collection: p.collection, catSlug: p.cat_slug });
      }
    }

    console.log(`  Products needing unique images: ${allNeedImage.size}`);

    // === Phase 3: CDN Probing ===
    console.log(`\n  Phase 3: Probing CDN...`);
    const needsList = [...allNeedImage.values()];
    let found = 0;

    for (let i = 0; i < needsList.length; i += 5) {
      const batch = needsList.slice(i, i + 5);
      await Promise.all(batch.map(async (item) => {
        const candidates = cdnCandidates(item.productName, item.collection, item.catSlug);
        for (const url of candidates.slice(0, 10)) {
          // Skip if this URL is already a shared image (don't create new sharing)
          if (primaryByUrl.has(url) && primaryByUrl.get(url).length > 0) continue;

          const exists = await probeUrl(url);
          if (exists) {
            replacements.set(item.productId, { url, currentMediaId: item.currentMediaId });
            found++;
            break;
          }
        }
      }));

      if ((i + batch.length) % 100 === 0 || i + batch.length >= needsList.length) {
        process.stdout.write(`\r    Progress: ${Math.min(i + batch.length, needsList.length)}/${needsList.length} (${found} found)`);
      }
    }
    console.log(`\n    Unique CDN images found: ${found}`);

    // === Phase 4: Sibling sharing for remaining ===
    console.log(`\n  Phase 4: Collection sibling sharing...`);

    // Build collection → products with good images
    const collectionImages = new Map();
    for (const p of products) {
      if (!p.collection) continue;
      const media = mediaByProduct.get(p.id) || [];
      const primary = media.find(m => m.asset_type === 'primary' && !deleteIds.has(m.id));
      if (primary && !replacements.has(p.id)) {
        if (!collectionImages.has(p.collection)) collectionImages.set(p.collection, []);
        collectionImages.get(p.collection).push({ productId: p.id, url: primary.url, name: p.name });
      }
    }

    let siblingShared = 0;
    const siblingShares = new Map();
    for (const item of needsList) {
      if (replacements.has(item.productId)) continue; // Already has CDN replacement
      if (!item.collection) continue;

      const siblings = collectionImages.get(item.collection);
      if (!siblings) continue;

      // Find best matching sibling by name similarity
      let best = null, bestScore = 0;
      for (const sib of siblings) {
        if (sib.productId === item.productId) continue;
        const score = matchScore(sib.url, item.productName, item.collection);
        if (score > bestScore) { bestScore = score; best = sib; }
      }
      if (!best) best = siblings[0]; // Fall back to any sibling

      if (best && best.productId !== item.productId) {
        siblingShares.set(item.productId, { url: best.url, currentMediaId: item.currentMediaId });
        siblingShared++;
      }
    }

    console.log(`  Sibling shares: ${siblingShared}`);

    // === Summary ===
    const stillWithout = needsList.filter(n =>
      !replacements.has(n.productId) && !siblingShares.has(n.productId) && !n.currentMediaId
    ).length;

    // For shared images where we found no unique replacement, we keep the shared image
    const sharedKept = needsList.filter(n =>
      !replacements.has(n.productId) && !siblingShares.has(n.productId) && n.currentMediaId
    ).length;

    console.log(`\n  === Summary ===`);
    console.log(`  Delete wrong images: ${toDelete.length}`);
    console.log(`  Replace with unique CDN: ${replacements.size}`);
    console.log(`  Share from sibling: ${siblingShared}`);
    console.log(`  Keep shared (no replacement found): ${sharedKept}`);
    console.log(`  Still without any image: ${stillWithout}`);

    if (DRY_RUN) {
      console.log(`\n  --- Sample wrong images being removed ---`);
      for (const d of toDelete.slice(0, 15)) {
        const p = prodMap.get(d.productId);
        const short = d.url.replace('https://cdn.msisurfaces.com/images/', '');
        console.log(`    [${d.assetType}] "${p?.name}" ← ${short} (${d.reason})`);
      }
      if (toDelete.length > 15) console.log(`    ... and ${toDelete.length - 15} more`);

      console.log(`\n  --- Sample CDN replacements ---`);
      let cnt = 0;
      for (const [pid, r] of replacements) {
        if (cnt++ >= 10) break;
        const p = prodMap.get(pid);
        console.log(`    "${p?.name}" → ${r.url.replace(CDN_BASE + '/', '')}`);
      }

      console.log(`\n  --- Shared images breakdown ---`);
      const topShared = sharedUrls.sort((a, b) => b[1].length - a[1].length).slice(0, 10);
      for (const [url, entries] of topShared) {
        const short = url.replace('https://cdn.msisurfaces.com/images/', '').replace('/uploads/', 'uploads/');
        const resolved = entries.filter(e => replacements.has(e.productId) || siblingShares.has(e.productId)).length;
        console.log(`    [${entries.length} products, ${resolved} resolved] ${short}`);
      }

      console.log(`\n  DRY RUN — no changes made.\n`);
      return;
    }

    // === Execute ===
    await client.query('BEGIN');

    // 1. Delete wrong images
    if (toDelete.length > 0) {
      const ids = toDelete.map(d => d.mediaId);
      for (let i = 0; i < ids.length; i += 500) {
        await client.query('DELETE FROM media_assets WHERE id = ANY($1::uuid[])', [ids.slice(i, i + 500)]);
      }
    }
    console.log(`\n  Deleted ${toDelete.length} wrong images`);

    // 2. Insert CDN replacements
    for (const [pid, r] of replacements) {
      const { rows: existing } = await client.query(
        `SELECT id FROM media_assets WHERE product_id = $1 AND url = $2`, [pid, r.url]
      );
      if (existing.length > 0) {
        // URL already exists on product — just promote it to primary
        await client.query(
          `UPDATE media_assets SET asset_type = 'alternate' WHERE product_id = $1 AND asset_type = 'primary'`,
          [pid]
        );
        await client.query(
          `UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`,
          [existing[0].id]
        );
      } else {
        // Demote existing primary(s) individually to avoid sort_order collision
        const { rows: existingPrimaries } = await client.query(
          `SELECT id FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' ORDER BY sort_order`, [pid]
        );
        const { rows: [{ max_sort }] } = await client.query(
          `SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM media_assets WHERE product_id = $1`, [pid]
        );
        for (let j = 0; j < existingPrimaries.length; j++) {
          await client.query(
            `UPDATE media_assets SET asset_type = 'alternate', sort_order = $1 WHERE id = $2`,
            [max_sort + 1 + j, existingPrimaries[j].id]
          );
        }
        // Insert new unique image as primary
        await client.query(
          `INSERT INTO media_assets (product_id, url, asset_type, sort_order) VALUES ($1, $2, 'primary', 0)`,
          [pid, r.url]
        );
      }
    }
    console.log(`  Inserted ${replacements.size} unique CDN images`);

    // 3. Insert sibling shares for products with NO image at all
    for (const [pid, s] of siblingShares) {
      // Only add if this product has no primary left
      const { rows: hasPrimary } = await client.query(
        `SELECT id FROM media_assets WHERE product_id = $1 AND asset_type = 'primary' LIMIT 1`, [pid]
      );
      if (hasPrimary.length === 0) {
        const { rows: existing } = await client.query(
          `SELECT id FROM media_assets WHERE product_id = $1 AND url = $2`, [pid, s.url]
        );
        if (existing.length === 0) {
          // Find next available sort_order
          const { rows: [{ max_sort }] } = await client.query(
            `SELECT COALESCE(MAX(sort_order), -1) as max_sort FROM media_assets WHERE product_id = $1`, [pid]
          );
          await client.query(
            `INSERT INTO media_assets (product_id, url, asset_type, sort_order) VALUES ($1, $2, 'primary', $3)`,
            [pid, s.url, max_sort + 1]
          );
        }
      }
    }
    console.log(`  Shared ${siblingShared} sibling images`);

    // 4. Promote alternates for products that lost primary but have alternates
    const { rows: promotable } = await client.query(`
      WITH no_primary AS (
        SELECT DISTINCT ma.product_id
        FROM media_assets ma JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true
          AND NOT EXISTS (SELECT 1 FROM media_assets ma2 WHERE ma2.product_id = ma.product_id AND ma2.asset_type = 'primary')
      )
      SELECT DISTINCT ON (np.product_id) ma.id, np.product_id
      FROM no_primary np JOIN media_assets ma ON ma.product_id = np.product_id
      ORDER BY np.product_id, ma.sort_order
    `, [VENDOR_ID]);

    for (const row of promotable) {
      await client.query(`UPDATE media_assets SET asset_type = 'primary', sort_order = 0 WHERE id = $1`, [row.id]);
    }
    console.log(`  Promoted ${promotable.length} alternates to primary`);

    await client.query('COMMIT');
    console.log(`\n  Changes committed.`);

    // Final stats
    const { rows: [stats] } = await client.query(`
      SELECT COUNT(*) as total,
        COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id AND ma.asset_type = 'primary')) as has_primary,
        COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM media_assets ma WHERE ma.product_id = p.id)) as no_image
      FROM products p WHERE p.vendor_id = $1 AND p.is_active = true
    `, [VENDOR_ID]);

    const { rows: [{ shared_count }] } = await client.query(`
      WITH imgs AS (
        SELECT ma.url, ma.product_id FROM media_assets ma JOIN products p ON p.id = ma.product_id
        WHERE p.vendor_id = $1 AND p.is_active = true AND ma.asset_type = 'primary'
      )
      SELECT COUNT(DISTINCT i.product_id) as shared_count
      FROM imgs i JOIN (SELECT url FROM imgs GROUP BY url HAVING COUNT(DISTINCT product_id) > 1) s ON s.url = i.url
    `, [VENDOR_ID]);

    console.log(`\n  === Final State ===`);
    console.log(`  Total: ${stats.total}, Primary: ${stats.has_primary} (${(stats.has_primary/stats.total*100).toFixed(1)}%), No image: ${stats.no_image}, Sharing: ${shared_count}`);

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FATAL:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
