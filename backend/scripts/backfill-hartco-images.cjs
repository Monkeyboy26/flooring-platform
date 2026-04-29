#!/usr/bin/env node
/**
 * Hartco / AHF — Image Backfill Script
 *
 * Probes hartco.com CDN for product swatch images matching our DB vendor_skus.
 * Strategy:
 *   1. Normalize vendor_sku: strip "AHF" prefix, remove hyphens, uppercase
 *   2. Try CDN URL: https://www.hartco.com/cdn/swatch/{normalizedSku}.jpg
 *   3. If CDN returns 200/206, use it
 *   4. Fallback: check static IMAGE_MAP (scraped URLs with _Color suffix)
 *   5. Insert matched URLs into media_assets as asset_type='primary'
 *
 * Usage:
 *   node backend/scripts/backfill-hartco-images.cjs [--dry-run]
 */

const https = require('https');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const DRY_RUN = process.argv.includes('--dry-run');
const CDN_BASE = 'https://www.hartco.com/cdn/swatch/';

// ---------------------------------------------------------------------------
// Static fallback map for SKUs where {SKU}.jpg doesn't work but
// {SKU}_{Color}.jpg or alternate filenames do (scraped from hartco.com)
// ---------------------------------------------------------------------------
const FALLBACK_MAP = {
  "ESB7H11W": "ESB7-H11W_SavorSummer.jpg",
  "ESB7H21W": "ESB7-H21W_Natural.jpg",
  "ESB7H31W": "ESB7-H31W_PastSunset.jpg",
  "ESB7H41W": "ESB7-H41W_EnvelopingHue.jpg",
  "ESB7H51W": "ESB7-H51W_BeachView.jpg",
  "EHPC65L62S": "EHPC65L62S_Natural.jpg",
  "EHPC65L72S": "EHPC65L72S_AmberSpirit.jpg",
  "EHPC65L54S": "EHPC65L54S_Pebble.jpg",
  "EHPC65L64S": "EHPC65L64S_Coffee.jpg",
  "EHPC65L92S": "EHPC65L92S_MountainSurround.jpg",
  "EAHTB75L401": "eahtb75l401_3b.png",
  "EAHTB75L403": "eahtb75l403_2a.png",
  "4510HCN": "4510hcn_2a.png",
  "EKDP63L06WEE": "EKDP63L06WEE_Natural.jpg",
  "EKDP63L26WEE": "EKDP63L26WEE_Saddle.jpg",
  "EKDP63L36WEE": "EKDP63L36WEE_CocoaBean.jpg",
  "EKDP63L46WEE": "EKDP63L46WEE_OceansideGray.jpg",
  "EKDP74L56WEE": "EKDP74L56WEE_MinimalWhite.jpg",
  "EKDP74L66WEE": "EKDP74L66WEE_WarmCoastal.jpg",
  "EKDP74L76WEE": "EKDP74L76WEE_DesignClassic.jpg",
  "EKDP74L86WEE": "EKDP74L86WEE_FallColored.jpg",
  "EKPH55L11W": "EKPH55L11W_QuietParadise.jpg",
  "EKPH55L13W": "EKPH55L13W_RichLandscape.jpg",
  "422210": "422210_2.png",
  "422230": "422230_3.png",
  "422250": "422250_3.png",
  "422260": "422260_3.png",
  "422270": "422270_3.png",
  "4210OGUEE": "4210OGUEE_Gunstock.jpg",
  "4210ONUEE": "4210ONUEE_Natural.jpg",
  "4210OSUEE": "4210OSUEE_Saddle.jpg",
  "4722OBK": "4722obk_3.png",
  "4722OFB": "4722ofb_2.png",
  "4722OGU": "4722ogu_3b.png",
  "4722ONU": "4722onu_3d.png",
  "4722OSA": "4722osa_3b.png",
  "4225OBK": "4225obk_3b.png",
  "4225OFB": "4225ofb_3.png",
  "4225OGU": "4225ogu_3b.png",
  "4225ONU": "4225onu_3b.png",
  "4225OSA": "4225osa_3c.png",
  "4225ODUEE": "4225ODUEE_DarkTruffle.jpg",
  "4225OMUEE": "4225OMUEE_DeeplyCozy.jpg",
  "5888": "5888_2.png",
  "5888CHST": "5888chst_4.png",
  "4211OMI": "4211OMI_MineralBrush.jpg",
  "4211ONI": "4211ONI_NaturalBrush.jpg",
  "4211OPI": "4211OPI_PearlBrush.jpg",
  "4211OSI": "4211OSI_SlateBrush.jpg",
  "4211OCI": "4211OCI_CoalBrush.jpg",
  // EKBH77/97 (Coastal Highway) and 1NS2M (Nod to Nature) removed — CDN returns 403
  "APK5230LG": "APK5230LG_MysticTaupe.jpg",
  "APK5260LG": "APK5260LG_ForestBrown.jpg",
  "APK5460LG": "APK5460LG_FadedChocolate.jpg",
  "EAK6000LG": "EAK6000LG_EveryonesTaupe.jpg",
  "EAK6010LG": "EAK6010LG_DoublePour.jpg",
  "EAK6020LG": "EAK6020LG_Country.jpg",
  "EAK6030LG": "EAK6030LG_BreezyBrown.jpg",
  "EAK6040LG": "EAK6040LG_WildBerry.jpg",
  "EAK6050LG": "EAK6050LG_DesertSand.jpg",
  "EAK6200LG": "EAK6200LG_GoldenTan.jpg",
  "EAK6210LG": "EAK6210LG_SunlitAutumn.jpg",
  "EAK6220LG": "EAK6220LG_SoftBrown.jpg",
  "EAK6230LG": "EAK6230LG_MorningCoffee.jpg",
  "EAK6240LG": "EAK6240LG_AutumnApple.jpg",
  "EAK6300LG": "EAK6300LG_Natural.jpg",
  "EAK6310LG": "EAK6310LG_Prairie.jpg",
  "EAK6320LG": "EAK6320LG_FarmHouseWhite.jpg",
  "EAK6330LG": "EAK6330LG_RollingFog.jpg",
  "EAK6340LG": "EAK6340LG_OceanGray.jpg",
  "EKSF73L01W": "EKSF73L01W_AspenShadow.jpg",
  "EKSF73L02W": "EKSF73L02W_OutdoorMist.jpg",
  "EKSF73L03W": "EKSF73L03W_WildHoney.jpg",
  "EKSF73L04W": "EKSF73L04W_TreasuredRustic.jpg",
  "EKSF73L05W": "EKSF73L05W_MapleSyrup.jpg",
  "EKSF73L06W": "EKSF73L06W_SoftBrown.jpg",
  "EKNW73L01W": "EKNW73L01W_UnderstatedTaupe.jpg",
  "EKNW73L02W": "EKNW73L02W_MustHaveTan.jpg",
  "EKNW73L03W": "EKNW73L03W_WinterPine.jpg",
  "EKNW73L04W": "EKNW73L04W_RainforestTrail.jpg",
  "EKAR74L01W": "EKAR74L01W_MistyCove.jpg",
  "EKAR74L02W": "EKAR74L02W_MoonlightDusk.jpg",
  "EKAR74L03W": "EKAR74L03W_WintryBreeze.jpg",
  "EKAR74L04W": "EKAR74L04W_WarmCaramel.jpg",
  "EKAR74L05W": "EKAR74L05W_GoldenHour.jpg",
  "EKAR74L06W": "EKAR74L06W_StoneMeadow.jpg",
  "EKDT73L01H": "EKDT73L01H_SavorSummer.jpg",
  "EKDT73L02H": "EKDT73L02H_BeachView.jpg",
  "EKDT73L03H": "EKDT73L03H_NeutralLinen.jpg",
  "EKDT73L04H": "EKDT73L04H_DriedPetal.jpg",
  "EKTB75L71W": "EKTB75L71W_Harvest.jpg",
  "EKTB75L72W": "EKTB75L72W_SunDrenched.jpg",
  "EKTB75L73W": "EKTB75L73W_WarmSunset.jpg",
  "EKTB75L74W": "EKTB75L74W_BarrelBrown.jpg",
  "EKTB75L75W": "EKTB75L75W_OceanBreeze.jpg",
  "EKTB75L76W": "EKTB75L76W_SeaBreezeWhite.jpg",
  "EKTB75L77W": "EKTB75L77W_RusticBrown.jpg",
  "EKTB77L31H": "EKTB77L31H_Woodside.jpg",
  "EKTB77L32H": "EKTB77L32H_Limed.jpg",
  "EKTB77L33H": "EKTB77L33H_WildFlower.jpg",
  "EKTB77L34H": "EKTB77L34H_BlossomBrown.jpg",
  "ESB7K20W": "ESB7-K20W_Natural.jpg",
  "ESB7K30W": "ESB7-K30W_TrulyTranquil.jpg",
  "ESB7K50W": "ESB7-K50W_EveningStar.jpg",
  "ESB7K60W": "ESB7-K60W_RelaxedRefinement.jpg",
  "EKEP70L01E": "EKEP70L01E_BeachGrass.jpg",
  "EKEP70L02E": "EKEP70L02E_NatureTime.jpg",
  "EKEP70L03E": "EKEP70L03E_WheatlandHills.jpg",
  "EKEP70L04E": "EKEP70L04E_FriendlyTrail.jpg",
  "EKEP70L05E": "EKEP70L05E_CalmestTaupe.jpg",
  "EKEP70L06E": "EKEP70L06E_SeaOat.jpg",
  "EKEP70L07E": "EKEP70L07E_CuratorGray.jpg",
  "EKEP70L08E": "EKEP70L08E_BreezyCloud.jpg",
  "EKEP70L09E": "EKEP70L09E_DreamsFly.jpg",
  "EKEP70L10E": "EKEP70L10E_AtlanticView.jpg",
  "RKEG60L01E": "RKEG60L01E.jpg",
  "RKEG60L02E": "RKEG60L02E.jpg",
  "RKEG60L03E": "RKEG60L03E.jpg",
  "RKEG60L04E": "RKEG60L04E.jpg",
  "RKEG60L05E": "RKEG60L05E.jpg",
  "RKEG60L06E": "RKEG60L06E.jpg",
  "RKEG60L07E": "RKEG60L07E.jpg",
  "RKEG60L08E": "RKEG60L08E.jpg",
  "RKEG60L09E": "RKEG60L09E.jpg",
  "RKEG60L10E": "RKEG60L10E.jpg",
  "SAS507": "sas507_3d.png",
  "SAS508": "sas508_2.png",
  "SAS509": "sas509_3c.png",
  "SAS510": "sas510_2c.png",
  "SAS523": "sas523_2a.png",
  "SAS524": "sas524_2a.png",
  "SAS525": "SAS525_1A.jpg",
  "SAS526": "SAS526.jpg",
  "SAS528": "SAS528.jpg",
  "SAS529": "SAS529.jpg",
  "APH5401": "aph5401.png",
  "APH5402": "aph5402_3a.png",
  "APH5403": "aph5403_2.png",
  "APH5405": "aph5405.png",
  "APH5406": "aph5406_3b.png",
  "APH3430LG": "APH3430LG_AttractiveStyle.jpg",
  "APH3440LG": "APH3440LG_OneWithNature.jpg",
  "APH3450LG": "APH3450LG_ValleyBlend.jpg",
  "SAS513": "sas513_2a.png",
  "SAS514": "sas514_2.png",
  "SAS515": "sas515_2c.png",
  "SAS516": "sas516_1c.png",
  "SAS517": "sas517_3.png",
  "APM5401": "apm5401_3a.png",
  "APM5403": "apm5403_2b.png",
  "APM5404": "apm5404_2.png",
  "APM3425LG": "APM3425LG_CountryNatural.jpg",
  "APM3435LG": "APM3435LG_BasicBrown.jpg",
  "APM3445LG": "APM3445LG_RichSable.jpg",
  "APM3455LG": "APM3455LG_WildTuffle.jpg",
  "APM5400": "apm5400_1a.png",
  "APM5408": "apm5408_2a.png",
  "APM5425LG": "APM5425LG_CountryNatural.jpg",
  "APM5435LG": "APM5435LG_BasicBrown.jpg",
  "APM5445LG": "APM5445LG_RichSable.jpg",
  "APM5455LG": "APM5455LG_WildTuffle.jpg",
  "SAS502": "sas502_1d.png",
  "SAS503": "sas503_2.png",
  "SAS505": "sas505_4c.png",
  "LFR0384OVL": "LFR0384OVL_AestheticVision.jpg",
  "LFR3384OVL": "LFR3384OVL_WarmerFall.jpg",
  "LFR4384EIR": "LFR4384EIR_ForestTrek.jpg",
  "LFR5384EIR": "LFR5384EIR_CenterpieceTaupe.jpg",
};

// ---------------------------------------------------------------------------
// Normalize a vendor SKU for matching
// ---------------------------------------------------------------------------
function normalize(sku) {
  if (!sku) return '';
  let s = sku.toUpperCase().replace(/-/g, '');
  if (s.startsWith('AHF')) s = s.slice(3);
  return s;
}

// ---------------------------------------------------------------------------
// Generate candidate SKU variants by stripping trailing suffixes
// 832 feed adds manufacturing suffixes (F=factory, WF=wire factory,
// SK=special, EN/EC/EW/E2=packaging variants, N=natural) that
// don't appear in hartco.com CDN filenames or the FALLBACK_MAP.
// ---------------------------------------------------------------------------
function skuVariants(norm) {
  const variants = [norm];
  // Strip 1-3 trailing alpha chars (e.g., WFI→WF→W→base, SK→S→base)
  for (let strip = 1; strip <= 3; strip++) {
    if (norm.length > strip + 4) {
      const trimmed = norm.slice(0, -strip);
      // Only add if the last char of trimmed is alphanumeric (not already bare)
      if (/[A-Z0-9]$/.test(trimmed) && !variants.includes(trimmed)) {
        variants.push(trimmed);
      }
    }
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Check if a CDN URL returns a real image (not placeholder)
// Uses GET with Range header since the CDN blocks HEAD requests
// ---------------------------------------------------------------------------
function checkCdn(url) {
  return new Promise(resolve => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
    }, res => {
      res.resume(); // drain
      if (res.statusCode === 302 || res.statusCode === 301) {
        const loc = res.headers.location || '';
        if (loc.includes('placeholder')) {
          resolve(false);
        } else {
          const fullUrl = loc.startsWith('http') ? loc : `https://www.hartco.com${loc}`;
          https.get(fullUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' },
          }, res2 => {
            res2.resume();
            resolve(res2.statusCode === 200 || res2.statusCode === 206);
          }).on('error', () => resolve(false));
        }
      } else {
        resolve(res.statusCode === 200 || res.statusCode === 206);
      }
    });
    req.on('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Hartco Image Backfill ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`Fallback map: ${Object.keys(FALLBACK_MAP).length} entries\n`);

  const result = await pool.query(`
    SELECT s.id as sku_id, s.vendor_sku, s.variant_name, s.internal_sku,
           p.id as product_id, p.collection, p.name as product_name
    FROM skus s
    JOIN products p ON p.id = s.product_id
    LEFT JOIN media_assets ma ON ma.sku_id = s.id AND ma.asset_type = 'primary'
    WHERE (p.collection LIKE 'Hartco%' OR p.collection LIKE 'AHF%')
      AND s.vendor_sku IS NOT NULL
      AND s.variant_type IS DISTINCT FROM 'accessory'
      AND ma.id IS NULL
    ORDER BY p.collection, s.variant_name
  `);

  console.log(`Found ${result.rows.length} Hartco floor SKUs without primary images\n`);

  let cdnHits = 0, fallbackHits = 0, missed = 0, inserted = 0;
  const missList = [];
  const CONCURRENCY = 8;

  for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
    const batch = result.rows.slice(i, i + CONCURRENCY);
    const checks = await Promise.all(batch.map(async row => {
      const norm = normalize(row.vendor_sku);
      const variants = skuVariants(norm);
      // Try each variant (exact first, then progressively shorter)
      for (const variant of variants) {
        // Strategy 1: Try {SKU}.jpg on CDN
        const cdnUrl = `${CDN_BASE}${variant}.jpg`;
        const cdnOk = await checkCdn(cdnUrl);
        if (cdnOk) return { row, url: cdnUrl, source: variant === norm ? 'cdn' : `cdn-trim(${variant})` };
        // Strategy 2: Fallback map
        const fallback = FALLBACK_MAP[variant];
        if (fallback) return { row, url: `${CDN_BASE}${fallback}`, source: variant === norm ? 'map' : `map-trim(${variant})` };
      }
      return { row, url: null, source: null };
    }));

    for (const { row, url, source } of checks) {
      if (url) {
        if (source === 'cdn') cdnHits++;
        else fallbackHits++;
        console.log(`  + [${source}] ${row.internal_sku} (${row.variant_name}) → ${url}`);
        if (!DRY_RUN) {
          await pool.query(`
            INSERT INTO media_assets (product_id, sku_id, asset_type, url, original_url, sort_order, source)
            VALUES ($1, $2, 'primary', $3, $3, 0, 'scraper')
            ON CONFLICT (product_id, sku_id, asset_type, sort_order) WHERE sku_id IS NOT NULL
            DO UPDATE SET url = $3, original_url = $3
          `, [row.product_id, row.sku_id, url]);
          inserted++;
        }
      } else {
        missed++;
        missList.push(row);
      }
    }
  }

  console.log(`\n--- Results ---`);
  console.log(`CDN hits:      ${cdnHits}`);
  console.log(`Fallback hits: ${fallbackHits}`);
  console.log(`Total matched: ${cdnHits + fallbackHits}`);
  console.log(`No match:      ${missed}`);
  if (!DRY_RUN) console.log(`Inserted:      ${inserted}`);
  if (missList.length > 0) {
    console.log(`\nSample unmatched (first 15):`);
    missList.slice(0, 15).forEach(row => {
      const norm = normalize(row.vendor_sku);
      console.log(`  ${row.vendor_sku} → ${norm} (${row.variant_name})`);
    });
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  pool.end();
  process.exit(1);
});
