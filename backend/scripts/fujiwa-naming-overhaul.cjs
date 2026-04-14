#!/usr/bin/env node
/**
 * Fujiwa naming & grouping overhaul
 *
 * Aligns DB names/slugs/collections with Fujiwa's canonical website structure:
 *   https://www.fujiwatiles.com/products/fujiwa-tile-collections/
 *   https://www.fujiwatiles.com/products/watermark-mosaics/
 *   https://www.fujiwatiles.com/products/depth-markers/
 *
 * Changes:
 *   1. Tile products: display_name gains " Series" suffix, slugs standardized.
 *      Collection stays "Pool Tile" (customer-facing category label; "Pool Tile
 *      Collections" is Fujiwa's own URL taxonomy, not a customer label).
 *   2. Watermark mosaic collection: "Watermark Mosaic" -> "Watermark Mosaics"
 *   3. Watermark mosaic names: drop parens, match Fujiwa's naming
 *   4. Accessory slug cleanup
 */

const { Client } = require('pg');

const FUJIWA_VENDOR_ID = '8ec5135f-8ded-4818-925e-2ca70bef4c0a';

// --- TILE SERIES: name -> { displayName, slug } ------------------------------
// Our product "name" is the base (e.g. "Alco Deco"). display_name mirrors Fujiwa's
// series label. Slug follows Fujiwa's canonical slug where possible.
const TILE_MAP = {
  'Alco Deco':    { display: 'Alco Deco Series',    slug: 'pool-tile-alco-deco-series' },
  'Alex':         { display: 'Alex Series',         slug: 'pool-tile-alex-series' },
  'Ambon Deco':   { display: 'Ambon Deco Series',   slug: 'pool-tile-ambon-deco-series' },
  'Bohol':        { display: 'Bohol Series',        slug: 'pool-tile-bohol-series' },
  'Bora':         { display: 'Bora 600 Series',     slug: 'pool-tile-bora-600-series' },
  'Celica':       { display: 'Celica Series',       slug: 'pool-tile-celica-series' },
  'Cresta':       { display: 'Cresta Series',       slug: 'pool-tile-cresta-series' },
  'Eros':         { display: 'Eros Series',         slug: 'pool-tile-eros-series' },
  'FGM':          { display: 'FGM Series',          slug: 'pool-tile-fgm-series' },
  'Flora':        { display: 'Flora Series',        slug: 'pool-tile-flora-series' },
  'Fuji':         { display: 'Fuji Series',         slug: 'pool-tile-fuji-series' },
  'Glasstel':     { display: 'Glasstel Series',     slug: 'pool-tile-glasstel-series' },
  'Gloss Solid':  { display: 'Gloss Solid Series',  slug: 'pool-tile-gloss-solid-series' },
  'Hex':          { display: 'Hex Series',          slug: 'pool-tile-hex-series' },
  'Inka':         { display: 'Inka Series',         slug: 'pool-tile-inka-series' },
  'Java':         { display: 'Java Series',         slug: 'pool-tile-java-series' },
  'Joya':         { display: 'Joya Series',         slug: 'pool-tile-joya-series' },
  'KLM':          { display: 'KLM Series',          slug: 'pool-tile-klm-series' },
  'Kasuri':       { display: 'Kasuri Series',       slug: 'pool-tile-kasuri-series' },
  'Kawa':         { display: 'Kawa Series',         slug: 'pool-tile-kawa-series' },
  'Kenji':        { display: 'Kenji Series',        slug: 'pool-tile-kenji-series' },
  'Koln':         { display: 'Koln Series',         slug: 'pool-tile-koln-series' },
  'Lantern':      { display: 'Lantern Series',      slug: 'pool-tile-lantern-series' },
  'Legacy':       { display: 'Legacy Series',       slug: 'pool-tile-legacy-series' },
  'Licata':       { display: 'Licata Series',       slug: 'pool-tile-licata-series' },
  'Lombo':        { display: 'Lombo Series',        slug: 'pool-tile-lombo-series' },
  'Lunar':        { display: 'Lunar Series',        slug: 'pool-tile-lunar-series' },
  'Lyra':         { display: 'Lyra 600 Series',     slug: 'pool-tile-lyra-600-series' },
  'Nami':         { display: 'Nami Series',         slug: 'pool-tile-nami-series' },
  'Net':          { display: 'Net 600 Series',      slug: 'pool-tile-net-600-series' },
  'Omega':        { display: 'Omega Series',        slug: 'pool-tile-omega-series' },
  'PEB':          { display: 'PEB Series',          slug: 'pool-tile-peb-series' },
  'Pad':          { display: 'Pad Series',          slug: 'pool-tile-pad-series' },
  'Patina':       { display: 'Patina Series',       slug: 'pool-tile-patina-series' },
  'Pebblestone':  { display: 'Pebblestone Series',  slug: 'pool-tile-pebblestone-series' },
  'Penny Round':  { display: 'Penny Round Series',  slug: 'pool-tile-penny-round-series' },
  'Pilos':        { display: 'Pilos Series',        slug: 'pool-tile-pilos-series' },
  'Planet':       { display: 'Planet Series',       slug: 'pool-tile-planet-series' },
  'Prima':        { display: 'Prima Series',        slug: 'pool-tile-prima-series' },
  'Quarzo':       { display: 'Quarzo Series',       slug: 'pool-tile-quarzo-series' },
  'Rio':          { display: 'Rio Series',          slug: 'pool-tile-rio-series' },
  'Rivera':       { display: 'Rivera Series',       slug: 'pool-tile-rivera-series' },
  'Rust':         { display: 'Rust Series',         slug: 'pool-tile-rust-series' },
  'STQ':          { display: 'STQ Series',          slug: 'pool-tile-stq-series' },
  'STS':          { display: 'STS Series',          slug: 'pool-tile-sts-series' },
  'Saga':         { display: 'Saga Series',         slug: 'pool-tile-saga-series' },
  'Sekis':        { display: 'Sekis Series',        slug: 'pool-tile-sekis-series' },
  'Sierra':       { display: 'Sierra Series',       slug: 'pool-tile-sierra-series' },
  'Smalt Art':    { display: 'Smalt Art Series',    slug: 'pool-tile-smalt-art-series' },
  'Sora':         { display: 'Sora 700 Series',     slug: 'pool-tile-sora-700-series' },
  'Stak Deco':    { display: 'Stak Deco Series',    slug: 'pool-tile-stak-deco-series' },
  'Stardon':      { display: 'Stardon Series',      slug: 'pool-tile-stardon-series' },
  'Stoneledge':   { display: 'Stoneledge Series',   slug: 'pool-tile-stoneledge-series' },
  'Sydney':       { display: 'Sydney Series',       slug: 'pool-tile-sydney-series' },
  'TNT':          { display: 'TNT Series',          slug: 'pool-tile-tnt-series' },
  'Tilis':        { display: 'Tilis Series',        slug: 'pool-tile-tilis-series' },
  'Titan':        { display: 'Titan Series',        slug: 'pool-tile-titan-series' },
  'Tokyo':        { display: 'Tokyo Series',        slug: 'pool-tile-tokyo-series' },
  'Unglazed':     { display: 'Unglazed Series',     slug: 'pool-tile-unglazed-series' },
  'VIP':          { display: 'VIP Series',          slug: 'pool-tile-vip-series' },
  'Veniz':        { display: 'Veniz Series',        slug: 'pool-tile-veniz-series' },
  'Vigan':        { display: 'Vigan Series',        slug: 'pool-tile-vigan-series' },
  'Vinta':        { display: 'Vinta Series',        slug: 'pool-tile-vinta-series' },
  'Yomba':        { display: 'Yomba Series',        slug: 'pool-tile-yomba-series' },
  'Yuca':         { display: 'Yuca Series',         slug: 'pool-tile-yuca-series' },
};

// --- WATERMARK MOSAICS: current name -> { newName, displayName, slug } -------
// Fujiwa uses space-separated naming (no parens). We match where Fujiwa has the
// variant, otherwise keep a clean space-separated form.
const MOSAIC_MAP = {
  'Angel Fish':             { name: 'Angel Fish',             slug: 'watermark-mosaics-angel-fish' },
  'Ball':                   { name: 'Ball',                   slug: 'watermark-mosaics-ball' },
  'Butterfly Fish':         { name: 'Butterfly Fish',         slug: 'watermark-mosaics-butterfly-fish' },
  'Circle Dolphin':         { name: 'Circle Dolphin',         slug: 'watermark-mosaics-circle-dolphin' },
  'Clown Fish':             { name: 'Clown Fish',             slug: 'watermark-mosaics-clown-fish' },
  'Coral Fish':             { name: 'Coral Fish',             slug: 'watermark-mosaics-coral-fish' },
  'Crab':                   { name: 'Crab',                   slug: 'watermark-mosaics-crab' },
  'Dolphin':                { name: 'Dolphin',                slug: 'watermark-mosaics-dolphin' },
  'Kelp Fish':              { name: 'Kelp Fish',              slug: 'watermark-mosaics-kelp-fish' },
  'Lobster':                { name: 'Lobster',                slug: 'watermark-mosaics-lobster' },
  'Mermaid w/ Dolphin':     { name: 'Mermaid With Dolphin',   slug: 'watermark-mosaics-mermaid-with-dolphin' },
  'Porpoise':               { name: 'Porpoise',               slug: 'watermark-mosaics-porpoise' },
  'Puffer Fish':            { name: 'Puffer Fish',            slug: 'watermark-mosaics-puffer-fish' },
  'Sand Crab':              { name: 'Sand Crab',              slug: 'watermark-mosaics-sand-crab' },
  'Sanddollar':             { name: 'Sand Dollar',            slug: 'watermark-mosaics-sand-dollar' },
  'Seahorse (Red)':         { name: 'Seahorse',               slug: 'watermark-mosaics-seahorse' },
  'Seahorse (Teal)':        { name: 'Seahorse Blue',          slug: 'watermark-mosaics-seahorse-blue' },
  'Spotted Fish':           { name: 'Spotted Fish',           slug: 'watermark-mosaics-spotted-fish' },
  'Star Shell':             { name: 'Star Shell',             slug: 'watermark-mosaics-star-shell' },
  'Starfish (2-Tone Blue)': { name: 'Starfish 2 Tone Blue',   slug: 'watermark-mosaics-starfish-2-tone-blue' },
  'Starfish (Blue)':        { name: 'Starfish Blue',          slug: 'watermark-mosaics-starfish-blue' },
  'Starfish (Peach)':       { name: 'Starfish Peach',         slug: 'watermark-mosaics-starfish-peach' },
  'Starfish (Peach-Orange)':{ name: 'Starfish Orange',        slug: 'watermark-mosaics-starfish-orange' },
  'Starfish (Red)':         { name: 'Starfish Red',           slug: 'watermark-mosaics-starfish-red' },
  'Starfish (Red-Yellow)':  { name: 'Starfish Yellow',        slug: 'watermark-mosaics-starfish-yellow' },
  'Tetra Fish':             { name: 'Tetra Fish',             slug: 'watermark-mosaics-tetra-fish' },
  'Turrid Shell':           { name: 'Turrid Shell',           slug: 'watermark-mosaics-turrid-shell' },
  'Turtle (Choco)':         { name: 'Turtle Brown',           slug: 'watermark-mosaics-turtle-brown' },
  'Turtle (Natural Green)': { name: 'Turtle',                 slug: 'watermark-mosaics-turtle' },
};

// --- POOL ACCESSORIES: current name -> new slug ------------------------------
const ACCESSORY_MAP = {
  'Depth Markers':             { name: 'Depth Markers',             slug: 'pool-accessories-depth-markers' },
  'Hide 12" Skimmer Lid Kit':  { name: 'Hide 12" Skimmer Lid Kit',  slug: 'pool-accessories-hide-skimmer-lid-kit' },
  'Pool Tile Trims':           { name: 'Pool Tile Trims',           slug: 'pool-accessories-pool-tile-trims' },
};

async function run() {
  const client = new Client({
    host: process.env.PG_HOST || 'db',
    port: +(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD || 'postgres',
    database: process.env.PG_DATABASE || 'flooring_pim',
  });
  await client.connect();

  try {
    await client.query('BEGIN');

    // Fetch current state
    const { rows: products } = await client.query(
      `SELECT id, name, display_name, slug, collection
       FROM products WHERE vendor_id = $1 ORDER BY collection, name`,
      [FUJIWA_VENDOR_ID]
    );
    console.log(`Found ${products.length} Fujiwa products`);

    let updated = 0, skipped = 0, missing = 0;
    const unmapped = [];

    for (const p of products) {
      let targetName = p.name;
      let targetDisplay = p.display_name;
      let targetSlug = p.slug;
      let targetCollection = p.collection;

      if (p.collection === 'Pool Tile' || p.collection === 'Pool Tile Collections') {
        targetCollection = 'Pool Tile';
        const m = TILE_MAP[p.name];
        if (m) {
          targetDisplay = m.display;
          targetSlug = m.slug;
        } else {
          unmapped.push({ section: 'TILE', name: p.name });
        }
      } else if (p.collection === 'Watermark Mosaic' || p.collection === 'Watermark Mosaics') {
        targetCollection = 'Watermark Mosaics';
        const m = MOSAIC_MAP[p.name];
        if (m) {
          targetName = m.name;
          targetDisplay = m.name;
          targetSlug = m.slug;
        } else {
          unmapped.push({ section: 'MOSAIC', name: p.name });
        }
      } else if (p.collection === 'Pool Accessories') {
        const m = ACCESSORY_MAP[p.name];
        if (m) {
          targetName = m.name;
          targetDisplay = m.name;
          targetSlug = m.slug;
        } else {
          unmapped.push({ section: 'ACCESSORY', name: p.name });
        }
      }

      if (
        targetName === p.name &&
        targetDisplay === p.display_name &&
        targetSlug === p.slug &&
        targetCollection === p.collection
      ) {
        skipped++;
        continue;
      }

      console.log(
        `  ${p.collection.padEnd(18)} "${p.name}"` +
        (targetName !== p.name ? `  -> name "${targetName}"` : '') +
        (targetCollection !== p.collection ? `  -> coll "${targetCollection}"` : '') +
        (targetDisplay !== p.display_name ? `  -> display "${targetDisplay}"` : '') +
        (targetSlug !== p.slug ? `  -> slug "${targetSlug}"` : '')
      );

      await client.query(
        `UPDATE products
         SET name = $1, display_name = $2, slug = $3, collection = $4, updated_at = NOW()
         WHERE id = $5`,
        [targetName, targetDisplay, targetSlug, targetCollection, p.id]
      );
      updated++;
    }

    console.log(`\nUpdated: ${updated} | Unchanged: ${skipped} | Unmapped: ${unmapped.length}`);
    if (unmapped.length) {
      console.log('Unmapped products (review):');
      unmapped.forEach(u => console.log(`  [${u.section}] ${u.name}`));
    }

    await client.query('COMMIT');
    console.log('\nCommitted.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

run();
