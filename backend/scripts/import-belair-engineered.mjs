// Onboard Bel Air Wood Flooring (Los Angeles) — the engineered hardwood side of
// their 8/28/2026 dealer price list (MVS.pdf): Madison, Exclusive, Everest,
// Elegant, Playa Grande, Summit Mountain 5"/6", Herringbone, UnFinished, plus
// the special-order engineered trim pieces.
//
// Source of truth for cost/packaging: the price list. Specs (plank dims, specie,
// wear layer) cross-checked against belairwoodfloor.com product pages, which also
// supply the product images (hotlinked, then self-hosted by the mirror pass) and
// the vendor's own item codes where the site publishes one.
//
// Pricing: cost from the list; retail = 1.70x cost, charm-rounded to a 9-ending
// with the standard $0.99-over-cost floor — the same math as base.js
// upsertPricing for a non-tile category (replicated here so the script has no
// scraper-stack imports).
//
// Idempotent: products upsert on (vendor_id, collection, name), skus on
// internal_sku; media is replaced per-SKU on each run.
//
//   node scripts/import-belair-engineered.mjs --dry-run
//   node scripts/import-belair-engineered.mjs [--no-mirror]
//
// Run inside the api container (uploads mount + db env):
//   docker exec flooring-api node scripts/import-belair-engineered.mjs

import { pool } from '../db.js';
import { mirrorMediaRow } from '../lib/imageMirror.js';

const DRY_RUN = process.argv.includes('--dry-run');
const NO_MIRROR = process.argv.includes('--no-mirror');

const VENDOR = {
  code: 'BAW',
  name: 'Bel Air Wood Flooring',
  website: 'https://www.belairwoodfloor.com',
  email: 'sales@belairwoodfloor.com',
  phone: '(213) 455-8972',
  address: '5505 S. Alameda St., Los Angeles, CA 90058',
  notes: 'Dealer price list 8/28/2026 (engineered wood onboarded; laminate/SPC/WPC/underlayment/glue/MDF moldings on the list but not imported). Engineered trim = special order, no returns, 10-15 business day lead.',
};

const CATEGORY_SLUG = 'engineered-hardwood';
const IMG = 'https://belairwoodfloor.com/wp-content/uploads';

// Collection-level spec/packaging/pricing from the price list; dims confirmed
// against the vendor's product pages. cost is $/sqft dealer cost.
const COLLECTIONS = [
  {
    collection: 'Madison', abbr: 'MAD', cost: 6.39,
    sfBox: 28.42, bxPallet: 44, wtBox: 50,
    thickness: '5/8"', wear: '4 mm', width: '9.5"', length: 'Random length up to 7\'',
    species: 'European White Oak', finish: 'UV Matte', texture: 'Wire Brushed, Hand-Scraped',
    blurb: 'A 5/8" engineered European white oak plank with a 4 mm wear layer and natural filler, wire brushed and hand-scraped. 9.5" wide boards in random lengths up to 7 feet.',
    colors: [
      { name: 'Brooklyn Oak', img: `${IMG}/2025/12/madison-collection-brooklyn-square.jpg` },
      { name: 'Hudson Oak', img: `${IMG}/2025/12/madison-collection-hudson.jpg` },
      { name: 'Kingston Oak', img: `${IMG}/2025/12/madison-collection-kingston-1.jpg` },
      { name: 'Nomad Oak', img: `${IMG}/2025/12/madison-collection-nomad-1.jpg` },
    ],
  },
  {
    collection: 'Exclusive', abbr: 'EXC', cost: 5.69,
    sfBox: 30.79, bxPallet: 52, wtBox: 50,
    thickness: '5/8"', wear: '4 mm', width: '10.2"', length: 'Random length up to 7\'',
    species: 'European Oak', finish: 'UV Matte', texture: 'Wire Brushed, Hand-Scraped',
    blurb: 'A 5/8" engineered European oak plank with a 4 mm wear layer and UV matte finish, wire brushed and hand-scraped. Extra-wide 10.2" boards in random lengths up to 7 feet.',
    colors: [
      { name: 'Copa Coast', img: `${IMG}/2019/11/exclusive-copacoast-natural-2026.jpg` },
      { name: 'Frostwood', vsku: 'EXCLFROST1', img: `${IMG}/2026/01/exclusive-collection-frostwood-2.jpg` },
      { name: 'Sahara', vsku: '8ESAHNAT', img: `${IMG}/2022/12/2026-exclusive-collection-sahara.jpg` },
      { name: 'Solar Wind', vsku: '8ESOLWIN', img: `${IMG}/2022/12/2026-exclusive-collection-solar-wind.jpg` },
    ],
  },
  {
    collection: 'Everest', abbr: 'EVR', cost: 4.69,
    sfBox: 31.09, bxPallet: 45, wtBox: 55,
    thickness: '9/16"', wear: '3 mm', width: '7.5"', length: 'Random length up to 6\'',
    species: 'European Oak', finish: 'UV Matte', texture: 'Wire Brushed, Hand-Scraped',
    blurb: 'A 9/16" engineered European oak plank with a 3 mm wear layer and UV matte finish, wire brushed and hand-scraped. 7.5" wide boards in random lengths up to 6 feet.',
    colors: [
      { name: 'Geneva', vsku: '8EVEGEVEVB2842', img: `${IMG}/2023/02/geneva-e1746602430421.jpeg` },
      { name: 'North Ridge', vsku: '8EVENORRID2842', img: `${IMG}/2023/02/north-ridge-e1746602381581.jpeg` },
      { name: 'Summit Point', vsku: '8EVESUMPOI2842', img: `${IMG}/2023/02/summit-point-e1746602412275.jpeg` },
    ],
  },
  {
    collection: 'Elegant', abbr: 'ELG', cost: 4.89,
    sfBox: 28.42, bxPallet: 45, wtBox: 48,
    thickness: '9/16"', wear: '3 mm', width: '9.5"', length: 'Random length up to 6\'',
    species: 'European Oak', finish: 'UV Matte', texture: 'Wire Brushed, Hand-Scraped',
    blurb: 'A 9/16" engineered European oak plank with a 3 mm wear layer and UV matte finish, wire brushed and hand-scraped. 9.5" wide boards in random lengths up to 6 feet.',
    colors: [
      { name: 'Copa Coast', vsku: '8EWHANCACU912', img: `${IMG}/2017/05/2026-elegant-collection-copa-coast-1.jpg` },
      { name: 'Frostwood', vsku: '8ELEFROSTO2842', img: `${IMG}/2022/03/2026-elegant-collection-frostwood.jpg` },
      { name: 'Glacier Stone', vsku: '8ELEGLACSO2842', img: `${IMG}/2022/03/2026-elegant-collection-glacier-stone.jpg` },
      { name: 'Sahara', vsku: '8EWHANSAHO', img: `${IMG}/2017/05/2026-elegant-collection-sahara.jpg` },
      { name: 'Solar Wind', vsku: '8ELESOLARO2842', img: `${IMG}/2022/03/2026-elegant-collection-solar-wind.jpg` },
      { name: 'Volcano Grey', vsku: '8ELEVOLGYO2842', img: `${IMG}/2019/04/2026-elegant-collection-volcano-grey.jpg` },
    ],
  },
  {
    collection: 'Playa Grande', abbr: 'PLY', cost: 4.29,
    sfBox: 31.09, bxPallet: 45, wtBox: 50,
    thickness: '9/16"', wear: '3 mm', width: '7.5"', length: 'Random length up to 6\'',
    species: 'European Oak', finish: 'UV Matte', texture: 'Wire Brushed, Hand-Scraped',
    blurb: 'A 9/16" engineered European oak plank with a 3 mm wear layer and UV matte finish, wire brushed and hand-scraped. 7.5" wide boards in random lengths up to 6 feet.',
    colors: [
      { name: 'Alaskan Summer', img: `${IMG}/2018/02/alaskan-summer-e1746602888605.jpeg` },
      { name: 'Casa Blanca', vsku: '8EWHANCABL', img: `${IMG}/2017/05/playa-grande-casa-blanca.jpg` },
      { name: 'Copa Coast', vsku: '8EPLYGRCCN3109', img: `${IMG}/2025/09/playa-grande-copa-coast.jpg` },
      { name: 'Malibu', vsku: '8EWHANMAWB', img: `${IMG}/2025/09/playa-grande-malibu.jpg` },
      { name: 'Northern Wind', img: `${IMG}/2018/02/northern-wind-e1746602868468.jpeg` },
      { name: 'Ocean Breeze', vsku: '8EWHANOCBRE', img: `${IMG}/2017/05/ocean-breeze-e1746602973665.jpeg` },
      { name: 'Sahara', vsku: '8EWHANSAWB', img: `${IMG}/2025/09/playa-grande-sahara.jpg` },
    ],
  },
  {
    collection: 'Summit Mountain', abbr: 'SM5', cost: 2.69,
    sfBox: 23.68, bxPallet: 76, wtBox: 55,
    thickness: '1/2"', wear: '3 mm', width: '5"', length: 'Random length',
    species: 'European Oak', finish: 'UV Lacquered', texture: 'Wire Brushed',
    blurb: 'A 1/2" engineered European oak plank with a 3 mm wear layer, wire brushed with a UV lacquered finish. 5" wide boards in random lengths.',
    colors: [
      { name: 'Ash Grey' }, // no image on the vendor site
      { name: 'Copa Coast', img: `${IMG}/2020/03/SummitMt-CopaCoast-web-Copy.jpg` }, // site reuses Flint's code here — mint ours
      { name: 'Flint', vsku: '8PSUMHOFT5', img: `${IMG}/2017/05/flint-scaled-e1746602248930.jpeg` },
      { name: 'Linen Beige', vsku: '8PSUMHOLINB', img: `${IMG}/2017/05/linen-biege-scaled-e1746602234581.jpeg` },
    ],
  },
  {
    collection: 'Summit Mountain', abbr: 'SM6', cost: 3.09,
    sfBox: 31.52, bxPallet: 27, wtBox: 55,
    thickness: '1/2"', wear: '3 mm', width: '6"', length: 'Random length',
    species: 'European Oak', finish: 'UV Lacquered', texture: 'Wire Brushed',
    blurb: 'A 1/2" engineered European oak plank with a 3 mm wear layer, wire brushed with a UV lacquered finish. 6" wide boards in random lengths.',
    colors: [
      { name: 'Volcano Grey', img: `${IMG}/2018/02/volcano-grey-31.52sf-e1752248469143.jpeg` },
    ],
  },
  {
    collection: 'Herringbone', abbr: 'HRB', cost: 5.19,
    sfBox: 7.33, bxPallet: 50, wtBox: 13.5,
    thickness: '9/16"', wear: '3 mm', width: '3.5"', length: '24"', size: '3.5x24',
    species: 'European White Oak', finish: 'UV Lacquered', texture: 'Wire Brushed',
    blurb: 'A 9/16" engineered European white oak herringbone plank (3.5" × 24") with a 3 mm sawn-cut veneer, wire brushed with an aluminum-oxide UV urethane finish.',
    colors: [
      { name: 'Copa Coast', vsku: '8EHBCOPC', img: `${IMG}/2020/11/Copa-Coast-Cut-1000.jpg` },
      { name: 'Frostwood', vsku: '8EWHANFRWO912', img: `${IMG}/2020/12/Frostwood-Cut-1000.jpg` },
      { name: 'Glacier Stone', vsku: '8EWHANGLST912', img: `${IMG}/2020/12/glacier-stone-e1746602589819.jpeg` },
      { name: 'Sahara', vsku: '8EHBSAHA', img: `${IMG}/2020/11/sahara-e1746602605583.jpeg` },
      { name: 'Solar Wind', vsku: '8EWHANSOWI912', img: `${IMG}/2020/12/solar-wind-scaled-e1746602566804.jpeg` },
      { name: 'Volcano Grey', vsku: '8EHBVOGY', img: `${IMG}/2020/11/Volcano-Grey-Cut-1000.jpg` },
    ],
  },
];

// Unfinished line: priced per sqft, no box packaging published on the list.
const UNFINISHED = {
  collection: 'Unfinished', name: 'European Oak', abbr: 'UNF',
  thickness: '9/16"', wear: '4 mm', species: 'European Oak',
  blurb: 'Unfinished 9/16" engineered European oak with a 4 mm wear layer, wire brushed and ready for on-site finishing. 6-foot boards (20% random length).',
  skus: [
    { variant: '7.5" × 6\'', code: 'UNF-75', width: '7.5"', cost: 4.49 },
    { variant: '9.5" × 6\'', code: 'UNF-95', width: '9.5"', cost: 4.89 },
  ],
};

// Engineered trim (special order: no refunds/returns/exchanges, 10-15 business
// day lead — kept in the description so reps quote it correctly).
const TRIMS = {
  collection: 'Trim & Moldings', name: 'Engineered Trim', abbr: 'TRM',
  blurb: 'Color-matched trim for Bel Air engineered hardwood. Special order: no refunds, returns, or exchanges; lead time 10-15 business days from payment.',
  skus: [
    { label: 'Quarter Round', code: 'QTR-ROUND', cost: 34.99 },
    { label: 'End Cap', code: 'END-CAP', cost: 59.99 },
    { label: 'Reducer', code: 'REDUCER', cost: 59.99 },
    { label: 'T-Molding', code: 'TMOLD', cost: 59.99 },
    { label: 'Flush Stair Nose', code: 'FLUSH-SN', cost: 89.99 },
  ],
};

const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const codeify = (s) => slugify(s).toUpperCase().replace(/-/g, '');

// Retail = 1.70x cost, charm-rounded to a 9-ending, floored at cost+$0.99 —
// mirrors base.js upsertPricing (nearestNine + covering floor) for the
// engineered-hardwood category.
function retailFor(cost) {
  const target = Math.max(cost * 1.70, cost + 0.99);
  const cents = Math.round(target * 100);
  let nine = Math.max(9, Math.floor((cents - 9) / 10) * 10 + 9) / 100;
  if (nine < cost + 0.99 - 1e-9) nine = Math.round((nine + 0.10) * 100) / 100;
  return nine;
}

async function attrId(slug) {
  const r = await pool.query('SELECT id FROM attributes WHERE slug = $1', [slug]);
  if (!r.rows.length) throw new Error(`missing attribute: ${slug}`);
  return r.rows[0].id;
}

async function upsertProduct(vendorId, categoryId, { name, collection, slug, desc }) {
  const r = await pool.query(`
    INSERT INTO products (vendor_id, name, collection, category_id, category_source,
                          status, is_active, slug, description_short, content_status)
    VALUES ($1,$2,$3,$4,'manual','active',true,$5,$6,'reviewed')
    ON CONFLICT (vendor_id, collection, name) DO UPDATE SET
      category_id = EXCLUDED.category_id,
      status = 'active', is_active = true,
      slug = COALESCE(products.slug, EXCLUDED.slug),
      description_short = EXCLUDED.description_short,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id`, [vendorId, name, collection, categoryId, slug, desc]);
  return r.rows[0].id;
}

async function upsertSku(productId, { vendorSku, internalSku, variantName, sellBy, variantType, accessoryLabel }) {
  const r = await pool.query(`
    INSERT INTO skus (product_id, vendor_sku, internal_sku, variant_name, sell_by, variant_type, accessory_label, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
    ON CONFLICT (internal_sku) DO UPDATE SET
      product_id = EXCLUDED.product_id, vendor_sku = EXCLUDED.vendor_sku,
      variant_name = EXCLUDED.variant_name, sell_by = EXCLUDED.sell_by,
      variant_type = EXCLUDED.variant_type, accessory_label = EXCLUDED.accessory_label,
      status = 'active', updated_at = CURRENT_TIMESTAMP
    RETURNING id`,
    [productId, vendorSku, internalSku, variantName, sellBy, variantType || null, accessoryLabel || null]);
  return r.rows[0].id;
}

async function upsertPricingRow(skuId, cost, basis) {
  const retail = retailFor(cost);
  await pool.query(`
    INSERT INTO pricing (sku_id, cost, retail_price, price_basis)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (sku_id) DO UPDATE SET
      cost = EXCLUDED.cost,
      retail_price = CASE WHEN pricing.retail_locked THEN GREATEST(pricing.retail_price, EXCLUDED.retail_price) ELSE EXCLUDED.retail_price END,
      price_basis = EXCLUDED.price_basis`,
    [skuId, cost, retail, basis]);
  return retail;
}

async function upsertPackaging(skuId, { sfBox, bxPallet, wtBox }) {
  await pool.query(`
    INSERT INTO packaging (sku_id, sqft_per_box, boxes_per_pallet, sqft_per_pallet, weight_per_box_lbs)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (sku_id) DO UPDATE SET
      sqft_per_box = EXCLUDED.sqft_per_box, boxes_per_pallet = EXCLUDED.boxes_per_pallet,
      sqft_per_pallet = EXCLUDED.sqft_per_pallet, weight_per_box_lbs = EXCLUDED.weight_per_box_lbs`,
    [skuId, sfBox, bxPallet, Math.round(sfBox * bxPallet * 100) / 100, wtBox]);
}

async function setAttrs(skuId, A, pairs) {
  for (const [aid, val] of pairs) {
    if (!val) continue;
    await pool.query(`
      INSERT INTO sku_attributes (sku_id, attribute_id, value) VALUES ($1,$2,$3)
      ON CONFLICT (sku_id, attribute_id) DO UPDATE SET value = EXCLUDED.value`,
      [skuId, aid, val]);
  }
}

async function replaceMedia(productId, skuId, urls, mediaRowsToMirror) {
  await pool.query('DELETE FROM media_assets WHERE sku_id = $1', [skuId]);
  for (let i = 0; i < urls.length; i++) {
    const r = await pool.query(`
      INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order)
      VALUES ($1,$2,$3,$4,$4,$5) RETURNING id, url, original_url`,
      [productId, skuId, i === 0 ? 'primary' : 'alternate', urls[i], i]);
    mediaRowsToMirror.push(r.rows[0]);
  }
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===\n' : '=== LIVE ===\n');

  let vendorId;
  if (DRY_RUN) {
    const v = await pool.query('SELECT id FROM vendors WHERE code = $1', [VENDOR.code]);
    vendorId = v.rows.length ? v.rows[0].id : '(new)';
    console.log(`vendor ${VENDOR.code} → ${vendorId}`);
  } else {
    const v = await pool.query(`
      INSERT INTO vendors (name, code, website, email, phone, address, notes, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name, website = EXCLUDED.website, email = EXCLUDED.email,
        phone = EXCLUDED.phone, address = EXCLUDED.address, notes = EXCLUDED.notes,
        is_active = true, updated_at = CURRENT_TIMESTAMP
      RETURNING id`,
      [VENDOR.name, VENDOR.code, VENDOR.website, VENDOR.email, VENDOR.phone, VENDOR.address, VENDOR.notes]);
    vendorId = v.rows[0].id;
  }

  const cat = await pool.query('SELECT id FROM categories WHERE slug = $1', [CATEGORY_SLUG]);
  if (!cat.rows.length) throw new Error(`${CATEGORY_SLUG} category not found`);
  const categoryId = cat.rows[0].id;

  const A = {
    color: await attrId('color'), brand: await attrId('brand'),
    species: await attrId('species'), thickness: await attrId('thickness'),
    wear_layer: await attrId('wear_layer'), plank_width: await attrId('plank_width'),
    plank_length: await attrId('plank_length'), finish: await attrId('finish'),
    surface_texture: await attrId('surface_texture'), size: await attrId('size'),
  };

  let nProd = 0, nSku = 0;
  const mediaRowsToMirror = [];
  const imageless = [];

  // ---- plank collections ----
  for (const c of COLLECTIONS) {
    for (const col of c.colors) {
      const internalSku = `BAW-${c.abbr}-${codeify(col.name)}`;
      const vendorSku = col.vsku || `${c.abbr}-${slugify(col.name).toUpperCase()}`;
      const slug = `bel-air-${slugify(c.collection)}-${slugify(col.name)}${c.abbr === 'SM6' ? '-6in' : ''}`;
      const retail = retailFor(c.cost);

      if (DRY_RUN) {
        console.log(`  ${internalSku.padEnd(22)} ${c.collection} ${col.name}  $${c.cost}→$${retail}/sf  ${c.width}  ${col.img ? 'img' : 'NO IMG'}`);
        nProd++; nSku++;
        if (!col.img) imageless.push(`${c.collection} ${col.name}`);
        continue;
      }

      const desc = `Bel Air ${c.collection} — ${col.name}. ${c.blurb}`;
      const productId = await upsertProduct(vendorId, categoryId, {
        name: col.name, collection: c.collection, slug, desc,
      });
      nProd++;

      const skuId = await upsertSku(productId, {
        vendorSku, internalSku, variantName: col.name, sellBy: 'box',
      });
      nSku++;

      await upsertPricingRow(skuId, c.cost, 'per_sqft');
      await upsertPackaging(skuId, c);
      await setAttrs(skuId, A, [
        [A.color, col.name], [A.brand, 'Bel Air'], [A.species, c.species],
        [A.thickness, c.thickness], [A.wear_layer, c.wear],
        [A.plank_width, c.width], [A.plank_length, c.length],
        [A.finish, c.finish], [A.surface_texture, c.texture],
        [A.size, c.size || null],
      ]);

      if (col.img) {
        await replaceMedia(productId, skuId, [col.img], mediaRowsToMirror);
      } else {
        imageless.push(`${c.collection} ${col.name}`);
      }
      console.log(`  ✓ ${internalSku.padEnd(22)} ${c.collection} ${col.name}  $${c.cost}→$${retail}/sf`);
    }
  }

  // ---- unfinished line (per-sqft, no box packaging on the list) ----
  if (!DRY_RUN) {
    const productId = await upsertProduct(vendorId, categoryId, {
      name: UNFINISHED.name, collection: UNFINISHED.collection,
      slug: `bel-air-unfinished-european-oak`,
      desc: `Bel Air Unfinished — ${UNFINISHED.name}. ${UNFINISHED.blurb}`,
    });
    nProd++;
    for (const s of UNFINISHED.skus) {
      const skuId = await upsertSku(productId, {
        vendorSku: s.code, internalSku: `BAW-${s.code}`, variantName: s.variant, sellBy: 'sqft',
      });
      nSku++;
      const retail = await upsertPricingRow(skuId, s.cost, 'per_sqft');
      await setAttrs(skuId, A, [
        [A.color, 'Unfinished'], [A.brand, 'Bel Air'], [A.species, UNFINISHED.species],
        [A.thickness, UNFINISHED.thickness], [A.wear_layer, UNFINISHED.wear],
        [A.plank_width, s.width], [A.plank_length, '6\''],
      ]);
      console.log(`  ✓ BAW-${s.code.padEnd(18)} Unfinished ${s.variant}  $${s.cost}→$${retail}/sf`);
    }
    imageless.push('Unfinished European Oak (both widths)');
  } else {
    for (const s of UNFINISHED.skus) {
      console.log(`  BAW-${s.code.padEnd(18)} Unfinished ${s.variant}  $${s.cost}→$${retailFor(s.cost)}/sf  NO IMG`);
      nSku++;
    }
    nProd++;
  }

  // ---- engineered trim (special order accessories) ----
  if (!DRY_RUN) {
    const productId = await upsertProduct(vendorId, categoryId, {
      name: TRIMS.name, collection: TRIMS.collection,
      slug: 'bel-air-engineered-trim',
      desc: `Bel Air ${TRIMS.name}. ${TRIMS.blurb}`,
    });
    nProd++;
    for (const t of TRIMS.skus) {
      const skuId = await upsertSku(productId, {
        vendorSku: t.code, internalSku: `BAW-TRM-${t.code}`, variantName: t.label,
        sellBy: 'unit', variantType: 'accessory', accessoryLabel: t.label,
      });
      nSku++;
      const retail = await upsertPricingRow(skuId, t.cost, 'per_unit');
      await setAttrs(skuId, A, [[A.brand, 'Bel Air']]);
      console.log(`  ✓ BAW-TRM-${t.code.padEnd(14)} ${t.label}  $${t.cost}→$${retail}/ea`);
    }
  } else {
    for (const t of TRIMS.skus) {
      console.log(`  BAW-TRM-${t.code.padEnd(14)} ${t.label}  $${t.cost}→$${retailFor(t.cost)}/ea`);
      nSku++;
    }
    nProd++;
  }

  console.log(`\nUpserted: ${nProd} products, ${nSku} skus`);
  if (imageless.length) console.log(`Imageless (no photo on vendor site): ${imageless.join('; ')}`);

  if (!DRY_RUN && !NO_MIRROR && mediaRowsToMirror.length) {
    console.log(`\nMirroring ${mediaRowsToMirror.length} images…`);
    let ok = 0, skip = 0;
    for (const row of mediaRowsToMirror) {
      try { (await mirrorMediaRow(pool, row)) ? ok++ : skip++; }
      catch { skip++; }
    }
    console.log(`  mirrored ${ok}, kept vendor url ${skip}`);
  }

  console.log('\n=== Bel Air engineered onboarding complete ===');
  await pool.end();
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
