/**
 * link-vanity-accessories.cjs
 *
 * Attaches HR vanity ACCESSORIES (tops, mirrors, legs, sidesplashes, sinks) to
 * their matching vanity CABINET SKUs as cross-product sku_accessories links, so
 * they show in the storefront "Matching Accessories" section instead of as
 * standalone browse products. Imageless accessories render as clean text cards.
 *
 * Compatibility comes from HR's own grouping: each vanity group page lists the
 * cabinet + exactly the tops/mirrors/legs that pair with it. We harvest that
 * co-occurrence from the page config and link accordingly.
 *
 *  - Finish-specific accessories (mirror/legs whose SKU ends in a cabinet finish
 *    code, e.g. MIR2CHA-28-BL, VNLEGWD30BS) link only to the matching-finish
 *    cabinets on that page.
 *  - Material/universal accessories (tops TKIT/TOPR/TOPO, sidesplash, metal
 *    mirrors, sinks) link to every cabinet finish on the page.
 *
 * Side effects (only with --apply): sets variant_type='accessory' on linked
 * accessory SKUs (keeps them out of the browse grid) and activates their
 * products (required for the accessory API to surface them).
 *
 * Usage:
 *   docker compose exec -T api node scripts/link-vanity-accessories.cjs [--apply] [--limit=N]
 *   (no --apply = dry run)
 */
const { Pool } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = parseInt((args.find(a => a.startsWith('--limit=')) || '--limit=99999').split('=')[1], 10);

const HR = 'https://www.hardwareresources.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

const ACC_RE = /^(TKIT|TOPR|TOPO|MIR2|VMIR|SSPLASH|VNLEG|VN2-)/;      // accessory sku prefixes
const CAB_RE = /^VN2[A-Z]+-\d+-([A-Z]{2,3})-NT$/;                      // cabinet sku -> finish in group 1
const TYPE_ORDER = s => s.startsWith('TKIT') || s.startsWith('TOPR') || s.startsWith('TOPO') ? 0
  : s.startsWith('SSPLASH') ? 1
  : s.startsWith('MIR') || s.startsWith('VMIR') ? 2
  : s.startsWith('VNLEG') ? 3 : 4;

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR + '/', 'X-Requested-With': 'XMLHttpRequest' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function groupUrl(stem) {
  const m = stem.toUpperCase().match(/^(VN2[A-Z]+)-(\d+)/);
  return m ? `${HR}/vanities/vanities/${m[1].toLowerCase()}-${m[2]}-group.html` : null;
}

async function main() {
  console.log(`\n  Link vanity accessories -> cabinets — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // DB lookup: vendor_sku(UPPER) -> {sku_id, product_id}
  const { rows: allSkus } = await pool.query(
    `SELECT upper(s.vendor_sku) AS sku, s.id AS sku_id, s.product_id
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
       JOIN categories c ON c.id=p.category_id
      WHERE v.code='HR' AND c.name='Vanity'`
  );
  const db = new Map(allSkus.map(r => [r.sku, r]));

  const { rows: stems } = await pool.query(
    `SELECT DISTINCT substring(upper(s.vendor_sku) from '^(VN2[A-Z]+-[0-9]+)') AS stem
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code='HR' AND upper(s.vendor_sku) ~ '^VN2[A-Z]+-[0-9]+-[A-Z]{2,3}-NT' ORDER BY stem`
  );

  const links = [];              // {parentSku, accSku}
  const accessorySkus = new Set();
  let pages = 0;

  for (const { stem } of stems.slice(0, LIMIT)) {
    let html;
    try { html = await fetchText(groupUrl(stem)); } catch (e) { await sleep(300); continue; }
    pages++;
    // TRUE grouped members only: skus inside the grouped-product "skus":{...} config
    // blocks (excludes related-product / cross-sell carousels elsewhere on the page)
    const present = new Set();
    for (const blk of html.matchAll(/"skus":\{([^{}]*)\}/g))
      for (const mm of blk[1].matchAll(/"\d{4,}":"([A-Z][A-Z0-9-]{3,})"/g)) present.add(mm[1].toUpperCase());

    const cabs = [...present].filter(s => CAB_RE.test(s) && db.has(s));
    const accs = [...present].filter(s => ACC_RE.test(s) && db.has(s));
    if (!cabs.length || !accs.length) { await sleep(300); continue; }

    const pageCollections = new Set(cabs.map(s => s.match(/^(VN2[A-Z]+)/)[1]));  // normally one
    const pageFinishes = new Set(cabs.map(s => s.match(CAB_RE)[1]));
    for (const acc of accs) {
      // Collection-coded mirror (MIR2<COLL>-<size>-<FINISH>): finish-EXACT, same collection.
      const colM = acc.match(/^MIR2([A-Z]+)-\d+-([A-Z]{2,3})$/);
      if (colM) {
        if (!pageCollections.has('VN2' + colM[1])) continue;               // cross-collection
        const mtargets = cabs.filter(c => c.match(CAB_RE)[1] === colM[2]);  // exact finish only
        if (!mtargets.length) continue;                                     // finish not sold as a cabinet here
        accessorySkus.add(acc);
        for (const c of mtargets) links.push({ parentSku: c, accSku: acc });
        continue;
      }
      // Other accessories: finish-specific if sku ends in a cabinet finish on this page (legs),
      // otherwise universal across finishes (material tops, metal mirrors, sidesplashes, sinks).
      accessorySkus.add(acc);
      let finish = null;
      for (const f of pageFinishes) if (new RegExp(`[-0-9]${f}$`).test(acc)) { finish = f; break; }
      const targets = finish ? cabs.filter(c => c.match(CAB_RE)[1] === finish) : cabs;
      for (const c of targets) links.push({ parentSku: c, accSku: acc });
    }
    await sleep(300);
  }

  // dedup links
  const seen = new Set();
  const uniq = links.filter(l => { const k = l.parentSku + '|' + l.accSku; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log(`  crawled ${pages} pages; ${accessorySkus.size} accessory SKUs; ${uniq.length} cabinet->accessory links\n`);

  if (!APPLY) {
    console.log('  (dry run — no writes) sample links:');
    uniq.slice(0, 12).forEach(l => console.log(`    ${l.parentSku}  <-  ${l.accSku}`));
    await pool.end(); return;
  }

  // 0) clean slate: remove any prior links between HR cabinets and HR vanity accessories
  //    (makes re-runs idempotent and clears earlier mis-links)
  await pool.query(`
    DELETE FROM sku_accessories sa
    USING skus ps, skus acs, products pp, vendors v
    WHERE sa.parent_sku_id=ps.id AND sa.accessory_sku_id=acs.id
      AND ps.product_id=pp.id AND pp.vendor_id=v.id AND v.code='HR'
      AND upper(ps.vendor_sku) ~ '^VN2[A-Z]+-[0-9]+-[A-Z]{2,3}-NT'
      AND upper(acs.vendor_sku) ~ '^(TKIT|TOPR|TOPO|MIR2|VMIR|SSPLASH|VNLEG|VN2-)'`);

  // 1) reclassify accessory skus -> accessory; activate BOTH sku and product (API filters s.status)
  const accIds = [...accessorySkus].map(s => db.get(s).sku_id);
  const accProdIds = [...new Set([...accessorySkus].map(s => db.get(s).product_id))];
  await pool.query(`UPDATE skus SET variant_type='accessory', status='active', updated_at=CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[])`, [accIds]);
  const act = await pool.query(`UPDATE products SET status='active', updated_at=CURRENT_TIMESTAMP WHERE id = ANY($1::uuid[]) AND status <> 'active'`, [accProdIds]);

  // 2) insert links
  let inserted = 0;
  for (const l of uniq) {
    const parent = db.get(l.parentSku), acc = db.get(l.accSku);
    const r = await pool.query(
      `INSERT INTO sku_accessories (parent_sku_id, accessory_sku_id, sort_order)
       VALUES ($1,$2,$3) ON CONFLICT (parent_sku_id, accessory_sku_id) DO NOTHING`,
      [parent.sku_id, acc.sku_id, TYPE_ORDER(l.accSku)]
    );
    inserted += r.rowCount;
  }
  console.log(`  APPLIED: ${accIds.length} skus -> accessory, ${act.rowCount} products activated, ${inserted} links inserted\n`);
  await pool.end();
}
main().catch(async e => { console.error('FATAL', e); try { await pool.end(); } catch (_) {} process.exit(1); });
