import { appendLog, addJobError } from './base.js';

/**
 * Bellezza Ceramica inventory scraper.
 *
 * Their live warehouse stock lives on a password-protected WordPress page
 * (PPWP plugin — "Password Protect WordPress"):
 *
 *   https://bellezzaceramica.com/stock-check/     password: bellezza1234
 *
 * Flow: GET the page (renders a PPWP password form) → POST the password to
 * `?action=ppw_postpass` (sets a `ppwp_*` cookie) → GET the page again with the
 * cookie → an HTML <table> of  Item | Description | Qty On Hand | Qty On Sales Order.
 *
 * The item names are the vendor's free-text ERP labels (e.g. "ALTEA ASH BLUE 4X4",
 * "GCGSL-8657", "EMPORIO CALACATTA MATTE 12X24"), so we match them to our SKUs by
 * an alias table + attribute agreement (finish/size/color/format). Matching is
 * deliberately CONSERVATIVE: a stock row that can't be resolved to exactly one SKU
 * is skipped (the storefront shows "unknown" — better than wrong stock). Multiple
 * rows that legitimately map to one SKU (e.g. Docks R10 + R11) are summed.
 *
 * "Quantity On Hand" is in PIECES. We convert to BOXES for storage because the
 * storefront computes sqft as qty_on_hand * sqft_per_box (i.e. treats qty_on_hand
 * as boxes, same convention as the Roca scraper). Sheet/accessory SKUs (no
 * pieces_per_box) store the piece count directly. Negatives (oversold) clamp to 0.
 *
 * Config (vendor_sources.config): { "password": "...", "freshnessHours": 48 }
 *
 * Runner: docker compose exec api node run-scraper.cjs bellezza-inventory
 */

const BASE = 'https://bellezzaceramica.com';
const STOCK_PATH = '/stock-check/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────────────────────────────────────
// Matching tables (validated against the Sept 2026 stock sheet)
// ─────────────────────────────────────────────────────────────────────────────

// Stock-item leading phrase → our product name. Longest match wins.
const ALIAS = {
  'Altea': ['ALTEA'], 'Amazonia': ['AMAZONIA'], 'Angelo Silk Shimmer': ['ANGELO SILK'],
  'Arena Chiaro': ['ARENA CHIARO'], 'Bolonia Marengo': ['BOLONIA MARENGO'], 'Calaca Gold': ['CALACA'],
  'Calacatta Brick Gloss': ['CALACATTA BRICK'], 'Calacatta Gloss': ['CALACATTA GLOSS'],
  'Calacatta Hex Gloss': ['CALACATTA HEX'], 'Calacatta Natural': ['CALACATTA NATURAL', 'CALACATTA NAT'],
  'Calcutta Gold': ['CALCUTTA GOLD'], 'Clarke': ['CLARKE'], 'Concretus': ['CONCRETUS'], 'Connor Beige': ['CONNOR'],
  'Docks': ['DOCKS'], 'Dolomite': ['DOLOMITE'], 'Dozza Stone Cream': ['DOZZA'],
  'Emporio Calacatta': ['EMPORIO CALACATTA', 'EMP.CALACATTA', 'EMP CALACATTA'], 'Epoque': ['EPOQUE'],
  'Golden Blanco': ['GOLDEN BLANCO'], 'Granby Beige': ['GRANBY BEIGE'], 'Granby Ivory': ['GRANBY IVORY'],
  'Grunge': ['GRUNGE'], 'Hex XL Coimbra': ['HEX XL COIMBRA'], 'Hex XL Fosco': ['HEX XL FOSCO'],
  'Hex XL Inverno Grey': ['HEX XL INVERNO'], 'Irta': ['IRTA'], 'Kadence': ['KADENCE'], 'Kyoto White': ['KYOTO'],
  'Leccese Cesellata': ['LECCESE CESELLATA', 'LECCESE CESELTTA'], 'Limasol': ['LIMASOL'],
  'Lingot': ['DECO LINGOT', 'LINGOT'], 'LN520 Stacked Linear': ['LN520'], 'Milano Crema': ['MILANO CREMA'],
  'Milano Mosaic': ['MILANO GOLD', 'MILANO SILVER'], 'Mixit Concept': ['MIXIT CONCEPT'],
  'Modern Concrete Ivory': ['MODERN CONCRETE'], 'Montblanc Gold': ['MONTBLANC'], 'Naples White': ['NAPLES WHITE'],
  'Odissey Saphire': ['ODISSEY'], 'Palatino': ['PALATINO'], 'Panda': ['PANDA'], 'Pearl Onyx': ['PEARL ONYX'],
  'Puccini': ['PUCCINI'], 'Scale Decor 3D': ['SCALE SAPHIRE', 'SCALE IVORY'], 'Scanda White': ['SCANDA'],
  'Sekos White': ['SEKOS'], 'Sierra': ['SIERRA'], 'Spatula': ['SPATULA'], 'Statuario Nice': ['STATUARIO NICE'],
  'Statuario Spider': ['SPIDER '], 'Staturio Blue': ['STATUARIO BLUE'], 'Terra Bianco': ['TERRA BIANCO'],
  'Vibrant Bianco': ['VIBRANT'], 'Vilema': ['VILEMA'], 'Volga': ['VOLGA'], 'Ziro': ['ZIRO'],
  'Acoustic MDF Sound Absorption Panel': ['MDF ', 'FLUTED FLEX MDF'],
  'Black Marble Mosaic': ['BLACK MARBLE'], 'Chateau Mosaic': ['CHATEAU'],
  'Nero Marquina Matte Hexagon': ['NERO MARQUINA'], 'Statuario Matte Hex': ['STATUARIO MATTE HEX'],
  'Silver Matte Hex': ['SILVER MATTE HEX'],
};

const COLORS = ['ASH BLUE', 'THISTLE BLUE', 'PINE GREEN', 'DUSTY PINK', 'JET BLACK', 'DARK COFFEE', 'COFFEE BROWN',
  'DARK GRAY', 'DARK GREY', 'LIGHT WALNUT', 'DARK WALNUT', 'BLACK', 'WHITE', 'GREY', 'GRAY', 'COBALT', 'TAUPE',
  'GOLD', 'SILVER', 'BEIGE', 'IVORY', 'BLANCO', 'MARFIL', 'PERLA', 'PEARLA', 'GRIS', 'GRAFITO', 'FUMO', 'FOSSILE',
  'SAND', 'SAPHIRE', 'SAPPHIRE', 'AERTIC', 'CARBON', 'CHALK', 'CREMA', 'CREAM', 'MATCHA', 'ROSEWOOD', 'SMOKE',
  'CORAL', 'AQUA', 'MINT', 'BLUE', 'MOCCA', 'BONE', 'OAK', 'ROBLE', 'WALNUT', 'GREEN', 'MULTI', 'NERO', 'MARENGO',
  'SABBIA', 'DENIM', 'MOON', 'DARK', 'LIGHT', 'PINE'].sort((a, b) => b.length - a.length);

const FIN = { MATTE: 'matte', POLISHED: 'polished', POLISH: 'polished', GLOSSY: 'glossy', GLOSS: 'glossy', SATIN: 'satin', LAPATTO: 'lapatto', RLV: 'relief' };

// Canonicalize vendor spelling variants so a stock label and our color attr collapse
// to the same token (e.g. sheet "ARTIC"/"SAPHIRE" vs our "Aertic"/"Sapphire").
const COLOR_SYNONYM = { ARTIC: 'AERTIC', SAPHIRE: 'SAPPHIRE', GRAY: 'GREY', PEARLA: 'PERLA', CREAM: 'CREMA' };

function colorsIn(text) {
  const t = ' ' + (text || '').toUpperCase().replace(/\bARTIC\b/g, 'AERTIC').replace(/\bSAPHIRE\b/g, 'SAPPHIRE') + ' ';
  const found = [];
  for (const c of COLORS) {
    if (new RegExp('(?<![A-Z])' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Z])').test(t)) {
      if (!found.some(f => f !== c && f.includes(c))) found.push(c);
    }
  }
  return new Set(found.filter(c => !found.some(o => o !== c && o.includes(c))).map(c => COLOR_SYNONYM[c] || c));
}
function finishOf(text) {
  const u = (text || '').toUpperCase();
  for (const [w, f] of Object.entries(FIN)) if (new RegExp('\\b' + w).test(u)) return f;
  return null;
}
function sizeOf(text) {
  const m = /([\d.]+)\s*[xX]\s*([\d.]+)/.exec(text || '');
  if (!m) return null;
  return [Math.round(+m[1]), Math.round(+m[2])].sort((a, b) => a - b);
}
function fmtOf(text) {
  const u = (text || '').toUpperCase();
  if (/JOLLY|TRIM/.test(u)) return 'trim';
  if (/MOSAIC|MOSAI|MESH|PENNY|HEXAGON|\bHEX\b|STACKED|LINEAR|BRICK/.test(u)) return 'mosaic';
  return 'field';
}
function sizesMatch(a, b) {
  if (!a || !b) return null;
  const tol = Math.max(a[0], a[1], b[0], b[1]) < 10 ? 0 : 1;
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
}
const inter = (a, b) => [...a].some(x => b.has(x));

// ── Gio product-code decoder: G{color}{finish}{format}-{sizecode} ──
const GIO_RE = /^G([BWGCT])([MG])(H|SL)-?(\d+)/;
const GIO_COLOR = { B: 'Black', W: 'White', G: 'Grey', C: 'Cobalt', T: 'Taupe' };
const GIO_FIN = { M: 'matte', G: 'glossy' };
const GIO_SLSZ = { '8657': '.86x5.7', '12657': '1.26x5.7', '82283': '.82x2.8' };

function gioMatch(item, gioSkus) {
  const it = item.toUpperCase().replace(/\s/g, '');
  let color = null, fin = null, fmt = null, slsz = null, hexSz = null;
  const m = GIO_RE.exec(it);
  if (m) {
    color = GIO_COLOR[m[1]]; fin = GIO_FIN[m[2]]; fmt = m[3] === 'H' ? 'hex' : 'sl'; slsz = GIO_SLSZ[m[4]] || null;
    if (!slsz) hexSz = m[4] === '44' ? '4x4' : (m[4] === '22' ? '2x2' : null);
  } else if (it.startsWith('GIO')) {
    const cs = colorsIn(item); color = cs.size ? [...cs][0][0] + [...cs][0].slice(1).toLowerCase() : null;
    fin = it.includes('GLOSSY') ? 'glossy' : 'matte';
    fmt = it.includes('HEX') ? 'hex' : ((it.includes('STACKED') || it.includes('LINEAR')) ? 'sl' : null);
    const s = sizeOf(item); hexSz = s && s[0] === 4 ? '4x4' : (s && s[0] === 2 ? '2x2' : null);
  } else return null;
  for (const c of gioSkus) {
    const vu = c.variant.toUpperCase();
    if (color && !vu.includes(color.toUpperCase())) continue;
    const cf = vu.includes('HEX') ? 'hex' : 'sl';
    if (fmt && fmt !== cf) continue;
    if (fin && c.finish && fin !== c.finish) continue;
    if (slsz && !c.variant.includes(slsz)) continue;
    if (hexSz && !c.variant.includes(hexSz)) continue;
    return c;
  }
  return null;
}

function resolveProduct(item) {
  const it = item.toUpperCase();
  let best = null, bl = 0;
  for (const [prod, als] of Object.entries(ALIAS)) {
    for (const a of als) {
      const p = a.trim();
      if (it.startsWith(p) && p.length > bl) { best = prod; bl = p.length; }
    }
  }
  return best;
}

/** Resolve one stock item to exactly one SKU record, or null. Conservative. */
function matchItem(item, byProduct) {
  const prod = resolveProduct(item);
  if (!prod || !byProduct.has(prod)) return null;
  const cands = byProduct.get(prod);
  const isz = sizeOf(item), ifin = finishOf(item), ifmt = fmtOf(item), icol = colorsIn(item);
  const prodColors = new Set(cands.flatMap(c => [...c.color]));
  const icolp = new Set([...icol].filter(x => prodColors.has(x)));
  const good = [];
  for (const c of cands) {
    if (c.fmt !== ifmt) continue;
    if (c.size && isz && sizesMatch(c.size, isz) === false) continue;
    if (c.size && !isz && ifmt === 'field') continue;
    if (c.finish && ifin && c.finish !== ifin) continue;
    if (c.color.size && !inter(c.color, icol)) continue;
    if (icolp.size && c.color.size && !inter(c.color, icolp)) continue;
    if (icolp.size && !c.color.size) continue;
    if (prodColors.size && icol.size && !icolp.size) continue;
    good.push(c);
  }
  return good.length === 1 ? good[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PPWP login + fetch
// ─────────────────────────────────────────────────────────────────────────────

async function fetchStockHtml(password) {
  // 1. GET the form to read post_id + action
  const formResp = await fetch(BASE + STOCK_PATH + '?ppwp=1', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  const formHtml = await formResp.text();
  const postId = (/name="post_id"\s+value="(\d+)"/i.exec(formHtml) || [])[1] || '3602';
  let action = (/<form[^>]*action="([^"]*ppw_postpass[^"]*)"/i.exec(formHtml) || [])[1];
  action = action ? action.replace(/&#0?38;/g, '&').replace(/&amp;/g, '&') : `${BASE}/?action=ppw_postpass&type=individual&callback_url=${encodeURIComponent(BASE + STOCK_PATH)}`;
  if (action.startsWith('?')) action = BASE + '/' + action;

  // 2. POST the password (manual redirect so we can capture the ppwp cookie)
  const body = new URLSearchParams({ post_password: password, Submit: 'Enter', post_id: postId });
  const postResp = await fetch(action, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE + STOCK_PATH },
    body,
  });
  const setCookie = postResp.headers.getSetCookie ? postResp.headers.getSetCookie() : [postResp.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ');

  // 3. GET the unlocked page with the cookie
  const pageResp = await fetch(BASE + STOCK_PATH, {
    headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(30000),
  });
  const html = await pageResp.text();
  return html;
}

/** Parse the stock table → [{ item, onHand, onSalesOrder }] */
function parseStockTable(html) {
  const table = (/<table[\s\S]*?<\/table>/i.exec(html) || [])[0];
  if (!table) return [];
  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const out = [];
  for (const tr of rows) {
    const cells = (tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [])
      .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length < 4) continue;
    const item = cells[0];
    if (!item || /quantity on hand/i.test(cells[2])) continue; // header row
    const onHand = parseInt((cells[2] || '0').replace(/[,\s]/g, ''), 10);
    const onSO = parseInt((cells[3] || '0').replace(/[,\s]/g, ''), 10);
    if (!item) continue;
    out.push({ item, onHand: Number.isFinite(onHand) ? onHand : 0, onSalesOrder: Number.isFinite(onSO) ? onSO : 0 });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function run(pool, job, source) {
  const cfg = source.config || {};
  const password = cfg.password || 'bellezza1234';
  const freshnessHours = cfg.freshnessHours || 48;
  const warehouse = cfg.warehouse || 'Bellezza-PicoRivera';

  await appendLog(pool, job.id, 'Bellezza inventory: logging into PPWP stock-check page...');
  const html = await fetchStockHtml(password);
  if (/ppw-post-password-form|name="post_password"/i.test(html)) {
    const msg = 'Stock page still password-protected after login — PPWP password may have changed.';
    await addJobError(pool, job.id, msg);
    throw new Error(msg);
  }
  const stock = parseStockTable(html);
  await appendLog(pool, job.id, `Parsed ${stock.length} stock rows from the sheet.`);
  if (stock.length < 50) {
    const msg = `Only ${stock.length} stock rows parsed (expected ~400) — page layout may have changed. Aborting to avoid clobbering good data.`;
    await addJobError(pool, job.id, msg);
    throw new Error(msg);
  }

  // Load our BLZ SKUs with attributes + packaging
  const skuRes = await pool.query(`
    SELECT s.id, p.name AS product, s.variant_name AS variant, s.sell_by,
      MAX(CASE WHEN a.slug='size' THEN sa.value END) AS size,
      MAX(CASE WHEN a.slug='color' THEN sa.value END) AS color,
      MAX(CASE WHEN a.slug='finish' THEN sa.value END) AS finish,
      pk.pieces_per_box, pk.sqft_per_box
    FROM products p
    JOIN skus s ON s.product_id = p.id
    LEFT JOIN sku_attributes sa ON sa.sku_id = s.id
    LEFT JOIN attributes a ON a.id = sa.attribute_id
    LEFT JOIN packaging pk ON pk.sku_id = s.id
    JOIN vendors v ON v.id = p.vendor_id
    WHERE v.code = 'BLZ'
    GROUP BY s.id, p.name, s.variant_name, s.sell_by, pk.pieces_per_box, pk.sqft_per_box
  `);

  // Build per-product candidate records. Skip generic multi-color parent rows
  // (color attr contains a comma) — they duplicate the per-color children.
  const byProduct = new Map();
  const skuMeta = new Map(); // id -> { pieces_per_box, sqft_per_box, variant }
  const gioSkus = [];
  for (const r of skuRes.rows) {
    skuMeta.set(r.id, { piecesPerBox: r.pieces_per_box ? +r.pieces_per_box : null, sqftPerBox: r.sqft_per_box ? +r.sqft_per_box : null, display: `${r.product}/${r.variant}` });
    if (r.color && r.color.includes(',')) continue;
    const rec = {
      id: r.id, variant: r.variant || '',
      size: sizeOf(r.size || '') || sizeOf(r.variant || ''),
      color: colorsIn(r.color || ''),
      finish: finishOf(`${r.finish || ''} ${r.variant || ''}`),
      fmt: fmtOf(r.variant || ''),
    };
    if (!byProduct.has(r.product)) byProduct.set(r.product, []);
    byProduct.get(r.product).push(rec);
    if (r.product === 'Gio') gioSkus.push(rec);
  }

  // Match every stock row → aggregate on-hand pieces per SKU
  const perSku = new Map(); // skuId -> pieces
  let matchedRows = 0;
  const unmatched = [];
  for (const row of stock) {
    const itUp = row.item.toUpperCase().replace(/\s/g, '');
    let rec = null;
    if (GIO_RE.test(itUp) || itUp.startsWith('GIO')) rec = gioMatch(row.item, gioSkus);
    else rec = matchItem(row.item, byProduct);
    if (!rec) { if (unmatched.length < 40) unmatched.push(row.item); continue; }
    matchedRows++;
    perSku.set(rec.id, (perSku.get(rec.id) || 0) + Math.max(0, row.onHand)); // clamp oversold to 0
  }

  await appendLog(pool, job.id, `Matched ${matchedRows} rows → ${perSku.size} SKUs. Unmatched (discontinued/not-carried): ${stock.length - matchedRows}.`);

  // Upsert one snapshot per matched SKU. Convert pieces → boxes (storefront treats
  // qty_on_hand as boxes and derives sqft = qty_on_hand * sqft_per_box).
  let updated = 0;
  for (const [skuId, pieces] of perSku) {
    const meta = skuMeta.get(skuId);
    const ppb = meta && meta.piecesPerBox;
    const spb = meta && meta.sqftPerBox;
    const qtyOnHand = ppb && ppb > 0 ? Math.floor(pieces / ppb) : pieces; // boxes for box-sold; pieces for unit-sold
    const qtySqft = ppb && ppb > 0 && spb ? Math.round((pieces / ppb) * spb) : 0;
    try {
      await pool.query(`
        INSERT INTO inventory_snapshots (sku_id, warehouse, qty_on_hand, qty_in_transit, qty_on_hand_sqft, qty_in_transit_sqft, snapshot_time, fresh_until)
        VALUES ($1, $2, $3, 0, $4, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + ($5 || ' hours')::interval)
        ON CONFLICT (sku_id, warehouse) DO UPDATE SET
          qty_on_hand = EXCLUDED.qty_on_hand,
          qty_on_hand_sqft = EXCLUDED.qty_on_hand_sqft,
          snapshot_time = CURRENT_TIMESTAMP,
          fresh_until = EXCLUDED.fresh_until
      `, [skuId, warehouse, qtyOnHand, qtySqft, String(freshnessHours)]);
      updated++;
    } catch (err) {
      await addJobError(pool, job.id, `SKU ${skuId} (${meta && meta.display}): ${err.message}`);
    }
  }

  await appendLog(
    pool, job.id,
    `Bellezza inventory complete. Rows: ${stock.length}, matched: ${matchedRows}, SKUs updated: ${updated}` +
      (unmatched.length ? `. Sample unmatched: ${unmatched.slice(0, 12).join(' | ')}` : ''),
    { products_found: perSku.size, products_updated: updated }
  );
}

// Standalone entrypoint: `node scrapers/bellezza-inventory.js` (used by the
// "Run scraper on prod" GitHub workflow). Creates its own pool + scrape_job,
// mirroring run-scraper.cjs. Harmless when the module is merely imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'db',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'flooring_pim',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });
  const src = (await pool.query("SELECT * FROM vendor_sources WHERE scraper_key = 'bellezza-inventory' LIMIT 1")).rows[0];
  if (!src) { console.error('No vendor_source with scraper_key=bellezza-inventory'); process.exit(1); }
  const jobId = (await pool.query(
    "INSERT INTO scrape_jobs (vendor_source_id, status, started_at) VALUES ($1,'running',NOW()) RETURNING id", [src.id]
  )).rows[0].id;
  try {
    await run(pool, { id: jobId }, src);
    await pool.query("UPDATE scrape_jobs SET status='completed', completed_at=NOW() WHERE id=$1", [jobId]);
  } catch (e) {
    await pool.query("UPDATE scrape_jobs SET status='failed', completed_at=NOW() WHERE id=$1", [jobId]).catch(() => {});
    console.error('FATAL:', e);
    process.exitCode = 1;
  }
  console.log((await pool.query('SELECT log FROM scrape_jobs WHERE id=$1', [jobId])).rows[0].log);
  await pool.end();
}
