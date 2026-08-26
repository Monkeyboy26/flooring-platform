/**
 * label-vanity-accessories.cjs
 *
 * Sets a clear, color/material-stating `accessory_label` on HR vanity
 * accessories so every "Matching Accessories" card states its variant and the
 * cards stop collapsing (storefront dedupes by accessory_label + variant_name).
 *
 *  - Mirrors (MIR2<coll>-<size>-<FINISH>) + Legs (VNLEG..<FINISH>): finish from
 *    the cabinet finish map (code -> name).
 *  - Metal mirrors (VMIR): their variant_name already holds the frame finish.
 *  - Vanity tops (TKIT/TOPR/TOPO): material label read from HR's own swatch
 *    jsonConfig on the vanity group pages (authoritative; SKU-code decoding is
 *    ambiguous). Falls back to "Material: X" in the product name.
 *  - Sidesplash (SSPLASH): material already in product name -> left as-is.
 *
 * Usage: docker compose exec -T api node scripts/label-vanity-accessories.cjs [--apply]
 */
const { Pool } = require('pg');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const HR = 'https://www.hardwareresources.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost', port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'flooring_pim', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD || 'postgres',
});

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: HR + '/', 'X-Requested-With': 'XMLHttpRequest' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
function groupUrl(stem) {
  const m = stem.toUpperCase().match(/^(VN2[A-Z]+)-(\d+)/);
  return m ? `${HR}/vanities/vanities/${m[1].toLowerCase()}-${m[2]}-group.html` : null;
}
// Map top sku -> material label. HR stores the top's material under the same
// finish_hr attribute (options like "Black Granite"), and each option lists its
// child product ids in "products":[...]. Scope to each finish_hr block (up to
// the next attribute) so we don't pick up bowl_cutout_shape/width options.
function skuMaterialFromHtml(html, out) {
  const pidSku = new Map();
  for (const m of html.matchAll(/"(\d{4,})":"([A-Z][A-Z0-9-]{3,})"/g)) pidSku.set(m[1], m[2].toUpperCase());
  const re = /"code":"finish_hr"/g; let m;
  while ((m = re.exec(html))) {
    const next = html.indexOf('"code":"', m.index + 12);
    const region = html.slice(m.index, next > 0 ? next : m.index + 20000);
    for (const om of region.matchAll(/"label":"([^"]+)","products":\[([^\]]*)\]/g)) {
      const label = om[1].trim();
      for (const pid of (om[2].match(/\d{4,}/g) || [])) {
        const sku = pidSku.get(pid);
        if (sku && /^(TKIT|TOPR|TOPO)/.test(sku) && !out.has(sku)) out.set(sku, label);
      }
    }
  }
}

async function main() {
  console.log(`\n  Label vanity accessories — ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // finish code -> name, from cabinets
  const { rows: fm } = await pool.query(
    `SELECT DISTINCT substring(upper(s.vendor_sku) from '^VN2[A-Z]+-[0-9]+-([A-Z]{2,3})-NT') AS code, fa.value AS name
       FROM skus s JOIN sku_attributes fa ON fa.sku_id=s.id AND fa.attribute_id='d50e8400-e29b-41d4-a716-446655440003'
       JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code='HR' AND upper(s.vendor_sku) ~ '^VN2[A-Z]+-[0-9]+-[A-Z]{2,3}-NT'`);
  const finishMap = new Map(fm.map(r => [r.code, r.name]));

  // scrape top sku -> material from HR config across vanity group pages
  const { rows: stems } = await pool.query(
    `SELECT DISTINCT substring(upper(s.vendor_sku) from '^(VN2[A-Z]+-[0-9]+)') AS stem
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id
      WHERE v.code='HR' AND upper(s.vendor_sku) ~ '^VN2[A-Z]+-[0-9]+' ORDER BY stem`);
  const topMaterial = new Map();
  let pages = 0;
  for (const { stem } of stems) {
    try { skuMaterialFromHtml(await fetchText(groupUrl(stem)), topMaterial); pages++; } catch (e) {}
    await sleep(350);
  }
  console.log(`  crawled ${pages} pages; scraped material for ${topMaterial.size} top SKUs`);

  // all HR vanity accessory skus
  const { rows: accs } = await pool.query(
    `SELECT s.id, upper(s.vendor_sku) AS sku, s.variant_name, p.name
       FROM skus s JOIN products p ON p.id=s.product_id JOIN vendors v ON v.id=p.vendor_id JOIN categories c ON c.id=p.category_id
      WHERE v.code='HR' AND c.name='Vanity' AND COALESCE(s.variant_type,'')='accessory'`);

  let labeled = 0;
  for (const a of accs) {
    let label = null;
    const nameMaterial = (a.name.match(/Material:\s*([^,]+)/) || [])[1];
    if (/^MIR2/.test(a.sku)) {
      const fin = finishMap.get((a.sku.match(/-([A-Z]{2,3})$/) || [])[1]);
      if (fin) label = `Mirror — ${fin}`;
    } else if (/^VMIR/.test(a.sku)) {
      if (a.variant_name && a.variant_name !== 'Standard') label = `Frame Mirror — ${a.variant_name}`;
    } else if (/^VNLEG/.test(a.sku)) {
      const fin = finishMap.get((a.sku.match(/([A-Z]{2,3})$/) || [])[1]);
      label = fin ? `Legs — ${fin}` : 'Vanity Legs';
    } else if (/^(TKIT|TOPR|TOPO)/.test(a.sku)) {
      const mat = topMaterial.get(a.sku) || (nameMaterial ? nameMaterial.trim() : null);
      const base = /bowl kit/i.test(a.name) ? 'Vanity Top & Bowl Kit' : 'Vanity Top';
      if (mat) label = `${base} — ${mat}`;
    } else if (/^SSPLASH/.test(a.sku)) {
      if (nameMaterial) label = `Sidesplash — ${nameMaterial.trim()}`;
    }
    if (!label) continue;
    if (APPLY) await pool.query(`UPDATE skus SET accessory_label=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2`, [label, a.id]);
    else if (labeled < 20) console.log(`  ${a.sku.padEnd(18)} -> ${label}`);
    labeled++;
  }
  console.log(`\n  ${APPLY ? 'Applied' : 'Would set'} ${labeled} accessory labels\n`);
  await pool.end();
}
main().catch(async e => { console.error('FATAL', e); try { await pool.end(); } catch (_) {} process.exit(1); });
