#!/usr/bin/env node
/**
 * emser-categorization-fix.cjs
 *
 * Two categorization fixes for Emser (EMS):
 *   1. NULL category (invisible in browse) — classify the sundry by name into the
 *      right leaf (shower-systems / transitions-moldings / stair-treads-nosing /
 *      installation-sundries / adhesives-sealants / surface-prep-levelers /
 *      underlayment / tools-trowels).
 *   2. Products sitting in the parent "tile" bucket — move each to a leaf tile
 *      category, preferring the leaf its own collection already uses (sibling),
 *      then name hints (Stacked→stacked-stone, Trav→natural-stone, Mosaic→mosaic,
 *      2cm/3cm/Slab→porcelain-slabs), defaulting to porcelain-tile.
 *
 * The sundry classifier mirrors classifyEmserSundry() in emser-832.js (keep in
 * sync). Dry-run by default.
 *
 * Usage: node backend/scripts/emser-categorization-fix.cjs [--apply]
 */
const { Pool } = require('pg');
const pool = new Pool({ host:'localhost', port:5432, database:'flooring_pim', user:'postgres', password:'postgres' });
const APPLY = process.argv.includes('--apply');

// Name → leaf category for Emser sundries/hardware. Order matters (first match
// wins). Used for NULL products and to push products out of the parent
// installation-sundries / hardware-specialty buckets into leaves. Mirror in emser-832.js.
function classifyEmserSundry(name) {
  const s = (name || '').toLowerCase();
  if (/\bniche|curb|probase|foam base|honeycomb|ctr drn|\bdrain\b|\bdrn\b|strainer|\bstrnr\b|\bshower\b|\bshr\b|hydro ?ban|aqua ?shield|aquashld|thinline|soap dish|spice rack|kerdi|\btrough\b|nipple|cradle|\bcpe\b|pvashr|solutions drain|tile top|weep|noble ?deck|nobleseal|\bgrate\b|slpd|provadrain|prova ?board|flexdeck|nobledeck|pan liner|\bbase only\b|slpe bse|\bshelf\b/.test(s)) return 'shower-systems';
  if (/nuheat|thermostat|\btherm\b|radiant|floor (heat|warm)|heat.*(mat|cable|wire|mesh)|\bheat mat|dual voltage|strataheat/.test(s)) return 'floor-heating';
  if (/stepline|nosing|stepnose|stair (tread|nos)|\btread\b|\briser\b/.test(s)) return 'stair-treads-nosing';
  if (/edge protector|\bprot pro\b|balc|cubeline|floor accent|quarter circle|\breducer\b|expansion ?(joint|jnt)|movement joint|hd exp|\bprofile\b|\bjolly\b|schluter|transition|\bramp\b|skirting|\bdilex\b|sill profile|aqua ?ke?il|aq kl|\bkeil\b|deck edge|banding|gravel deck|pedestal|deco(line| strip)|covecover|corner pro|\bjoiner\b|crner angle|corner angle|aqua ?deco|aqua ?wall|fprofile|f-?profile|vscreed|v-?screed|exp ?joint/.test(s)) return 'transitions-moldings';
  if (/membrane|antifrac|anti ?fracture|waterproof|crack (buster|isolation)|decoupling|uncoupling|uncoup|self furred|netting|reinforcing fabric|\blath\b|\bdmc\b|\bprimer\b|\bpatch\b|skim|self ?level|\bslu\b|backer ?board|foam tile backer|\bscreed\b|moisture guard|preformed|pipe collar|shell tape|joint tape|interior tape|\bmesh\b|triboard|durock|structocrete|structural panel|cement board|permabase|xboard|provamat|whisper mat|gypsum|fiberock|rosin paper|jiffy seal|plastishield|surface ?protect|stayput|fracture guard|crack ?iso|nobleflex|prova ?joint|aquaseal|prova ?strip|skim coat|floor mud|liqui.?dam|hydraflex|encapsulator|board tape/.test(s)) return 'surface-prep-levelers';
  if (/\bcove\b|bullnose|\bsbn\b|listello|pencil liner|\bliner\b|v-?cap|mud ?cap|chair rail|out corner|outside corner|inside corner|vinyl.*corner|drain frame|wax bowl/.test(s)) return 'trim-accessories';
  if (/cleaner|\bclnr\b|krud|\bclean\b|kleen|disinfec|deepklenz|\bsealer\b|sealers|restore|\bpolish\b|degreaser|grout release|stonetech|aqua ?mix|nanoscrub|poultice|salt water|choice gold|\brevi\b|citrus|haze remover|stainblocker|stain ?blocker|enhancer sealer|shop towel|red shop/.test(s)) return 'care-maintenance';
  if (/thinset|thin ?set|\bmortar\b|adhesive|sikabond|sikatile|\bbond\b|matrix|\bepoxy\b|sealant|\bmastic\b|bedg|\brapid\b|\bmvis\b|\blht\b|lite set|premix|\bslc\b|st900|3701|caulk|omnigrip|versabond|prolite|proflex|veneer mtr|permacolor|fullflex|trilite|\bmrtr\b/.test(s)) return 'adhesives-sealants';
  if (/underlayment|sound guard|acoustic|\bcork\b|easy mat/.test(s)) return 'underlayment';
  if (/\bfloat\b|sponge|kneepad|kneeling|\bglove|knit latex|caddy|buckle|\bpads?\b|trowel|\bbucket\b|mixing|mixer|\bblades?\b|margin|\bnotch|leveling|twister|\bclip\b|\bwedge\b|\bspacers?\b|\bshim\b|\bedger\b|\bgrit\b|cap for|rai fix|\banchor\b|\bkit\b|\bsaw\b|cutter|scoring|\bvac\b|oscillat|\bdrill\b|chisel|bridge saw|spare part|suction|\brls\b|trolley|\btool\b|nozzle|magnet|\btowel|battery|\bwheel\b|scaling|python|nipper|\bcup\b|hammer|speed92|\btable\b|\bbit\b|caulking gun|pull bar|maverick|\bguide\b|lifting|transport|scraper|getter|applicator|rub stone|sand pad|\bknife\b|velcro|beating block|backer screw|contractor pencil|splash guard|grout bag|grout pen|grout getter|grout remover|grout replacement|grout shield|\bscrew\b|staples?|bull point|\bsds\b|holesaw|hole ?saw|box screed|\bhawk\b|mallet|\bimpact\b|\bdriver\b|\bpromo\b|fatmax|dewalt|pliers|grabo|lifter|corded|cordless|tripod|\bfan\b|speaker|\blevel\b|nailwad|\bstaple|slab cart|\bcart\b|\bbeater\b|gap closer|case only|\bwrench\b|\bplier|tile gap|\bclamp|knee pad|knives|chalk|tape measure|snips|plumb|cheesecloth|\bwipe|scoring wheel|tacker|puller|rubbing stone/.test(s)) return 'tools-trowels';
  return null;
}

const TILE_LEAVES = ['porcelain-tile','ceramic-tile','mosaic-tile','natural-stone','stacked-stone','porcelain-slabs'];

async function main() {
  console.log(`\n=== Emser Categorization Fix ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===\n`);
  const v = (await pool.query("SELECT id FROM vendors WHERE code='EMS'")).rows[0].id;
  const catId = {};
  for (const r of (await pool.query('SELECT id, slug FROM categories')).rows) catId[r.slug] = r.id;

  // Collection → its dominant field-tile leaf (porcelain > ceramic > natural-stone),
  // used to place parent-"tile" rows with the same collection.
  const sib = (await pool.query(
    `SELECT COALESCE(p.collection,'') collection, c.slug, count(*) n
       FROM products p JOIN categories c ON c.id=p.category_id
      WHERE p.vendor_id=$1 AND p.status='active' AND c.slug = ANY($2)
      GROUP BY 1,2`, [v, TILE_LEAVES])).rows;
  const collLeaf = new Map();
  const rank = { 'porcelain-tile':5,'ceramic-tile':4,'natural-stone':3,'stacked-stone':2,'porcelain-slabs':1,'mosaic-tile':0 };
  for (const r of sib) {
    if (!r.collection) continue;
    const cur = collLeaf.get(r.collection);
    if (!cur || rank[r.slug] > rank[cur]) collLeaf.set(r.collection, r.slug);
  }
  function leafForTile(name, collection) {
    const s = (name || '').toLowerCase();
    // Trim/edge pieces that leaked into the tile bucket, not field tile.
    if (/\bbeak\b|shark ?nose|\blistello\b|\bpencil\b|\bliner\b/.test(s)) return 'trim-accessories';
    if (/insert\/dot|\binsert\b/.test(s)) return 'mosaic-tile';    // decorative dot inserts
    if (/\bstacked\b|ledger/.test(s)) return 'stacked-stone';
    if (/\btrav\b|travertine|marble|limestone|slate|granite|onyx/.test(s)) return 'natural-stone';
    if (/\b(2cm|3cm)\b|\bslab\b/.test(s)) return 'porcelain-slabs';
    if (/\bmosaic\b/.test(s)) return 'mosaic-tile';
    const sibLeaf = collection && collLeaf.get(collection);
    if (sibLeaf && sibLeaf !== 'mosaic-tile') return sibLeaf;   // field leaf from siblings
    return 'porcelain-tile';                                    // default field leaf
  }

  // --- 1. NULL category ---
  const nulls = (await pool.query(
    `SELECT id, name FROM products WHERE vendor_id=$1 AND category_id IS NULL AND status='active'`, [v])).rows;
  const nullPlan = nulls.map(r => ({ ...r, to: classifyEmserSundry(r.name) }));
  const nullOk = nullPlan.filter(p => p.to);
  const nullMiss = nullPlan.filter(p => !p.to);

  // --- 2. parent "tile" bucket ---
  const tileRows = (await pool.query(
    `SELECT p.id, p.name, COALESCE(p.collection,'') collection FROM products p JOIN categories c ON c.id=p.category_id
      WHERE p.vendor_id=$1 AND c.slug='tile' AND p.status='active'`, [v])).rows;
  const tilePlan = tileRows.map(r => ({ ...r, to: leafForTile(r.name, r.collection) }));

  // --- 3. parent installation-sundries / hardware-specialty buckets → leaves ---
  const parentRows = (await pool.query(
    `SELECT p.id, p.name, c.slug cat FROM products p JOIN categories c ON c.id=p.category_id
      WHERE p.vendor_id=$1 AND c.slug IN ('installation-sundries','hardware-specialty') AND p.status='active'`, [v])).rows;
  const parentPlan = parentRows.map(r => ({ ...r, to: classifyEmserSundry(r.name) })).filter(p => p.to && p.to !== p.cat);
  const parentMiss = parentRows.length - parentPlan.length;

  // Report
  const byDest = {};
  nullOk.forEach(p => byDest[p.to] = (byDest[p.to]||0)+1);
  console.log(`── NULL → leaf: ${nullOk.length}/${nulls.length} classified ──`);
  Object.entries(byDest).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => console.log(`   ${k}: ${n}`));
  if (nullMiss.length) { console.log(`   unclassified (${nullMiss.length}):`); nullMiss.forEach(p => console.log(`     · ${p.name}`)); }

  const byLeaf = {};
  tilePlan.forEach(p => byLeaf[p.to] = (byLeaf[p.to]||0)+1);
  console.log(`\n── parent "tile" → leaf: ${tilePlan.length} ──`);
  Object.entries(byLeaf).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => console.log(`   ${k}: ${n}`));
  console.log('   details:');
  tilePlan.forEach(p => console.log(`     [${p.to}] ${p.name}${p.collection?`  (${p.collection})`:''}`));

  const byPar = {};
  parentPlan.forEach(p => byPar[p.to] = (byPar[p.to]||0)+1);
  console.log(`\n── parent sundry/hardware buckets → leaves: ${parentPlan.length} moved (${parentMiss} left in parent) ──`);
  Object.entries(byPar).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => console.log(`   ${k}: ${n}`));

  if (!APPLY) { console.log(`\n(DRY RUN — re-run with --apply)\n`); await pool.end(); return; }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of [...nullOk, ...tilePlan, ...parentPlan]) await client.query('UPDATE products SET category_id=$1 WHERE id=$2', [catId[p.to], p.id]);
    await client.query('COMMIT');
    console.log(`\nApplied: ${nullOk.length} NULL + ${tilePlan.length} parent-tile + ${parentPlan.length} parent-sundry → leaves.\n`);
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
