// Orion wholesale cost backfill — 2026-09-06.
//
// Fills pricing.cost for Orion (vendor 169) SKUs that carried a scraped site
// retail but a $0 wholesale cost (zero-cost-with-retail rule). Costs come
// from the vendor's "NET WHOLESALE UPDATED PRICE LIST UPDATED JULY 15TH 2026"
// (uploads/pricelists/Orion-wholesale-net-2026-07-15.pdf, pulled from the
// romaflooringdesigns@gmail.com inbox 2026-08-24), matched by product name +
// size; family rows (ASTRO Avorio/Cotto/Verde, STAR, PAINT, SCARLET colors)
// share the list's family price. Existing site retails are kept (nine-ending
// convention) except Mazero Gold, whose retail sat BELOW the new cost —
// bumped to cost x1.6.
//
// NOT matched (stay call-for-price / open): SPC vinyl (JTF*/Houston/Dallas —
// not on this list), deco wallpaper panels (Palma/Blue Forest, $62/panel row
// ambiguous), and items absent from the list (Pamesa, Boston, Albany, Taj
// Mahal, Rosso Verona, Sequoia, La Blue, Sybil, Coreu, terrazzo, etc.).
//
// Idempotent: only touches rows whose cost is still 0.
// Prod: docker compose exec -T api node scripts/backfill-orion-costs-2026-09-06.mjs

import { pool } from '../db.js';

const ENTRIES = [
  { vsku: "marmette-bianco-finish-terrazzo-floor-24x24", cost: 4.19 },
  { vsku: "cotto-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "avorio-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "star-purple-porcelain-tile-24x48", cost: 5.19 },
  { vsku: "viken-beige-matte-porcelain-tile-24x48-2", cost: 4.49 },
  { vsku: "viken-beige-matte-porcelain-tile-24x48", cost: 4.49 },
  { vsku: "montclair-blanco-porcelain-tile-24x24", cost: 3.39 },
  { vsku: "gare-white-gray-porcelain-tile-24x48", cost: 4.09 },
  { vsku: "carrara-marble-marmorea", cost: 4.19 },
  { vsku: "montclair-ivory-porcelain-tile-24x24", cost: 3.39 },
  { vsku: "oni-white-super-polished-porcelain-tile-marble-look-onyx-onix-24x48-copy", cost: 5.59 },
  { vsku: "star-indigo-porcelain-tile-24x48", cost: 5.19 },
  { vsku: "cromatic-black-porcelain-tile-24x24", cost: 3.39 },
  { vsku: "paint-rose-porcelain-tile-24x48", cost: 4.99 },
  { vsku: "paint-blue-porcelain-tile-24x48", cost: 4.99 },
  { vsku: "illusion-snow-porcelain-tile-24x48", cost: 4.19 },
  { vsku: "lilac-purple-porcelain-tile-24x48", cost: 2.49 },
  { vsku: "roma-porcelain-tile-24x48", cost: 3.99 },
  { vsku: "amazona-jade-porcelain-tile-24x48", cost: 5.19 },
  { vsku: "paint-white-porcelain-tile-24x48", cost: 4.99 },
  { vsku: "elegance-white-porcelain-tile-24x48", cost: 3.79 },
  { vsku: "scarlet-blle-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "marmette-jeans-finish-terrazzo-floor-24x24-2", cost: 4.19 },
  { vsku: "oni-pearl-super-polished-porcelain-tile-marble-look-onyx-onix-24x48", cost: 5.59 },
  { vsku: "dark-rose-porcelain-tile-24x48", cost: 2.59 },
  { vsku: "marvel-onyx-green-porcelain-tile-24x48", cost: 2.49 },
  { vsku: "horton-white-porcelain-tile-24x48", cost: 3.79 },
  { vsku: "verde-alpi-italian-marble-italian-marble-slab-green", cost: 4.19 },
  { vsku: "aeterna-grey-porcelain-tile-collection", cost: 3.99 },
  { vsku: "macauba-azul-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "scarlet-white-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "star-emerald-porcelain-tile-24x48", cost: 5.19 },
  { vsku: "paint-gray-porcelain-tile-24x48", cost: 4.99 },
  { vsku: "cromatic-blanco-porcelain-tile-24x24", cost: 3.39 },
  { vsku: "labradorite-blue-porcelain-tile-24x48", cost: 5.15 },
  { vsku: "cf-light-32x32", cost: 4.69 },
  { vsku: "flooring-porcelain-tile-24x48", cost: 4.49 },
  { vsku: "scarlet-black-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "montclair-perla-porcelain-tile-24x24", cost: 3.39 },
  { vsku: "crema-roma-porcelain-tile-24x48", cost: 4.19 },
  { vsku: "toscana-blanco-porcelain-tile-48x48", cost: 4.69 },
  { vsku: "mazero-gold-porcelain-tile-24x48", cost: 2.99, retail: 4.79 },
  { vsku: "paint-salvia-porcelain-tile-24x48", cost: 4.99 },
  { vsku: "serene-onyx-bianco-porcelain-tile-24x48", cost: 2.99 },
  { vsku: "oni-coral-super-polished-porcelain-tile-marble-look-onyx-onix-24x48", cost: 5.59 },
  { vsku: "astro-verde-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "pisa-gold-porcelain-tile-24x48", cost: 4.19 },
  { vsku: "calacatta-gold-2-calacatta-gold-marble", cost: 2.89 },
  { vsku: "ekali-noir-porcelain-tile-24x48", cost: 4.69 },
  { vsku: "aspen-wood-look-porcelain-tile", cost: 3.39 },
  { vsku: "segesta-ivory-matt-porcelain-tile-24x48", cost: 4.59 },
  { vsku: "segesta-ivory-polished-porcelain-tile-24x48", cost: 4.69 },
];

async function main() {
  let n = 0, bumped = 0;
  for (const e of ENTRIES) {
    const r = await pool.query(`
      UPDATE pricing pr SET cost = $2
      FROM skus s, products p
      WHERE s.id = pr.sku_id AND p.id = s.product_id
        AND p.vendor_id = (SELECT id FROM vendors WHERE code = '169')
        AND s.vendor_sku = $1 AND COALESCE(pr.cost, 0) = 0
      RETURNING pr.sku_id`, [e.vsku, e.cost]);
    n += r.rowCount;
    if (e.retail && r.rowCount) {
      await pool.query(`UPDATE pricing SET retail_price = $2 WHERE sku_id = $1 AND retail_price < $2`,
        [r.rows[0].sku_id, e.retail]);
      bumped++;
    }
  }
  console.log(`Orion costs backfilled: ${n} SKU(s), retail bumps: ${bumped}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
