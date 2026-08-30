// Central product → LEAF category classifier — the SINGLE source of truth for
// deciding a browsable leaf category from a product name/collection.
//
// WHY THIS EXISTS
// Every scraper used to carry its own copy of this logic (classifyEmserSundry,
// msi classifySundry, leafForEmserTile, NAME_CATEGORY_RULES, …). When a copy's
// keyword set missed, the product silently landed on a parent bucket (e.g.
// "Installation & Sundries") or NULL, the nightly quality rule warned, and it
// got hand-fixed vendor-by-vendor forever. This module ends that:
//
//   1. It is imported by the scrapers so the rules can't drift between copies.
//   2. It backs the choke-point safety net in scrapers/base.js::upsertProduct —
//      after any upsert, if the stored category is NULL or a parent, the net
//      runs classifyToLeaf() and forces a leaf. So NO scraper, present or
//      future, can leave a product uncategorised, regardless of its own logic.
//   3. The same module drives the one-time backfill and the quality rules, so
//      detection == fix == prevention (one ruleset, never out of sync).
//
// FAMILY SCOPING
// Rules are scoped to the product's parent FAMILY, because keyword sets that are
// safe in one family are dangerous in another. "Spring", "Pin", "Handle" are
// installer-tool words in the sundries bucket, but also perfectly good tile
// collection names — running the sundry rules over a product in the "tile"
// parent would misfile a "Spring Garden" tile as a tool. So a product in the
// "tile" parent only ever sees TILE_RULES; a product in a sundries/hardware
// parent (or NULL, which in this catalog is overwhelmingly accessories) only
// sees SUNDRY_RULES; material parents (luxury-vinyl, hardwood, …) get a small
// dedicated splitter and otherwise fall to their best-guess leaf.
//
// CONFIDENCE / REVIEW
// classifyToLeaf returns { slug, confident }. A keyword match is confident. When
// nothing matches but the family is known, it falls back to that family's
// best-guess leaf (PARENT_DEFAULT_LEAF) with confident=false — the caller marks
// products.category_needs_review=true so a human confirms the guess (never a
// silent NULL/parent). A NULL category whose name gives no signal at all can't
// be assigned a family and stays flagged for review.

// ── Parent (non-leaf) categories — products must never rest here ────────────
export const PARENT_SLUGS = new Set([
  'tile', 'luxury-vinyl', 'hardwood', 'countertops', 'laminate-flooring',
  'carpet', 'installation-sundries', 'hardware-specialty', 'hardscaping',
  'kitchen', 'bath',
]);

// Parents whose products are installer accessories → classified by SUNDRY_RULES.
const SUNDRY_PARENTS = new Set(['installation-sundries', 'hardware-specialty']);

// Best-guess leaf when the family is known but no keyword rule fires. Kept
// conservative: the product lands somewhere browsable and is flagged for review
// rather than shipped in a dead parent bucket.
export const PARENT_DEFAULT_LEAF = {
  'installation-sundries': 'tools-trowels',
  'hardware-specialty': 'functional-hardware',
  'tile': 'porcelain-tile',
  'luxury-vinyl': 'lvp-plank',
  'hardwood': 'engineered-hardwood',
  'laminate-flooring': 'laminate',
  'carpet': 'broadloom-carpet',
  'countertops': 'quartz-countertops',
  'hardscaping': 'pavers',
  'kitchen': 'kitchen-sinks',
  'bath': 'bath-accessories',
};

// ── SUNDRY_RULES: installer accessories, tools, setting materials ───────────
// Merged + de-duplicated from emser-832 (classifyEmserSundry / reclassifyEmserStray)
// and msi-unified (classifySundry / SUNDRY_RULES) plus the gap fixes found
// auditing the real stuck products. First match wins; ORDER IS LOAD-BEARING:
//   • A top guard sends "<x> adhesive" / caulk / silicone to adhesives before
//     the trim/wall-base/grout rules can grab the trim word.
//   • Specific accessory families (shower/heat/stair/underlayment/transitions/
//     trim/care) precede the generic catch-alls.
//   • tools-trowels precedes grout & adhesives so "grout float" / "grout bag" →
//     tools, not grout/adhesive (MSI convention). Safe here because SUNDRY_RULES
//     never run over tile/vinyl/wood product names (see family scoping above).
const SUNDRY_RULES = [
  // Glue guard: caulk / silicone / "<trim-word> adhesive" are always adhesives.
  { slug: 'adhesives-sealants', re: /\bcaulk\b|silicone|latasil|(cove ?base|wall ?base|tile|carpet|vinyl|floor|grout) adhesive/ },
  // Wall panels (specific brandable term — before generic tools). Exclude
  // "display" so a merchandising display box of wallpaper isn't a wall panel.
  { slug: 'wall-panels', re: /^(?!.*display).*(wallpaper|\bwpft\b|wall ?panel|slat ?panel|acoustic ?(slat|panel))/ },
  // Shower systems: niches, drains, pans, flanges, benches, preformed slopes
  { slug: 'shower-systems', re: /\bniche\b|recess ?it|\bcurb\b|probase|foam base|honeycomb|ctr drn|\bdrain\b|\bdrn\b|strainer|\bstrnr\b|\bstrain\b|\bshower\b|\bshr\b|hydro ?ban|hydroban|\bh ban\b|aqua ?shield|aquashld|thinline|soap dish|spice rack|kerdi|\btrough\b|nipple|cradle|\bcpe\b|pvashr|solutions drain|tile top|\bweep\b|noble ?deck|nobleseal|nobledeck|\bgrate\b|slpd|provadrain|prova ?board|prova\b|flexdeck|pan liner|\bbase only\b|slpe bse|\bbench\b|betterbench|invisabolt|\bpan\b|flange|richpan|proslope|multi ?preslope|multipreslope|protecto ?deck|chloroloy|chloraloy|seatin|slopd|linear pan|pipe seal|tapered ext|flat ext|pan ext|strainr/ },
  // Floor heating
  { slug: 'floor-heating', re: /nuheat|thermostat|\btherm\b|radiant|floor (heat|warm)|heat.*(mat|cable|wire|mesh)|\bheat mat\b|heat tile|provaflex|dual voltage|strataheat/ },
  // Stair treads & nosing
  { slug: 'stair-treads-nosing', re: /stepline|\bnosing\b|stepnose|stair ?(tread|nos)|\btread\b|\briser\b|step strip|antiskid|anti ?skid/ },
  // Underlayment / acoustic mat
  { slug: 'underlayment', re: /underlayment|underlay|sound ?guard|acoustic mat|\bcork\b|easy ?mat|whisper ?mat|eva silver|blue foam/ },
  // Transitions, profiles, reducers, edge protectors, expansion joints; anodized
  // / embossed / powder-coated aluminum trim profiles.
  { slug: 'transitions-moldings', re: /edge ?protector|\bprot pro\b|\bbalc\b|cubeline|floor accent|quarter circle|\breducer\b|expansion ?(joint|jnt)|movement joint|hd exp|exp ?joint|\bprofile\b|f-?profile|fprofile|\bjolly\b|schluter|transition|tile ?trans|slim easy trans|holding bar|\bramp\b|skirting|\bdilex\b|sill profile|aqua ?ke?il|aq kl|\bkeil\b|deck edge|banding|gravel deck|pedestal|deco(line| strip)|covecover|corner pro|\bjoiner\b|crner angle|corner angle|aqua ?deco|aqua ?wall|vscreed|v-?screed|end cap|metal end|\balum\b ?(andzd|anod|embsd|emboss|pwdr|powder|natural|brushed|brt)|\bandzd\b|progress ?profile|tile cap/ },
  // Wall base / cove base (Daltile convention: cove base → wall-base)
  { slug: 'wall-base', re: /\bwall ?base\b|cove ?base|\bsbn ?base\b|\bcove ?corner\b/ },
  // Tile trim: bullnose, pencil liner, v-cap, chair rail, corner pieces
  { slug: 'trim-accessories', re: /bullnose|\bsbn\b|listello|pencil ?liner|\bliner\b|v-?cap|mud ?cap|chair rail|out(side)? corner|in(side)? corner|\bcove\b|drain frame|wax bowl|\bbeak\b|shark ?nose|\bjolly\b/ },
  // Care & maintenance: cleaners, sealers, polish, haze/stain removers (incl.
  // StoneTech "St …" sealers, grout additives/colorants)
  { slug: 'care-maintenance', re: /cleaner|\bclnr\b|clnr ?seal|clnreseal|cln.?seal|krud|\bclean\b|kleen|disinfec|deepklenz|\bsealer\b|sealers|\bsealr\b|fin seal|res seal|cntop|\bseal ?&|restore|stonetech|aqua ?mix|nanoscrub|poultice|salt ?w(tr|ater)|choice gold|\brevi\b|citrus|haze remover|stainblocker|stain ?blocker|enhancer|shop towel|red shop|polishing (powder|set)|\bhd coat\b|grout ?up|colorant/ },
  // Tools & trowels: hand tools, PPE, spacers, clips, blades, machines, parts.
  // Before grout/adhesives so "grout float/bag" → tools.
  { slug: 'tools-trowels', re: /\bfloat\b|\bsponge\b|knee ?pad|kneeling|\bglove|knit latex|nitrile|softkneez|troxell|leather (large|reg)|\bcaddy\b|\bbuckle\b|\bpads?\b|trowel|\bbucket\b|wash bucket|mixing|\bmixer\b|\bpaddle\b|\brake\b|\bblades?\b|\bbld\b|diamond (mill|bl)|\bmill\b|\bmargin\b|\bnotch|leveling|twister|torque (tab|spinner)|\bclips?\b|\bwedges?\b|\bshim\b|\bedger\b|\bgrit\b|rai fix|\banchor\b|\bkit\b|\bsaws?\b|\bcutter\b|scoring|\bvac\b|vaccum|vacuum|oscillat|\bdrill\b|chisel|bridge saw|spare part|repair part|water pump|suction|powergrip|\brls\b|trolley|\btool\b|\bnozzle\b|\bmagnet\b|\btowel|battery|\bwheel\b|\broller\b|floor roller|scaling|python|nipper|\bcup\b|hammer|\btable\b|\bbit\b|caulking gun|pull ?bar|pry bar|wonder bar|maverick|\bguides?\b|lifting|lifter|transport|scraper|getter|applicator|rub(bing)? stone|sand ?(pad|paper)|\bknife\b|knives|velcro|beating block|beater|backer screw|\bpencil\b|splash guard|\bbag\b|\bpen\b|remover|replacement|repl.? handle|\bhandle\b|\btray\b|\bbracket\b|\bspring\b|\bpins?\b|elevation|holding|corbel|hand grip|\bsocket\b|retractable|sliding square|slim breaker|rubi|proedger|\bscrews?\b|staples?|bull point|\bsds\b|hole ?saw|holesaw|\bhawk\b|mallet|\bimpact\b|\bdriver\b|\bpromo\b|fatmax|dewalt|stanley|pliers?|grabo|corded|cordless|tripod|\bfan\b|speaker|\blevel\b|nailwad|slab ?(cart|trans|holder|dolly|lifter|clamp|hauler|handler)|\bcart\b|gap closer|case only|\bwrench\b|tile gap|\bclamp|chalk|tape ?measure|masking tape|inseam tape|snips|plumb|cheesecloth|\bwipe|scoring wheel|tacker|puller|tapping block|straight ?edge|vibrat(e|ing|or|ion)|\bgrind(e|er)|angle grind|\bpole\b|ezup|ez ?up|limiter|lateral stop|power ?lok|depth limiter|coverall|shoe ?cov|shoecovr|spike shoes?|scrub|dropcloth|drop cloth|counter brush|\bbrush\b|floor shell|floor guard|gauging|wander/ },
  // Grout (the material) — dedicated leaf. Sanded/unsanded is safe here (caulk
  // was already caught by the top guard). Includes known grout product lines.
  { slug: 'grout', re: /\bgrout\b|(non ?)?sanded|unsanded|\bcolorfast\b|flexcolor|permacolor|prism grout|ultracolor|keracolor|kerapoxy|opticolor|power grout|spectralock|sptlk|proprem|incolor/ },
  // Adhesives & sealants: thinset, mortar, mastic, epoxy, bonding. Includes
  // common Mapei/Laticrete setting-material lines that name no generic token.
  { slug: 'adhesives-sealants', re: /thin ?set|\bthinset\b|\bmortar\b|\bmortr\b|\bmrtr\b|thick ?bed|adhesive|\badh\b|sikabond|sikatile|\bbond\b|matrix|\bepoxy\b|sealant|\bmastic\b|\bbedg\b|\brapid\b|\bmvis\b|\blht\b|lite ?set|flex ?set|speed ?set|premix|\bslc\b|st900|st300|st350|3701|omnigrip|versabond|prolite|proflex|veneer mtr|fullflex|trilite|ult6|accucolor|fusion|millennium|permaflex|permalastic|signature|type ?1|flexera|kerabond|keralastic|ultraflex|ultralite|ultracontact|adesilex|granirapid|keraply|keraset|acrylic latex|\blatex\b|\bpsa\b/ },
  // Surface prep & levelers: membranes, backer board, self-leveler, patch,
  // primer, floor-protection paper/film, uncoupling mats, waterproofing.
  { slug: 'surface-prep-levelers', re: /membrane|\bmemb\b|antifrac|anti ?fracture|fracture ?(ban|free|guard|iso)|waterproof|watrprof|crack (buster|isolation|iso)|decoupling|uncoupling|uncoup|self ?furred|netting|reinforc\w* fabric|\bfabric\b|\bfbrc\b|mapelastic|planiprep|planipatch|novoplan|planibond|stratamat|customtech|techlevel|techpatch|petrotex|dress seal|noble ?seal|air (barrier|water)|hydro ?shield|builder board|hardi.?bkr|hardie ?bkr|hardibacker|prodeck|\blath\b|\bdmc\b|\bprimer\b|\bpatch\b|\bskim\b|skim coat|self ?level|self ?lvl|level set|\bslu\b|backer ?board|backer|foam tile backer|\bscreed\b|box screed|moisture (guard|barrier)|preformed|pipe collar|shell tape|joint tape|interior tape|board tape|seam tape|detail tape|sealing tape|aluminum tape|redgard|\bmesh\b|triboard|durock|structocrete|structural panel|cement board|permabase|permat|xboard|provamat|gypsum|fiberock|rosin paper|red rosin|builder.?s? paper|black paper|utility paper|\bxpaper\b|\bxplastic\b|ram board|tackback|masking film|protective film|\bfilm\b|floor shell|floor prep|jiffy seal|plastishield|surface ?protect|stayput|nobleflex|aquaseal|hydraflex|liqui.?dam|encapsulator|floor mud|\bpoly\b|\bmil\b clear|6 ?mil/ },
];

// ── TILE_RULES: sub-types for products in the generic "tile" parent ─────────
const TILE_RULES = [
  { slug: 'trim-accessories', re: /bullnose|\bbeak\b|shark ?nose|\blistello\b|pencil ?liner|\bv-?cap\b/ },
  { slug: 'stacked-stone', re: /\bledger\b|stack(ed)? ?stone|\bl panel\b|engineered stone|stone corner|rockmount/ },
  { slug: 'mosaic-tile', re: /\bmosaics?\b|penny ?round|hexagon mosaic|picket mosaic|insert\/dot|\binsert\b/ },
  { slug: 'natural-stone', re: /\btrav\b|travertine|marble|limestone|\bslate\b|onyx|\bgranite\b/ },
  { slug: 'porcelain-slabs', re: /\b(2cm|3cm)\b|\bslab\b/ },
  { slug: 'wood-look-tile', re: /wood ?look/ },
  { slug: 'pavers', re: /\bpaver\b|\bcoping\b|cobble|artificial ?turf/ },
];

// ── MATERIAL splitters for the flooring/countertop parents ──────────────────
function splitMaterial(family, s) {
  switch (family) {
    case 'luxury-vinyl':
      if (/\blvt\b|\btile\b|12 ?x ?24|18 ?x ?18|16 ?x ?16|12 ?x ?12|24 ?x ?24/.test(s)) return 'lvt-tile';
      if (/\bvct\b/.test(s)) return 'vct';
      if (/sheet ?vinyl/.test(s)) return 'sheet-vinyl';
      return 'lvp-plank';
    case 'hardwood':
      if (/\bsolid\b/.test(s)) return 'solid-hardwood';
      if (/waterproof|\bwpc\b|\bspc\b|hybrid|rigid/.test(s)) return 'waterproof-wood';
      return 'engineered-hardwood';
    case 'carpet':
      if (/carpet ?tile|\bmodular\b/.test(s)) return 'carpet-tile';
      return 'broadloom-carpet';
    case 'countertops':
      if (/quartzite/.test(s)) return 'quartzite-countertops';
      if (/\bgranite\b/.test(s)) return 'granite-countertops';
      if (/\bmarble\b/.test(s)) return 'marble-countertops';
      if (/soapstone/.test(s)) return 'soapstone-countertops';
      if (/porcelain|sintered/.test(s)) return 'porcelain-slabs';
      if (/prefab/.test(s)) return 'prefab-countertops';
      return 'quartz-countertops';
    case 'hardscaping':
      if (/\bcoping\b/.test(s)) return 'pavers';
      if (/turf/.test(s)) return 'artificial-turf';
      if (/travertine|marble|granite|\bstone\b/.test(s)) return 'natural-stone';
      return 'pavers';
    default:
      return null;
  }
}

function runRules(rules, s) {
  for (const r of rules) if (r.re.test(s)) return r.slug;
  return null;
}

// Return a leaf slug purely from a name string, scoped to a parent family.
// `family` is the current parent slug (null for uncategorised). Exposed mainly
// for tests/quality; callers usually go through classifyToLeaf.
export function classifyName(name, family = null) {
  const s = (name || '').toLowerCase();
  if (!s) return null;
  if (family === 'tile') return runRules(TILE_RULES, s);
  if (family === 'luxury-vinyl' || family === 'hardwood' || family === 'carpet'
      || family === 'countertops' || family === 'hardscaping') {
    return splitMaterial(family, s);
  }
  // sundries / hardware parents, and NULL (overwhelmingly accessories here)
  if (SUNDRY_PARENTS.has(family) || family == null) return runRules(SUNDRY_RULES, s);
  return null; // laminate/kitchen/bath: default-leaf only, no splitter
}

// Decide a leaf for a product. `currentSlug` is the product's present category
// slug (null or a parent, since this only runs on those). Returns
// { slug, confident }.
export function classifyToLeaf({ name, currentSlug }) {
  const kw = classifyName(name, currentSlug);
  if (kw) return { slug: kw, confident: true };
  if (currentSlug && PARENT_DEFAULT_LEAF[currentSlug]) {
    return { slug: PARENT_DEFAULT_LEAF[currentSlug], confident: false };
  }
  return { slug: null, confident: false }; // NULL family, no signal → stay flagged
}

// ── Pool-aware category cache + choke-point net ─────────────────────────────
let _cache = null; // { idToSlug:Map, slugToId:Map, parentIds:Set }

export async function loadCategoryCache(pool, { force = false } = {}) {
  if (_cache && !force) return _cache;
  const { rows } = await pool.query('SELECT id, slug, parent_id FROM categories');
  const idToSlug = new Map(), slugToId = new Map(), parentIds = new Set();
  for (const r of rows) {
    idToSlug.set(r.id, r.slug);
    slugToId.set(r.slug, r.id);
    if (r.parent_id) parentIds.add(r.parent_id);
  }
  _cache = { idToSlug, slugToId, parentIds };
  return _cache;
}

// The safety net. Given a product's name/collection and the category id it is
// (about to be) stored with, return { categoryId, slug, needsReview, changed }.
//   • Already on a leaf → changed:false, caller writes nothing.
//   • NULL or parent    → classify to a leaf; changed:true so caller persists
//                          category_id + category_needs_review.
// It never overrides a leaf the scraper already chose (fill NULL/parent only).
export async function netCategory(pool, { name, collection, categoryId }) {
  const { idToSlug, slugToId, parentIds } = await loadCategoryCache(pool);
  const isParent = !!(categoryId && parentIds.has(categoryId));
  if (categoryId && !isParent) {
    return { categoryId, slug: idToSlug.get(categoryId) || null, needsReview: false, changed: false };
  }
  const currentSlug = categoryId ? (idToSlug.get(categoryId) || null) : null;
  const text = [name, collection].filter(Boolean).join(' ');
  const { slug, confident } = classifyToLeaf({ name: text, currentSlug });
  const newId = slug ? (slugToId.get(slug) || null) : null;
  if (newId) return { categoryId: newId, slug, needsReview: !confident, changed: true };
  // Couldn't resolve any leaf (anonymous NULL) — keep as-is, flag for review.
  return { categoryId: categoryId || null, slug: currentSlug, needsReview: true, changed: true };
}
