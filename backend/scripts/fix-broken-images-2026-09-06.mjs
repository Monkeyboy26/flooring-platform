#!/usr/bin/env node
/**
 * fix-broken-images-2026-09-06.mjs
 *
 * Fixes the ~103 open `broken-image` quality violations (2026-09-06 investigation).
 * Dry-run by default; pass --apply to execute. Idempotent: replaced rows no longer
 * match their old URL and deleted rows are gone, so re-runs are no-ops.
 *
 * Every action is re-verified live at run time:
 *   - REPLACE only happens if the new URL returns 2xx image/* bytes (>2KB).
 *   - DELETE only happens if the old URL is still broken (>=400 / network error);
 *     if a "dead" URL has come back to life the row is left alone (logged SKIP).
 *
 * ── Per-vendor diagnosis (verified 2026-09-06 with curl, browser UA) ──────────
 *
 * TW (Tri-West, 35 flagged)
 *   • 33 static.wixstatic.com/media/497d1e_*.jpg → 403 on every URL of that Wix
 *     media account (tested plain, browser UA, and Referer: tileworldint/wix —
 *     all 403 "Forbidden", 9 bytes). Other Wix accounts in our DB (e.g. a0c5fc_)
 *     still serve 200, so this is NOT hotlink protection we can defeat with a
 *     referer header — the 497d1e account's media is gone/blocked. DELETE all
 *     media rows on that account prefix (252 rows incl. unflagged siblings —
 *     flagged products keep 23-84 non-Wix images each).
 *   • 2 californiaclassicsfloors.com Timeless Classics swatches → site renamed
 *     color "Boulder" to code TCBO3040 (the product's own roll_/rooms_ rows
 *     already use tcbo3040): swatch_timelessclassicstcbo3040.jpg verified 200.
 *     "Coeur d'Alene" swatch_ file is gone but roll_timelessclassicscoeurdalene.jpg
 *     verified 200 → REPLACE.
 *
 * ELY (Elysium, 10)
 *   • 9 "timeout" URLs contain literal spaces / CJK characters; the same URLs
 *     percent-encoded (encodeURI) return 200 image bytes (6 of 9 spot-verified,
 *     rest verified at run time) → REPLACE with encoded form.
 *   • 1 genuine 404 (Lucy Mint 1000_2867-IMG_4732.jpg) → REPLACE with sibling
 *     shot 1000_2867-IMG_4606.jpg (verified 200). Sibling IMG_4637 is also dead
 *     (unflagged) → included in DELETE list.
 *
 * JH (Johnson Hardwood, 10)
 *   • All FM-182xx_..-e15833*.jpg 404 — site restructured. FM = "Farmhouse
 *     Manor"; the live series page https://johnsonhardwood.com/series/farmhouse-manor/
 *     serves FM-182xx_<Color>_DSC_0xxx_web.jpg for every flagged color
 *     (3 spot-verified 200, ~155KB jpeg each) → REPLACE all 10.
 *
 * AZT (Arizona Tile, 9)
 *   • arizonatile.widen.net content ids removed (404 + widen placeholder PNG).
 *     Paloma Pumice/Cloud/Cotton and Unica Desert keep verified-working sibling
 *     widen images → DELETE dead rows. Everest / Gobi / Glisten have NO working
 *     images left (their unflagged siblings Everest-DT2, Gobi-Limestone-DT,
 *     Glisten_Detail_1 are also 404 — added to DELETE); arizonatile.com has no
 *     product page for them (/product/<slug> 404, search 500) — likely
 *     discontinued; they go photoless. Consider deactivation review.
 *
 * 548 (Florenza, 8) — SKIP
 *   • http 520/525 = Cloudflare origin errors, intermittent: 4 of 5 probed URLs
 *     returned 200 during investigation (chianca still 525). Not a URL problem;
 *     re-audit will close these when the origin is healthy. Candidate for mirroring.
 *
 * ROCA (6)
 *   • URLs were stored HTML-entity-escaped: ".../dolce&amp;vita/..." → 404.
 *     With &amp;→& (and spaces %20-encoded) the same path returns 200 png
 *     (~1MB, verified) → REPLACE with decoded+encoded URL.
 *
 * BIGD (5)
 *   • 2 cdnmedia.mapei.com → 403 Incapsula bot-block even with browser UA +
 *     referer; our server-side image proxy can never fetch these. Both products
 *     already carry working Lowes bag images as alternates → REPLACE primary
 *     with a verified-200 Lowes image of the same product line.
 *   • 3 us.uzin.com _processed_ dummies → TYPO3 rotated the cache hash. Current
 *     product detail pages serve the same files under new hashes (all 3
 *     verified 200, 400-690KB png) → REPLACE.
 *
 * 807 (WPT, 5)
 *   • d2j6dbq0eux0bg.cloudfront.net (Ecwid CDN): bucket is alive (other WPT
 *     images 200) but the Moon White/Moon Grey/Copacabana Blue/Copacabana
 *     Wave/Cottage Bianco product folders are S3 AccessDenied = keys deleted
 *     (store is dealer-secured; products delisted). DELETE all 16 rows for the
 *     5 products (they go photoless). A re-harvest via the Ecwid storefront API
 *     (see wpt-attach-images.mjs / memory "WPT images via Ecwid storefront API")
 *     could restore them if the products are still carried.
 *
 * 599 (Cosentino, 3)
 *   • assetstools.cosentino.com bynder "tablahd/*-fullslab.jpg" renditions
 *     return 400/403 for SVB, SMW, L3 (control color DKL still 200) — those
 *     colors' fullslab renditions were removed (discontinued Sensa colors).
 *     The "detalle/*-thumb.jpg" rendition still returns 200 for all three
 *     (verified, 230-260KB jpeg) → REPLACE primary with the thumb URL.
 *
 * PC (Pentz, 3)
 *   • 7049PD_3143_1.jpg gone but sibling _2 shot of the same color verified 200
 *     → REPLACE. 3058B_2152_1 / 3059B_2152_1: color 2152 dropped entirely
 *     (_1/_2 404; other colors 200) → DELETE (sku goes photoless).
 *
 * SHAW (2)
 *   • widen M5440_00400.jpg content id dead (sibling M5440_00300 200) and no
 *     equivalent found for color 00400 (img.shawinc E0144_00400/MAIN also 404)
 *     → DELETE (product keeps 40+ working images).
 *   • img.shawinc VV012_00756/MAIN "timeout" → verified 200 now — transient → SKIP.
 *
 * STPR (2)
 *   • Tile-CW-6-Hexagon-Polished.JPG and MS-HO-2-P.jpg removed from
 *     stone-pride.com (case-variant .jpg also 404; sibling finishes/sizes 200)
 *     → DELETE (products keep 10+ working images).
 *
 * ADEX (2) — SKIP: both "timeout" URLs verified 200 now — transient slowness.
 *
 * MANN (1)
 *   • apx111-angle-nordic_oak-cabin.jpg 404 (encoded form too). Product keeps
 *     verified-working apx110 webp renditions + TransformedImages swatches
 *     → DELETE.
 *
 * BLZ (1)
 *   • Original Marquina Gold jpg removed but the -1024x614-1 resize (already an
 *     alternate on the product) verified 200 → REPLACE.
 *
 * EF (1)
 *   • Cloudinary 2935_2117_fv87ek.jpg 404; version-less variant also 404; no
 *     replacement discoverable without EF's API → DELETE (other colors of the
 *     product are mirrored locally).
 *
 * Code-change note (not handled here): a referer-header image proxy would NOT
 * help any of these — the Wix 403s are account-dead (referer tested), and Mapei
 * is an Incapsula JS challenge. The ELY fix suggests the broken-image checker
 * and any fetcher should encodeURI() URLs containing raw spaces before fetching.
 *
 * After running with --apply, re-run the quality audit scoped to broken-image
 * so fixed violations auto-close.
 */

import { pool } from '../db.js';

const APPLY = process.argv.includes('--apply');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function probe(url, { wantImage = false } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(encodeSpaces(url), {
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/png,image/*,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    if (!wantImage) return { ok: true, status: res.status };
    const ct = res.headers.get('content-type') || '';
    const buf = await res.arrayBuffer();
    const isImage = ct.startsWith('image/') && buf.byteLength > 2048;
    return { ok: isImage, status: res.status, ct, bytes: buf.byteLength };
  } catch (e) {
    return { ok: false, status: 0, err: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

// fetch() rejects URLs with raw spaces; probe the encoded form (what browsers send)
function encodeSpaces(u) {
  return u.includes(' ') ? encodeURI(u) : u;
}

// ELY URLs: literal spaces / CJK → percent-encoded (verified working form)
function encodedForm(u) {
  return encodeURI(u);
}

const counts = { replace: 0, delete: 0, skip: 0, rowsUpdated: 0, rowsDeleted: 0 };

function log(action, vendor, msg) {
  console.log(`[${action.padEnd(7)}] ${vendor.padEnd(4)} ${msg}`);
}

// ---------------------------------------------------------------------------
// 1. REPLACEMENTS — old url → verified new url (applies to every row sharing the url)
// ---------------------------------------------------------------------------

const R = (vendor, url, newUrl, note = '') => ({ vendor, url, newUrl, note });

const REPLACEMENTS = [
  // --- ROCA: stored with HTML entity &amp; (and raw spaces); decoded+encoded form verified 200
  ...[
    ['SUITE_VITA_BEIGE_30X90 Large.png'],
    ['SUITE_VITA_GRIS_30X90 Large.png'],
    ['VITA_BEIGE_60X60_01 Large.png'],
    ['DOLCE_BEIGE_120X120_01 Large.png'],
    ['DOLCE_GRIS_120X120_01 Large.png'],
    ['VITA_GRIS_60X60_03 Large.png'],
  ].map(([f]) =>
    R(
      'ROCA',
      `https://rocatileusa.com/uploads/2025/Roca Collections/dolce&amp;vita/${f}`,
      encodeURI(`https://rocatileusa.com/uploads/2025/Roca Collections/dolce&vita/${f}`),
      '&amp; entity bug'
    )
  ),

  // --- ELY: raw-space/CJK URLs → percent-encoded (same asset)
  ...[
    'https://elysiumtile.com/static/images/product/1000/1000_4963-26-03-18-07-58-12 QQ浏览器截图20260318225514.jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4962-26-03-18-07-57-52 QQ浏览器截图20260318225200.jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4605-24-10-10-02-55-27 769978_01.jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4993-26-02-13-10-15-19 REFIN_SEA LUSTER_AVORIO_12X24 (1).jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_5059-26-06-04-08-02-11 KRAKENLIGHT WHITE 60X120 (8).jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4549-jade 6 (3).jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4568-Arbia Ivory Grip 48x48.jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4553-BAB ARC MAT 12X24.jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_4990-26-02-05-10-11-15 766587_01.jpg',
  ].map((u) => R('ELY', u, encodedForm(u), 'percent-encode raw spaces')),
  // ELY genuine 404 → verified sibling shot of the same product (Lucy Mint)
  R(
    'ELY',
    'https://elysiumtile.com/static/images/product/1000/1000_2867-IMG_4732.jpg',
    'https://elysiumtile.com/static/images/product/1000/1000_2867-IMG_4606.jpg',
    'primary gone; sibling verified'
  ),

  // --- JH: Farmhouse Manor images now live as FM-182xx_<Color>_DSC_0xxx_web.jpg
  ...Object.entries({
    'FM-18202_Oxmoor-e1583357304294.jpg': 'FM-18202_Oxmoor_DSC_0576_web.jpg',
    'FM-18203_Glidden-e1583357398831.jpg': 'FM-18203_Glidden_DSC_0608_web.jpg',
    'FM-18204_NewHaven-e1583357446145.jpg': 'FM-18204_NewHaven_DSC_0588_web.jpg',
    'FM-18205_HighValley-e1583357728554.jpg': 'FM-18205_HighValley_DSC_0618_web.jpg',
    'FM-18206_Southwind-e1583357819670.jpg': 'FM-18206_Southwind_DSC_0628_web.jpg',
    'FM-18207_Nightfall-e1583357909860.jpg': 'FM-18207_Nightfall_DSC_0638_web.jpg',
    'FM-18208_Ironhill-e1583357989438.jpg': 'FM-18208_IronHill_DSC_0646_web.jpg',
    'FM-18209_Briarcliff-e1583358055879.jpg': 'FM-18209_Briarcliff_DSC_0655_web.jpg',
    'FM-18210_Ardenwood-e1583358117970.jpg': 'FM-18210_Ardenwood_DSC_0668_web.jpg',
    'FM-18211_Monticello-e1583358185410.jpg': 'FM-18211_Monticello_DSC_0681_web.jpg',
  }).map(([oldF, newF]) =>
    R(
      'JH',
      `https://johnsonhardwood.com/wp-content/uploads/2018/05/${oldF}`,
      `https://johnsonhardwood.com/wp-content/uploads/2018/05/${newF}`,
      'Farmhouse Manor site refresh'
    )
  ),

  // --- TW California Classics (Timeless Classics color renames)
  R(
    'TW',
    'https://californiaclassicsfloors.com/images/swatch_timelessclassicsboulder.jpg',
    'https://californiaclassicsfloors.com/images/swatch_timelessclassicstcbo3040.jpg',
    'Boulder renamed to code TCBO3040 (matches product roll_/rooms_ rows)'
  ),
  R(
    'TW',
    'https://californiaclassicsfloors.com/images/swatch_timelessclassicscoeurdalene.jpg',
    'https://californiaclassicsfloors.com/images/rollimage4/roll_timelessclassicscoeurdalene.jpg',
    'swatch file gone; roll shot of same color verified'
  ),

  // --- Cosentino (599): fullslab rendition removed for these colors; detalle thumb verified 200
  ...['SVB', 'SMW', 'L3'].map((c) =>
    R(
      '599',
      `https://assetstools.cosentino.com/api/v1/bynder/color/${c}/tablahd/${c}-fullslab.jpg?w=1600&q=80&auto=format`,
      `https://assetstools.cosentino.com/api/v1/bynder/color/${c}/detalle/${c}-thumb.jpg?w=900&q=80&auto=format`,
      'fullslab rendition removed; detail rendition verified'
    )
  ),

  // --- BIGD Mapei: cdnmedia.mapei.com Incapsula-blocked; same products' Lowes bag shots verified 200
  R(
    'BIGD',
    'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/39_3000009-keracolor-s-25lbs_9ab94fbac8064bcfa59cce742f141c06.png',
    'https://mobileimages.lowes.com/productimages/439a425c-8029-4602-bdea-c2eab71a8b79/70425423.jpeg',
    'Mapei CDN bot-blocked; Lowes Keracolor S bag (existing alternate on product)'
  ),
  R(
    'BIGD',
    'https://cdnmedia.mapei.com/images/librariesprovider10/products-images/4_3002813-keracolor-u-unsanded-grout-10lb_641b530fa5ea426e9d921413449b06ed.png',
    'https://mobileimages.lowes.com/productimages/27250b15-6f19-412b-b96e-8b7e70ac28a1/70425429.jpeg',
    'Mapei CDN bot-blocked; Lowes Keracolor U bag (existing alternate on product)'
  ),

  // --- BIGD UZIN: TYPO3 _processed_ cache hash rotated; new hashes from live product pages
  R(
    'BIGD',
    'https://us.uzin.com/fileadmin/_processed_/e/8/csm_UZIN_Dummy_KR_430-8kg_2025-07_6972aec005.png',
    'https://us.uzin.com/fileadmin/_processed_/e/8/csm_UZIN_Dummy_KR_430-8kg_2025-07_34474fff99.png',
    'hash rotation, verified on /detail/product/10844'
  ),
  R(
    'BIGD',
    'https://us.uzin.com/fileadmin/_processed_/5/8/csm_UZIN_Dummy_KE_2000_S-14kg_2024-09_0d52b4f932.png',
    'https://us.uzin.com/fileadmin/_processed_/5/8/csm_UZIN_Dummy_KE_2000_S-14kg_2024-09_a92a99b006.png',
    'hash rotation, verified on /detail/product/25636'
  ),
  R(
    'BIGD',
    'https://us.uzin.com/fileadmin/_processed_/4/8/csm_UZIN_Dummy_PE_360-composing_US_2024-12_7fc1da3351.png',
    'https://us.uzin.com/fileadmin/_processed_/4/8/csm_UZIN_Dummy_PE_360-composing_US_2024-12_ebb99ddc87.png',
    'hash rotation, verified on /detail/product/10840'
  ),

  // --- BLZ: original removed; existing -1024x614-1 resize verified 200
  R(
    'BLZ',
    'https://bellezzaceramica.com/wp-content/uploads/2022/01/Cerrad-z-dwiema-nagrodami-w-konkursie-A-Design-Award-Marquina-gold-plndesign-2.jpg',
    'https://bellezzaceramica.com/wp-content/uploads/2022/01/Cerrad-z-dwiema-nagrodami-w-konkursie-A-Design-Award-Marquina-gold-plndesign-2-1024x614-1.jpg',
    'resize variant of same shot verified'
  ),

  // --- PC: _1 shot of color 3143 removed; _2 shot of same color verified 200
  R(
    'PC',
    'https://www.pentzcommercial.com/wp-content/uploads/products/7049PD_3143_1.jpg',
    'https://www.pentzcommercial.com/wp-content/uploads/products/7049PD_3143_2.jpg',
    'same color, angle shot'
  ),
];

// ---------------------------------------------------------------------------
// 2. DELETIONS — vendor no longer hosts any equivalent (runtime re-verified dead)
// ---------------------------------------------------------------------------

const D = (vendor, url, note = '') => ({ vendor, url, note });

const DELETIONS = [
  // --- AZT: dead widen ids. Paloma/Unica products keep verified-working siblings.
  D('AZT', 'https://arizonatile.widen.net/content/tcmhwisrqp/jpeg/Paloma-Pumice-Rhomboid.jpeg?w=765&quality=80'),
  D('AZT', 'https://arizonatile.widen.net/content/royzlmfswq/jpeg/arizona-v1-1053521.jpg?w=765&quality=80'),
  D('AZT', 'https://arizonatile.widen.net/content/z42jmutvz1/jpeg/Paloma-Cloud-Rhomboid.jpeg?w=765&quality=80'),
  D('AZT', 'https://arizonatile.widen.net/content/kbmzo32gax/jpeg/AZT-14.jpeg?w=765&quality=80'),
  D('AZT', 'https://arizonatile.widen.net/content/judhr3xx85/jpeg/Paloma-Cotton-Rhomboid.jpeg?w=765&quality=80'),
  D('AZT', 'https://arizonatile.widen.net/content/06txbeh6tk/webp/Unica-Desert-24-x-48-variation.webp?w=765&quality=80'),
  // Everest / Gobi / Glisten: ALL images dead (flagged + unflagged siblings below);
  // no product page on arizonatile.com — products go photoless (likely discontinued).
  D('AZT', 'https://arizonatile.widen.net/content/1gybnjxfz3/jpeg/Everest1.jpeg?w=765&quality=80', 'product goes photoless'),
  D('AZT', 'https://arizonatile.widen.net/content/xd44is0erb/jpeg/Everest-DT2.jpeg?w=765&quality=80', 'unflagged dead sibling'),
  D('AZT', 'https://arizonatile.widen.net/content/rwxw6h6glz/jpeg/Gobi-Limestone.jpeg?w=765&quality=80', 'product goes photoless'),
  D('AZT', 'https://arizonatile.widen.net/content/fmz9vtxdd9/jpeg/Gobi-Limestone-DT.jpeg?w=765&quality=80', 'unflagged dead sibling'),
  D('AZT', 'https://arizonatile.widen.net/content/vxadwdqe0v/jpeg/Glisten_Detail_2.jpg?w=765&quality=80', 'product goes photoless'),
  D('AZT', 'https://arizonatile.widen.net/content/ocrd66sjht/jpeg/Glisten_Detail_1.jpg?w=765&quality=80', 'unflagged dead sibling'),

  // --- SHAW: widen id dead, no equivalent shot of color 00400 found
  D('SHAW', 'https://shawfloors.widen.net/content/itb7gvzoie/jpeg/M5440_00400.jpg?w=800&quality=80', 'product keeps 40+ images'),

  // --- STPR: files removed (case variants and siblings checked)
  D('STPR', 'https://www.stone-pride.com/wp-content/uploads/2018/01/Tile-CW-6-Hexagon-Polished.JPG'),
  D('STPR', 'https://www.stone-pride.com/wp-content/uploads/2017/05/MS-HO-2-P.jpg'),

  // --- PC: color 2152 dropped from Uplink lines (no _1/_2 shot survives)
  D('PC', 'https://www.pentzcommercial.com/wp-content/uploads/products/3058B_2152_1.jpg', 'color dropped; sku goes photoless'),
  D('PC', 'https://www.pentzcommercial.com/wp-content/uploads/products/3059B_2152_1.jpg', 'color dropped; sku goes photoless'),

  // --- EF: cloudinary asset gone, no replacement discoverable
  D('EF', 'https://res.cloudinary.com/engineeredfloors/image/upload/v1765468477/2935_2117_fv87ek.jpg'),

  // --- MANN: apx111 jpg set gone; product keeps working apx110 webp + swatches
  D('MANN', 'https://manningtonprod.pimcoreclient.com/Mannington/LVT/ADURA®MaxAPEX/Nordic Oak/apx111-angle-nordic_oak-cabin.jpg'),

  // --- ELY: unflagged dead sibling of Lucy Mint (primary replaced above)
  D('ELY', 'https://elysiumtile.com/static/images/product/1000/1000_2867-IMG_4637.jpg', 'unflagged dead sibling'),
];

// Pattern deletions: whole dead families, expanded to rows at run time and
// probed per distinct URL before deleting.
const PATTERN_DELETIONS = [
  {
    vendor: 'TW',
    note: 'dead Wix media account 497d1e (referer/UA tested; other Wix accounts fine)',
    sql: `SELECT DISTINCT url FROM media_assets WHERE url LIKE 'https://static.wixstatic.com/media/497d1e%'`,
  },
  {
    vendor: '807',
    note: 'Ecwid CDN product folders deleted (bucket alive; products delisted). Re-harvest via Ecwid storefront API possible.',
    sql: `SELECT DISTINCT url FROM media_assets
          WHERE url LIKE '%d2j6dbq0eux0bg.cloudfront.net%'
            AND product_id IN ('2fa7f258-5f73-4956-8488-4d3da7a58e14','620cf67d-dfd4-49b7-89dc-a1b4ab5fcd9c',
                               '39443831-2071-4b42-9794-98b581b0a76e','67c79123-9cc2-4953-8f43-e7ef74f35b15',
                               'df228ee6-909a-4cf4-921c-4bd90fbfa987')`,
  },
];

// ---------------------------------------------------------------------------
// 3. SKIPS — transient failures, no action (logged for the record)
// ---------------------------------------------------------------------------

const SKIPS = [
  { vendor: '548', reason: 'Cloudflare 520/525 origin flakiness — URLs intermittently 200 (verified); re-audit will close. Consider mirroring.', urls: [
    'https://florenzaceramic.com/wp-content/uploads/2025/01/Domino_DORATO.jpg',
    'https://florenzaceramic.com/wp-content/uploads/2025/01/Quarry-Grey-6x6-2.jpg',
    'https://florenzaceramic.com/wp-content/uploads/2025/02/At.-Duna-Blanco-Brillo.jpg',
    'https://florenzaceramic.com/wp-content/uploads/2026/05/chianca_ch_beige_-24x24-1.jpeg',
    'https://florenzaceramic.com/wp-content/uploads/2025/02/Italia-Terra-1a.jpg',
    'https://florenzaceramic.com/wp-content/uploads/2025/01/chestnut-Origin-rotated.jpg',
    'https://florenzaceramic.com/wp-content/uploads/2025/01/Durango-Greige.jpg',
    'https://florenzaceramic.com/wp-content/uploads/2025/01/IronSpot-Puritan-Grey-1.jpg',
  ]},
  { vendor: 'ADEX', reason: 'timeout was transient — both URLs verified 200 now', urls: [
    'https://adexusa.com/wp-content/uploads/2024/08/Field-Tile-en-tI4f9agjQfYeekZc.jpg',
    'https://adexusa.com/wp-content/uploads/2025/01/Field-Tile-Stripes-2-Lines-en-H82zXXGNoED0HXam.jpg',
  ]},
  { vendor: 'SHAW', reason: 'timeout was transient — verified 200 now', urls: [
    'https://img.shawinc.com/v1/VV012_00756/MAIN?w=800&h=800&fmt=webp&q=80',
  ]},
];

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`fix-broken-images-2026-09-06 — ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  // -- replacements
  for (const r of REPLACEMENTS) {
    const rows = await pool.query('SELECT id FROM media_assets WHERE url = $1', [r.url]);
    if (rows.rowCount === 0) {
      counts.skip++;
      log('SKIP', r.vendor, `no rows match (already fixed?) ${r.url}`);
      continue;
    }
    const check = await probe(r.newUrl, { wantImage: true });
    if (!check.ok) {
      counts.skip++;
      log('SKIP', r.vendor, `replacement failed verification (${check.status} ${check.err || check.ct || ''}) ${r.newUrl}`);
      continue;
    }
    counts.replace++;
    counts.rowsUpdated += rows.rowCount;
    log('REPLACE', r.vendor, `${rows.rowCount} row(s) ${r.url}\n            -> ${r.newUrl} [${check.status} ${check.ct} ${check.bytes}b]${r.note ? ` (${r.note})` : ''}`);
    if (APPLY) {
      await pool.query('UPDATE media_assets SET url = $1 WHERE url = $2', [r.newUrl, r.url]);
    }
  }

  // -- explicit deletions
  for (const d of DELETIONS) {
    await deleteByUrl(d.vendor, d.url, d.note);
  }

  // -- pattern deletions
  for (const p of PATTERN_DELETIONS) {
    const { rows } = await pool.query(p.sql);
    if (rows.length) log('INFO', p.vendor, `${rows.length} distinct URL(s) in pattern group — ${p.note}`);
    for (const { url } of rows) {
      await deleteByUrl(p.vendor, url, p.note);
    }
  }

  // -- skips
  for (const s of SKIPS) {
    for (const u of s.urls) {
      counts.skip++;
      log('SKIP', s.vendor, `${u} — ${s.reason}`);
    }
  }

  console.log(
    `\nSummary: ${counts.replace} replaced URL(s) (${counts.rowsUpdated} rows), ` +
      `${counts.delete} deleted URL(s) (${counts.rowsDeleted} rows), ${counts.skip} skipped.` +
      (APPLY ? '\nNext: re-run the quality audit (broken-image rule) so fixed violations auto-close.' : '')
  );
  await pool.end();
}

async function deleteByUrl(vendor, url, note) {
  const rows = await pool.query('SELECT id FROM media_assets WHERE url = $1', [url]);
  if (rows.rowCount === 0) {
    counts.skip++;
    log('SKIP', vendor, `no rows match (already deleted?) ${url}`);
    return;
  }
  // safety: only delete if the URL is still broken right now
  const check = await probe(url, { wantImage: true });
  if (check.ok) {
    counts.skip++;
    log('SKIP', vendor, `URL is alive again (${check.status}), leaving ${rows.rowCount} row(s): ${url}`);
    return;
  }
  counts.delete++;
  counts.rowsDeleted += rows.rowCount;
  log('DELETE', vendor, `${rows.rowCount} row(s) [dead: ${check.status || check.err}] ${url}${note ? ` (${note})` : ''}`);
  if (APPLY) {
    await pool.query('DELETE FROM media_assets WHERE url = $1', [url]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
