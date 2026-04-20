import {
  upsertProduct, upsertSku, upsertPricing, upsertPackaging,
  upsertMediaAsset, upsertSkuAttribute,
  appendLog, addJobError
} from './base.js';

// ── API Endpoints ──
const BLOOMREACH_URL = 'https://core.dxpapi.com/api/v1/core/';
const BLOOMREACH_PARAMS = {
  account_id: '6674',
  auth_key: 'alc9wtv7de2jmwtq',
  domain_key: 'quick-step.com',
  url: 'us.quick-step.com',
  q: '*',
  rows: '100',
  start: '0',
  search_type: 'keyword',
  request_type: 'search',
  fl: 'pid,title,collection_name,product_line,variants,sku_color,sku_swatch_images,sku_thumb_images,room_scene,technology,feature,color_family,thumb_image,surface_texture,plank_width,plank_length,wear_layer,price,item_number',
};

const PIM_API_BASE = 'https://pimtocrestprodresidentialapi.azurewebsites.net/api';

// Laminate category UUID from seed data
const LAMINATE_CATEGORY_ID = '650e8400-e29b-41d4-a716-446655440090';

const MAX_ERRORS = 30;
const PIM_DELAY_MS = 200;

/**
 * Quick-Step website-first scraper.
 *
 * Data sources:
 *   1. Bloomreach API — catalog enumeration (16 collections, ~64 colors, room scenes)
 *   2. Mohawk PIM API — per-color specs, Scene7 images, descriptions, bullet points
 *   3. Existing 832 EDI data in DB — cost pricing (matched by color name)
 *
 * Flow:
 *   Bloomreach (1 call) → PIM API (~64 calls) → DB cost lookup → upsert all
 *
 * Creates NEW products/SKUs with internal_sku = "QS-{itemNumber}".
 * Old 832 flooring products (internal_sku = "TW-*") remain for accessories.
 */
export async function run(pool, job, source) {
  const vendor_id = source.vendor_id;
  let errorCount = 0;

  const stats = {
    productsCreated: 0, productsUpdated: 0,
    skusCreated: 0, skusUpdated: 0,
    imagesAdded: 0, attributesAdded: 0,
    pimHits: 0, pimMisses: 0,
    costMatched: 0,
  };

  async function logError(msg) {
    errorCount++;
    if (errorCount <= MAX_ERRORS) {
      try { await addJobError(pool, job.id, msg); } catch {}
    }
  }

  try {
    // ── Step 1: Fetch Bloomreach catalog ──
    await appendLog(pool, job.id, 'Step 1: Fetching Bloomreach catalog for Quick-Step...');

    const params = new URLSearchParams(BLOOMREACH_PARAMS);
    const brResp = await fetch(`${BLOOMREACH_URL}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    });

    if (!brResp.ok) {
      await appendLog(pool, job.id, `Bloomreach API returned ${brResp.status} — aborting`);
      return;
    }

    const brData = await brResp.json();
    const docs = brData?.response?.docs || [];
    await appendLog(pool, job.id, `Bloomreach returned ${docs.length} documents`);

    if (docs.length === 0) {
      await appendLog(pool, job.id, 'No documents from Bloomreach — aborting');
      return;
    }

    // Build: collectionName → { productLine, roomScene, colors[] }
    // Multiple Bloomreach docs can share the same collection name (e.g. "Studio" appears 6 times)
    const collections = new Map();
    const styleNumbers = new Set();

    for (const doc of docs) {
      const collName = doc.collection_name;
      const variants = doc.variants || [];
      if (!collName || variants.length === 0) continue;

      if (!collections.has(collName)) {
        collections.set(collName, {
          productLine: firstStr(doc.product_line) || collName,
          roomScene: doc.room_scene ? ensureHiRes(firstStr(doc.room_scene)) : null,
          features: toArr(doc.feature),
          technology: toArr(doc.technology),
          colors: [],
        });
      }

      const coll = collections.get(collName);

      for (const variant of variants) {
        const color = variant.sku_color;
        if (!color) continue;

        // Style number: try Bloomreach item_number (comes as array), then extract from swatch URL
        let styleNumber = firstStr(variant.item_number) || firstStr(variant.sku_item_number) || null;
        if (!styleNumber) {
          styleNumber = extractStyleFromSwatchUrl(variant.sku_swatch_images?.[0]);
        }

        const roomScene = firstStr(variant.room_scene) || doc.room_scene;

        coll.colors.push({
          styleNumber,
          color,
          swatchUrl: variant.sku_swatch_images?.[0] || variant.sku_thumb_images?.[0] || null,
          roomScene: roomScene ? ensureHiRes(firstStr(roomScene)) : null,
          features: toArr(variant.feature).length > 0 ? toArr(variant.feature) : coll.features,
          technology: toArr(variant.technology).length > 0 ? toArr(variant.technology) : coll.technology,
        });

        if (styleNumber) styleNumbers.add(styleNumber);
      }
    }

    const totalColors = Array.from(collections.values()).reduce((sum, c) => sum + c.colors.length, 0);
    await appendLog(pool, job.id,
      `Parsed ${collections.size} collections, ${totalColors} colors, ${styleNumbers.size} unique style numbers`);

    if (styleNumbers.size === 0) {
      await appendLog(pool, job.id,
        'WARNING: No style numbers found from Bloomreach. PIM API step will be skipped. ' +
        'Check if item_number field is available in Bloomreach variants.');
    }

    // ── Step 2: Fetch PIM API details per style number ──
    await appendLog(pool, job.id, `Step 2: Fetching PIM details for ${styleNumbers.size} style numbers...`);

    const pimData = new Map(); // styleNumber → PIM response item

    for (const sn of styleNumbers) {
      try {
        const resp = await fetch(
          `${PIM_API_BASE}/GetquickstepproductsByStyleNumber/${encodeURIComponent(sn)}`,
          {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(15000),
          }
        );

        if (resp.ok) {
          const items = await resp.json();
          if (Array.isArray(items) && items.length > 0) {
            pimData.set(sn, items[0]);
            stats.pimHits++;
          } else {
            stats.pimMisses++;
          }
        } else {
          stats.pimMisses++;
        }
      } catch (err) {
        await logError(`PIM fetch ${sn}: ${err.message}`);
        stats.pimMisses++;
      }

      await delay(PIM_DELAY_MS);
    }

    await appendLog(pool, job.id, `PIM API: ${stats.pimHits} hits, ${stats.pimMisses} misses`);

    // ── Step 3: Load existing 832 cost pricing from DB ──
    await appendLog(pool, job.id, 'Step 3: Loading 832 cost pricing...');

    const costResult = await pool.query(`
      SELECT s.variant_name, pr.cost, pr.retail_price, pr.price_basis
      FROM products p
      JOIN skus s ON s.product_id = p.id
      JOIN pricing pr ON pr.sku_id = s.id
      WHERE p.vendor_id = $1
        AND (p.collection LIKE 'Quickstep%' OR p.collection LIKE 'Quick-Step%')
        AND s.variant_type IS NULL
        AND pr.cost IS NOT NULL AND pr.cost > 0
        AND pr.price_basis = 'per_sqft'
    `, [vendor_id]);

    const costMap = new Map(); // colorNameLower → { cost, retailPrice }
    for (const row of costResult.rows) {
      if (row.variant_name) {
        costMap.set(row.variant_name.toLowerCase().trim(), {
          cost: parseFloat(row.cost),
          retailPrice: parseFloat(row.retail_price),
        });
      }
    }

    await appendLog(pool, job.id, `Found ${costMap.size} cost entries from 832 data`);

    // ── Step 4: Upsert products + SKUs ──
    await appendLog(pool, job.id, `Step 4: Upserting ${collections.size} products, ${totalColors} SKUs...`);

    for (const [collName, coll] of collections) {
      try {
        // Get description from first color with PIM data
        let descShort = null, descLong = null;
        for (const color of coll.colors) {
          const pim = color.styleNumber ? pimData.get(color.styleNumber) : null;
          if (pim?.Product_description) {
            descShort = pim.Product_description;
            const bullets = [pim.Bullet_description1, pim.Bullet_description2, pim.Bullet_description3]
              .filter(b => b && b.trim());
            if (bullets.length > 0) {
              descLong = '<ul>' + bullets.map(b => `<li>${b}</li>`).join('') + '</ul>';
            }
            break;
          }
        }

        // Upsert product (one per collection)
        const product = await upsertProduct(pool, {
          vendor_id,
          name: collName,
          collection: 'Quick-Step',
          category_id: LAMINATE_CATEGORY_ID,
          description_short: descShort,
          description_long: descLong,
        }, { jobId: job.id });

        if (product.is_new) {
          stats.productsCreated++;
          // Website-first products are ready to publish immediately
          await pool.query(`UPDATE products SET status = 'active' WHERE id = $1`, [product.id]);
        } else {
          stats.productsUpdated++;
        }

        const productId = product.id;

        // NOTE: No product-level lifestyle image — each SKU gets its own room scene
        // to avoid a single color's room scene bleeding into every color's gallery

        // Upsert each color as a SKU
        for (const color of coll.colors) {
          try {
            const pim = color.styleNumber ? pimData.get(color.styleNumber) : null;
            const itemNumber = pim?.Item_number || color.styleNumber;

            if (!itemNumber) {
              await logError(`No item number for ${collName} / ${color.color} — skipping`);
              continue;
            }

            const internalSku = `QS-${itemNumber}`;

            // Upsert SKU
            const sku = await upsertSku(pool, {
              product_id: productId,
              vendor_sku: itemNumber,
              internal_sku: internalSku,
              variant_name: color.color,
              sell_by: 'sqft',
            }, { jobId: job.id });

            if (sku.is_new) stats.skusCreated++;
            else stats.skusUpdated++;

            const skuId = sku.id;

            // ── Pricing (cost + retail from 832 match) ──
            const costEntry = costMap.get(color.color.toLowerCase().trim());
            if (costEntry) {
              await upsertPricing(pool, skuId, {
                cost: costEntry.cost,
                retail_price: costEntry.retailPrice,
                price_basis: 'per_sqft',
              }, { jobId: job.id });
              stats.costMatched++;
            }

            // ── Packaging (from PIM API) ──
            if (pim) {
              const sqft = pim.Sq_ft_per_carton ? parseFloat(pim.Sq_ft_per_carton) : null;
              const pieces = pim.Pieces ? parseInt(pim.Pieces) : null;
              if (sqft || pieces) {
                await upsertPackaging(pool, skuId, {
                  sqft_per_box: sqft,
                  pieces_per_box: pieces,
                }, { jobId: job.id });
              }
            }

            // ── Images (SKU-level) ──
            let sortOrder = 0;

            // Primary: PIM swatch image (Scene7 hi-res), fallback to Bloomreach swatch
            const swatchUrl = pim?.swatch_image
              ? ensureHiRes(pim.swatch_image)
              : (color.swatchUrl ? ensureHiRes(color.swatchUrl) : null);

            if (swatchUrl) {
              await upsertMediaAsset(pool, {
                product_id: productId, sku_id: skuId,
                asset_type: 'primary',
                url: swatchUrl, original_url: swatchUrl,
                sort_order: sortOrder++,
              });
              stats.imagesAdded++;
            }

            // Alternate: PIM secondary images
            if (pim?.Secondary_Images) {
              const secondaries = (Array.isArray(pim.Secondary_Images)
                ? pim.Secondary_Images : [pim.Secondary_Images])
                .filter(u => u && u.trim());
              for (const secUrl of secondaries) {
                const hiRes = ensureHiRes(secUrl);
                await upsertMediaAsset(pool, {
                  product_id: productId, sku_id: skuId,
                  asset_type: 'alternate',
                  url: hiRes, original_url: hiRes,
                  sort_order: sortOrder++,
                });
                stats.imagesAdded++;
              }
            }

            // Lifestyle: per-color room scene (always at SKU level, even if same as collection)
            const roomSceneUrl = color.roomScene || coll.roomScene;
            if (roomSceneUrl) {
              await upsertMediaAsset(pool, {
                product_id: productId, sku_id: skuId,
                asset_type: 'lifestyle',
                url: roomSceneUrl, original_url: roomSceneUrl,
                sort_order: sortOrder++,
              });
              stats.imagesAdded++;
            }

            // ── Attributes (from PIM API) ──
            if (pim) {
              const attrs = {
                wear_layer: pim.Wear_layer,
                ac_rating: pim.Ac_rating,
                surface_texture: pim.Surface_texture,
                edge_treatment: pim.Edge_treatment,
                species: pim.Species,
                plank_width: stripQuotes(pim.Plank_width),
                plank_length: stripQuotes(pim.Plank_length),
                composition: pim.Composition,
                install_method: pim.Install_method,
                color_family: pim.Color_family,
              };

              for (const [slug, val] of Object.entries(attrs)) {
                if (val && val.trim()) {
                  await upsertSkuAttribute(pool, skuId, slug, val);
                  stats.attributesAdded++;
                }
              }
            }

            // Attributes (features, technology from PIM or Bloomreach fallback)
            const features = pim?.Feature
              ? pim.Feature.filter(f => f && f.trim())
              : color.features;
            const tech = pim?.Technology
              ? pim.Technology.filter(t => t && t.trim())
              : color.technology;

            if (features.length > 0) {
              await upsertSkuAttribute(pool, skuId, 'features', features.join(', '));
              stats.attributesAdded++;
            }
            if (tech.length > 0) {
              await upsertSkuAttribute(pool, skuId, 'technology', tech.join(', '));
              stats.attributesAdded++;
            }

            // Product line from Bloomreach
            await upsertSkuAttribute(pool, skuId, 'product_line', coll.productLine);
            stats.attributesAdded++;

          } catch (err) {
            await logError(`SKU ${collName}/${color.color}: ${err.message}`);
          }
        }
      } catch (err) {
        await logError(`Product ${collName}: ${err.message}`);
      }
    }

    // ── Summary ──
    await appendLog(pool, job.id,
      `Complete. Products: ${stats.productsCreated} new + ${stats.productsUpdated} updated. ` +
      `SKUs: ${stats.skusCreated} new + ${stats.skusUpdated} updated. ` +
      `Images: ${stats.imagesAdded}. Attrs: ${stats.attributesAdded}. ` +
      `Cost matched: ${stats.costMatched}/${totalColors}. ` +
      `PIM: ${stats.pimHits}/${stats.pimHits + stats.pimMisses}. ` +
      `Errors: ${errorCount}`,
      {
        products_found: collections.size,
        products_created: stats.productsCreated,
        products_updated: stats.productsUpdated,
        skus_created: stats.skusCreated,
      }
    );

  } catch (err) {
    await appendLog(pool, job.id, `Fatal error: ${err.message}`);
    throw err;
  }
}

// ── Helpers ──

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Extract first string from array-or-scalar field */
function firstStr(v) {
  return Array.isArray(v) ? (v[0] || null) : (v || null);
}

/** Convert field to non-empty string array, filtering out blanks */
function toArr(v) {
  return Array.isArray(v)
    ? v.filter(x => x && String(x).trim())
    : (v && String(v).trim() ? [v] : []);
}

/** Ensure Scene7 image URL returns high-res by appending ?wid=1200 */
function ensureHiRes(url) {
  if (!url) return url;
  if (url.includes('scene7.com')) {
    return `${url.split('?')[0]}?wid=1200`;
  }
  return url;
}

/** Strip quote/inch marks from dimension strings: '9.45"' → '9.45' */
function stripQuotes(val) {
  if (!val) return null;
  return val.replace(/["″'']/g, '').trim() || null;
}

/**
 * Extract style number from a Scene7 swatch URL.
 * "https://s7d4.scene7.com/is/image/MohawkResidential/36098_QS400_swatch" → "QS400"
 */
function extractStyleFromSwatchUrl(url) {
  if (!url) return null;
  const filename = url.split('/').pop()?.split('?')[0] || '';
  const match = filename.match(/^\d+_(.+?)_(?:swatch|thumb)/);
  return match ? match[1] : null;
}
