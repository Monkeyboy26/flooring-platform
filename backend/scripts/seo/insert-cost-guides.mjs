// Hand-authored OC cost guides (link-magnet content, Backlinks Track 3).
//
// Flagship "cost" buying guides inserted as type='guide' landing_pages. Cost/permit
// pages earn editorial citations; these are written for Orange County specifically with
// typical market ranges (clearly framed as estimates, not our exact prices) so they read
// as genuinely useful reference content rather than filler.
//
//   node scripts/seo/insert-cost-guides.mjs [--dry-run]
//
// IDEMPOTENT: upserts on (type,slug). content_status='reviewed' so the AI generator never
// overwrites this hand-authored copy. Safe to re-run.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDES = [
  {
    slug: 'cost-to-install-hardwood-floors-orange-county',
    title: 'Cost to Install Hardwood Floors in Orange County (2026)',
    h1: 'How Much Does Hardwood Flooring Cost in Orange County?',
    meta_title: 'Cost to Install Hardwood Floors in Orange County (2026) | Roma Flooring Designs',
    meta_description: 'What hardwood flooring costs installed in Orange County in 2026 — material and labor per square foot, engineered vs. solid, subfloor prep, and real project examples. Free local estimates.',
    intro_html: `<p><strong>In Orange County, installed hardwood flooring typically runs $9–$25 per square foot in 2026</strong> — roughly $9–$18/sq ft for engineered hardwood and $12–$25/sq ft for solid hardwood, materials and labor combined. A 500-square-foot living room usually lands between <strong>$4,500 and $12,500</strong> depending on the species, plank width, and how much subfloor prep the job needs.</p>
<p>Those are typical local ranges — the real number depends on the wood you choose, your subfloor, and site conditions. Below we break the cost down piece by piece so you can budget with confidence, and you can always <a href="/installation">request a free, no-obligation estimate</a> for exact pricing on your home.</p>`,
    content_html: `
<h2>Hardwood flooring cost breakdown (per square foot, installed)</h2>
<p>Most of your budget is split between the wood itself and the labor to install it. Here's what each part typically costs in the Orange County market:</p>
<table>
  <caption>Typical installed cost per square foot — Orange County, 2026</caption>
  <thead><tr><th>Component</th><th>Budget</th><th>Mid-range</th><th>Premium</th></tr></thead>
  <tbody>
    <tr><td>Engineered hardwood (material)</td><td>$4–$6</td><td>$6–$9</td><td>$9–$15+</td></tr>
    <tr><td>Solid hardwood (material)</td><td>$6–$8</td><td>$8–$12</td><td>$12–$20+</td></tr>
    <tr><td>Installation labor</td><td>$3–$5</td><td>$5–$7</td><td>$7–$10</td></tr>
    <tr><td>Subfloor prep / leveling</td><td>$0–$1</td><td>$1–$2</td><td>$2–$4</td></tr>
    <tr><td>Old floor removal &amp; disposal</td><td>$1–$2</td><td>$2–$3</td><td>$3–$4</td></tr>
  </tbody>
</table>
<div class="guide-callout"><p><strong>Rule of thumb:</strong> for a straightforward installation over a clean, level subfloor, budget about <strong>$9–$18 per square foot for engineered</strong> and <strong>$12–$25 for solid hardwood</strong>, all in.</p></div>

<h2>Engineered vs. solid hardwood: cost and value</h2>
<p>Engineered hardwood — a real wood veneer over a plywood core — is the more popular choice in Orange County and usually the more economical one to install. It's dimensionally stable in our dry-then-humid coastal swings, works over concrete slabs (common in SoCal homes), and can float, glue down, or nail down.</p>
<p>Solid hardwood costs more up front and in labor (it must be nailed to a wood subfloor), but it can be sanded and refinished multiple times over decades. If you're staying in the home long-term and have a suitable subfloor, that refinishing headroom can make solid the better lifetime value. <a href="/guides/engineered-vs-solid-hardwood">See our full engineered vs. solid comparison</a>.</p>

<h2>What drives the price up or down</h2>
<ul>
  <li><strong>Species &amp; grade:</strong> domestic oak and maple are the value baseline; hickory, walnut, and exotic or wide-plank/character-grade wood cost more.</li>
  <li><strong>Plank width &amp; finish:</strong> wide planks, wire-brushed textures, and premium factory finishes carry a premium over standard strip flooring.</li>
  <li><strong>Subfloor condition:</strong> concrete slabs may need moisture mitigation; uneven subfloors need leveling. This is the most common source of "surprise" cost.</li>
  <li><strong>Installation method:</strong> floating floors are quickest and cheapest; glue-down and nail-down cost more in labor.</li>
  <li><strong>Layout complexity:</strong> stairs, diagonal or herringbone patterns, transitions, and lots of small rooms/closets add labor.</li>
  <li><strong>Tear-out:</strong> removing and hauling away old flooring (especially glued tile or multiple layers) adds to the total.</li>
</ul>

<h2>Real project examples</h2>
<table>
  <caption>Estimated installed cost by project size — Orange County, 2026</caption>
  <thead><tr><th>Project</th><th>Area</th><th>Engineered</th><th>Solid</th></tr></thead>
  <tbody>
    <tr><td>Bedroom</td><td>~200 sq ft</td><td>$1,800–$3,600</td><td>$2,400–$5,000</td></tr>
    <tr><td>Living room</td><td>~500 sq ft</td><td>$4,500–$9,000</td><td>$6,000–$12,500</td></tr>
    <tr><td>Main floor</td><td>~1,000 sq ft</td><td>$9,000–$18,000</td><td>$12,000–$25,000</td></tr>
    <tr><td>Whole home</td><td>~2,000 sq ft</td><td>$18,000–$36,000</td><td>$24,000–$50,000</td></tr>
  </tbody>
</table>
<p>Ranges assume a standard installation with typical prep. Stairs, patterned layouts, and extensive subfloor work are additional. Want a firm number? <a href="/installation">Book a free in-home estimate</a> and we'll measure and price your exact project.</p>

<h2>Why hardwood costs what it does in Orange County</h2>
<p>Labor rates here reflect Southern California's cost of living and the licensed, insured crews that quality installations require. Slab-on-grade construction is common locally, which can mean added moisture testing or a floating/glue-down approach on concrete. The upside: professional installation protects your investment and your manufacturer's warranty — most warranties require it.</p>

<h2>How to save without cutting corners</h2>
<ul>
  <li><strong>Choose engineered over solid</strong> where refinishing headroom isn't a priority — you keep the real-wood look for less.</li>
  <li><strong>Buy material and installation together</strong> from one source so nothing gets marked up twice and accountability stays in one place.</li>
  <li><strong>Prep the space</strong> (clear furniture, remove old base) yourself where you're able.</li>
  <li><strong>Do adjacent rooms at once</strong> — mobilizing a crew once is cheaper per square foot than repeat visits.</li>
</ul>
<p>Ready to see options? <a href="/shop?category=hardwood">Browse hardwood flooring</a> in our catalog, or visit our Anaheim showroom at 1440 S. State College Blvd #6M.</p>
`,
    footer_html: `<p><em>Figures are typical Orange County market ranges for 2026 and are provided for planning only — they are not a quote. Actual cost depends on material selection, subfloor condition, and site specifics. For exact pricing, <a href="/installation">request a free estimate</a> or call (714) 999-0009. Roma Flooring Designs is licensed, bonded, and insured (CA Lic #830966).</em></p>`,
    faq: [
      ['How much does it cost to install hardwood floors in Orange County?', 'In 2026, installed hardwood flooring in Orange County typically runs $9–$25 per square foot — about $9–$18/sq ft for engineered and $12–$25/sq ft for solid hardwood, materials and labor combined. A 500 sq ft room usually falls between $4,500 and $12,500.'],
      ['Is engineered or solid hardwood cheaper to install?', 'Engineered hardwood is usually cheaper to buy and install. It can float or glue down over concrete slabs (common in SoCal), while solid hardwood must be nailed to a wood subfloor, which adds labor. Solid costs more up front but can be refinished more times over its life.'],
      ['What adds the most to hardwood installation cost?', 'The biggest cost drivers are the wood species and grade, subfloor prep (leveling and moisture mitigation on concrete slabs), removal of old flooring, and layout complexity such as stairs or herringbone patterns.'],
      ['Does the price include removing my old floor?', 'Tear-out and disposal of existing flooring is usually a separate line item, roughly $1–$4 per square foot depending on what\'s being removed. We itemize it clearly in every estimate.'],
      ['Do you provide free estimates in Orange County?', 'Yes. Roma Flooring Designs provides free, no-obligation in-home estimates throughout Orange County from our Anaheim showroom. Call (714) 999-0009 or request one online.'],
    ],
    related: ['hardwood', 'engineered-hardwood', 'solid-hardwood', 'laminate'],
  },
  {
    slug: 'bathroom-remodel-cost-anaheim-orange-county',
    title: 'Bathroom Remodel Cost in Anaheim & Orange County (2026)',
    h1: 'How Much Does a Bathroom Remodel Cost in Anaheim & Orange County?',
    meta_title: 'Bathroom Remodel Cost in Anaheim & Orange County (2026) | Roma Flooring Designs',
    meta_description: 'What a bathroom remodel costs in Anaheim and Orange County in 2026 — full cost breakdown by component, budget vs. luxury tiers, cost by bathroom size, permit requirements, and timeline. Free estimates.',
    intro_html: `<p><strong>A bathroom remodel in Anaheim and Orange County typically costs $12,000–$35,000 in 2026</strong>, with most mid-range projects landing around <strong>$18,000–$28,000</strong>. A small guest bath with standard finishes can start near $8,000–$15,000, while a large primary suite with high-end tile, stone, and custom cabinetry can run $40,000 or more.</p>
<p>Where you land depends on the size of the room, the finishes you choose, and how much plumbing, electrical, and layout change is involved. Below is a component-by-component breakdown for the local market, plus what to know about Anaheim permits. For an exact figure, <a href="/installation">request a free estimate</a> — we design, supply, and install with one licensed crew.</p>`,
    content_html: `
<h2>Bathroom remodel cost by budget tier</h2>
<table>
  <caption>Typical full-bathroom remodel cost — Anaheim &amp; Orange County, 2026</caption>
  <thead><tr><th>Tier</th><th>Typical cost</th><th>What it includes</th></tr></thead>
  <tbody>
    <tr><td>Budget / refresh</td><td>$8,000–$15,000</td><td>New tile floor, tub/shower surround, vanity, toilet, fixtures — standard finishes, same layout.</td></tr>
    <tr><td>Mid-range</td><td>$18,000–$28,000</td><td>Porcelain or ceramic tile, quartz vanity top, tiled shower with glass, quality fixtures, lighting, some layout tweaks.</td></tr>
    <tr><td>High-end / primary suite</td><td>$35,000–$60,000+</td><td>Natural stone, custom cabinetry, curbless or steam shower, freestanding tub, heated floors, moved plumbing.</td></tr>
  </tbody>
</table>

<h2>Cost breakdown by component</h2>
<p>A remodel is the sum of its parts. Here's roughly how the budget splits on a typical mid-range Orange County bathroom:</p>
<table>
  <caption>Component cost ranges — mid-range bathroom, 2026</caption>
  <thead><tr><th>Component</th><th>Typical cost</th></tr></thead>
  <tbody>
    <tr><td>Demolition &amp; disposal</td><td>$500–$2,000</td></tr>
    <tr><td>Plumbing (fixtures/rough-in)</td><td>$1,000–$5,000</td></tr>
    <tr><td>Electrical &amp; lighting</td><td>$500–$2,500</td></tr>
    <tr><td>Tile &amp; flooring (material + install)</td><td>$1,500–$6,000</td></tr>
    <tr><td>Shower / tub &amp; glass</td><td>$2,000–$9,000</td></tr>
    <tr><td>Vanity &amp; countertop</td><td>$1,200–$5,000</td></tr>
    <tr><td>Fixtures, faucets &amp; hardware</td><td>$500–$3,000</td></tr>
    <tr><td>Paint, trim &amp; finishing</td><td>$500–$1,500</td></tr>
    <tr><td>Permits (when required)</td><td>$250–$1,500</td></tr>
  </tbody>
  <tfoot><tr><td>Typical mid-range total</td><td>$18,000–$28,000</td></tr></tfoot>
</table>
<div class="guide-callout"><p><strong>Labor</strong> generally accounts for 40–65% of a bathroom remodel. Using one crew for tile, countertops, and cabinetry — rather than coordinating separate trades — keeps labor efficient and accountability in one place.</p></div>

<h2>Cost by bathroom size</h2>
<table>
  <caption>Estimated remodel cost by bathroom size — Orange County, 2026</caption>
  <thead><tr><th>Bathroom</th><th>Approx. size</th><th>Standard finishes</th><th>Premium finishes</th></tr></thead>
  <tbody>
    <tr><td>Powder room / half bath</td><td>~20 sq ft</td><td>$5,000–$10,000</td><td>$10,000–$18,000</td></tr>
    <tr><td>Guest / hall bath</td><td>~40 sq ft</td><td>$10,000–$18,000</td><td>$20,000–$32,000</td></tr>
    <tr><td>Primary bath</td><td>~80–120 sq ft</td><td>$20,000–$35,000</td><td>$40,000–$65,000+</td></tr>
  </tbody>
</table>

<h2>Do you need a permit to remodel a bathroom in Anaheim?</h2>
<p>Generally, <strong>yes — a permit is required when your remodel involves plumbing, electrical, or structural changes</strong>, which most full bathroom remodels do. Purely cosmetic work — painting, swapping a faucet or vanity like-for-like, or replacing a toilet in the same spot — often does not require a permit.</p>
<p>You typically need a permit from the City of Anaheim Building Division when you:</p>
<ul>
  <li>Move or add plumbing (relocating a sink, toilet, or shower drain)</li>
  <li>Add or move electrical circuits, outlets, or lighting</li>
  <li>Remove or alter walls, or change the room's footprint</li>
  <li>Replace a tub with a tile shower (new waterproofing and often new plumbing)</li>
</ul>
<p>Permit fees for a bathroom typically run a few hundred dollars up to around $1,500 depending on scope. Requirements and fees change, so confirm your specific project with the City of Anaheim Building Division before you start (other Orange County cities have their own building departments with similar rules). A licensed contractor normally pulls the permits and schedules inspections for you — we handle that as part of the job.</p>

<h2>How to control your remodel budget</h2>
<ul>
  <li><strong>Keep the existing layout</strong> where possible — moving plumbing is one of the biggest cost multipliers.</li>
  <li><strong>Mix finishes strategically:</strong> splurge on a feature wall or the vanity top and use quality standard tile elsewhere.</li>
  <li><strong>Choose porcelain over natural stone</strong> for wet areas if budget is tight — it's durable, water-resistant, and lower-maintenance.</li>
  <li><strong>Buy materials and installation together</strong> so selections stay coordinated and nothing is double-marked-up.</li>
</ul>
<p>Explore materials to get a feel for your finishes: <a href="/shop?category=tile">tile</a>, <a href="/shop?category=natural-stone">natural stone</a>, <a href="/shop?category=quartz-countertops">quartz countertops</a>, and <a href="/shop?category=vanities">vanities</a>. Or see our <a href="/cabinets">custom cabinet options</a>.</p>

<h2>How long does a bathroom remodel take?</h2>
<p>A standard bathroom remodel usually takes <strong>2–4 weeks</strong> of active work once materials are on hand, plus lead time for ordering finishes and, when required, permit approval. Larger primary-suite remodels with custom cabinetry or moved plumbing can run 5–8 weeks. We give you a firm timeline with your quote.</p>
`,
    footer_html: `<p><em>Figures are typical Anaheim / Orange County market ranges for 2026 and are for planning only — they are not a quote, and permit requirements and fees are set by your city and can change. Always confirm permit needs with the City of Anaheim Building Division (or your local building department) before starting. For exact pricing on your bathroom, <a href="/installation">request a free estimate</a> or call (714) 999-0009. Roma Flooring Designs is licensed, bonded, and insured (CA Lic #830966).</em></p>`,
    faq: [
      ['How much does a bathroom remodel cost in Anaheim?', 'In 2026, a bathroom remodel in Anaheim and Orange County typically costs $12,000–$35,000, with most mid-range projects around $18,000–$28,000. Small guest baths can start near $8,000–$15,000, and large primary suites with high-end finishes can exceed $40,000.'],
      ['What is the most expensive part of a bathroom remodel?', 'Labor is the largest share (about 40–65% of the total), and among materials the shower/tub and tiling, then cabinetry and countertops, tend to cost the most. Moving plumbing is the single biggest cost multiplier.'],
      ['Do I need a permit to remodel a bathroom in Anaheim?', 'Usually yes if the work involves plumbing, electrical, or structural changes — which most full remodels do. Cosmetic swaps like paint or a like-for-like faucet often don\'t. Confirm your project with the City of Anaheim Building Division; a licensed contractor typically pulls permits for you.'],
      ['How long does a bathroom remodel take?', 'A standard bathroom remodel takes about 2–4 weeks of active work once materials arrive, plus ordering and permit lead time. Larger primary-suite remodels can take 5–8 weeks.'],
      ['Can one company do the tile, countertops, and cabinets?', 'Yes. Roma Flooring Designs designs, supplies, and installs the full remodel — flooring, tile, countertops, and cabinetry — with one licensed crew, which keeps labor efficient and accountability in one place.'],
    ],
    related: ['tile', 'natural-stone', 'quartz-countertops', 'vanities'],
  },
  {
    slug: 'tile-installation-cost-orange-county',
    title: 'Tile Installation Cost in Orange County (2026)',
    h1: 'How Much Does Tile Installation Cost in Orange County?',
    meta_title: 'Tile Installation Cost in Orange County (2026) | Roma Flooring Designs',
    meta_description: 'What tile installation costs in Orange County in 2026 — labor and material per square foot, floors vs. showers and backsplashes, what drives the price, and real project examples. Free local estimates.',
    intro_html: `<p><strong>In Orange County, installed floor tile typically runs $10–$25 per square foot in 2026</strong> — roughly $6–$14/sq ft for professional labor plus $2–$10/sq ft for the tile itself and another $1.50–$3 for setting materials. A straightforward 250-square-foot kitchen floor in standard porcelain usually lands between <strong>$2,500 and $4,500</strong>, while large-format tile, natural stone, or heavy prep can push a project toward the top of the range.</p>
<p>Showers and backsplashes price differently than floors — they're waterproofing and detail work, quoted by the project more than the square foot. Below we break down both for the local market so you can budget with confidence, and you can always <a href="/installation">request a free, no-obligation estimate</a> for exact pricing on your home.</p>`,
    content_html: `
<h2>Floor tile cost breakdown (per square foot, installed)</h2>
<p>Tile has more line items than most flooring because the installation is built up in layers — substrate, mortar, tile, grout. Here's what each part typically costs in the Orange County market:</p>
<table>
  <caption>Typical installed cost per square foot — Orange County, 2026</caption>
  <thead><tr><th>Component</th><th>Budget</th><th>Mid-range</th><th>Premium</th></tr></thead>
  <tbody>
    <tr><td>Tile (porcelain/ceramic material)</td><td>$2–$4</td><td>$4–$8</td><td>$8–$15+</td></tr>
    <tr><td>Setting materials (thinset, grout, backer/membrane)</td><td>$1.50–$2</td><td>$2–$2.50</td><td>$2.50–$3</td></tr>
    <tr><td>Installation labor (field tile)</td><td>$6–$8</td><td>$8–$11</td><td>$11–$16</td></tr>
    <tr><td>Subfloor prep / leveling</td><td>$0–$1</td><td>$1–$2</td><td>$2–$4</td></tr>
    <tr><td>Old floor removal &amp; disposal</td><td>$1–$2 (carpet/vinyl)</td><td>$2–$4 (old tile)</td><td>$4–$5 (mortar-bed tile)</td></tr>
  </tbody>
</table>
<div class="guide-callout"><p><strong>Rule of thumb:</strong> for standard-format porcelain over a clean, level slab, budget about <strong>$10–$16 per square foot all-in</strong>. Large-format tile, patterned layouts, and natural stone typically run <strong>$15–$28</strong>.</p></div>
<p>Not sure which tile you're pricing? Start with our <a href="/guides/how-to-choose-porcelain-tile">porcelain tile buying guide</a> — the material you choose sets the baseline for everything below.</p>

<h2>Showers, tub surrounds &amp; backsplashes</h2>
<p>Vertical and wet-area tile is detail work: waterproofing, slopes, cuts around valves and niches, and small-format setting. That's why it's priced per project rather than per square foot:</p>
<table>
  <caption>Typical tiled wet-area project costs — Orange County, 2026</caption>
  <thead><tr><th>Project</th><th>Typical cost (labor + materials)</th><th>Notes</th></tr></thead>
  <tbody>
    <tr><td>Kitchen backsplash</td><td>$900–$2,500</td><td>30–60 sq ft; mosaics and intricate patterns at the high end</td></tr>
    <tr><td>Tub surround retile</td><td>$2,000–$4,500</td><td>Three walls to ~6 ft; includes backer and waterproofing</td></tr>
    <tr><td>Walk-in shower retile</td><td>$4,500–$9,000+</td><td>Full tear-out, new pan and waterproofing, walls, niche, mosaic floor</td></tr>
    <tr><td>Bathroom floor</td><td>$800–$2,000</td><td>40–80 sq ft; small rooms carry a per-job minimum</td></tr>
  </tbody>
</table>
<p>A proper shower rebuild spends a meaningful share of the budget on what you never see — the pan, slope, and waterproofing membrane. That's the part worth paying for; tile can be replaced, a failed pan means opening the whole thing up. Planning a bigger refresh? See our <a href="/guides/bathroom-remodel-cost-anaheim-orange-county">full bathroom remodel cost guide</a>.</p>

<h2>What drives tile installation cost up or down</h2>
<ul>
  <li><strong>Tile format:</strong> large-format tile (any edge 15"+) needs a flatter substrate and leveling systems — more prep and labor. Very small mosaics are also slower to set than standard field tile.</li>
  <li><strong>Layout pattern:</strong> diagonal, herringbone, and chevron layouts add roughly 10–20% to labor from extra cutting and layout time.</li>
  <li><strong>Porcelain vs. natural stone:</strong> stone costs more to cut, must be sealed, and often needs a more experienced setter — expect labor at the top of the range.</li>
  <li><strong>What's coming out:</strong> demoing old tile (especially a vintage mortar bed) is the most expensive tear-out in flooring; carpet or vinyl removal is cheap by comparison.</li>
  <li><strong>Slab condition:</strong> cracks call for crack-isolation membrane, and out-of-flat slabs need self-leveling underlayment — the most common source of "surprise" cost on SoCal concrete.</li>
  <li><strong>Room complexity:</strong> lots of doorways, angles, cabinets, and closets mean more cuts per square foot than one open room.</li>
</ul>

<h2>Real project examples</h2>
<table>
  <caption>Estimated installed cost by project size — Orange County, 2026</caption>
  <thead><tr><th>Project</th><th>Area</th><th>Standard porcelain</th><th>Large-format / stone</th></tr></thead>
  <tbody>
    <tr><td>Entry / laundry</td><td>~100 sq ft</td><td>$1,200–$1,800</td><td>$1,800–$2,800</td></tr>
    <tr><td>Kitchen floor</td><td>~250 sq ft</td><td>$2,500–$4,500</td><td>$4,000–$7,000</td></tr>
    <tr><td>Kitchen + family room</td><td>~600 sq ft</td><td>$6,000–$10,000</td><td>$9,500–$16,000</td></tr>
    <tr><td>Whole first floor</td><td>~1,200 sq ft</td><td>$12,000–$19,000</td><td>$18,000–$32,000</td></tr>
  </tbody>
</table>
<p>Ranges assume typical prep over a sound slab; tear-out of existing tile and extensive leveling are additional. <a href="/installation">Book a free in-home estimate</a> and we'll measure and price your exact project.</p>

<h2>Why tile costs more to install than LVP — and when it's worth it</h2>
<p>Tile is a masonry trade: the floor is built on site, layer by layer, by a setter whose skill determines whether those tight modern grout lines stay flat and straight. Vinyl plank clicks together in a fraction of the time, which is why its labor runs a third to half of tile's. What tile buys for the difference: decades of life instead of 10–20 years, total indifference to water and sun, and the look of real stone or concrete underfoot. On resale, permanent tile floors read as an upgrade; in rentals and flips, LVP's speed usually wins. It's the classic pay-once-versus-pay-again tradeoff.</p>

<h2>Do you need a permit to install tile in Orange County?</h2>
<p>For a straightforward <strong>like-for-like floor replacement, generally no</strong> — swapping flooring finishes is usually considered cosmetic work. A permit typically comes into play when the job goes beyond the finish: <strong>rebuilding a shower</strong> (new pan, waterproofing, or moved plumbing), altering walls, or adding electric floor heating. Requirements vary by city and change over time, so confirm your specific project with your city's building division — when a permit is needed, a licensed contractor pulls it and schedules inspections for you, and we handle that as part of the job.</p>

<h2>How to save without cutting corners</h2>
<ul>
  <li><strong>Choose porcelain over natural stone</strong> — today's stone-look porcelain delivers the look for less material cost, less labor, and zero sealing.</li>
  <li><strong>Stick to standard formats</strong> (12x24, 24x24) and straight-set layouts; save patterns for a small feature area like the backsplash.</li>
  <li><strong>Do adjacent rooms at once</strong> — mobilizing a tile crew once is cheaper per square foot than repeat visits.</li>
  <li><strong>Buy material and installation together</strong> from one source so nothing gets marked up twice and one company owns the result.</li>
  <li><strong>Order 10–15% overage up front</strong> from a single lot — see <a href="/guides/how-to-measure-a-room-for-flooring">how to measure a room for flooring</a> — so a future repair never depends on matching a discontinued tile.</li>
</ul>
<p>Ready to look at real options? Browse <a href="/shop?category=porcelain-tile">porcelain tile</a>, <a href="/shop?category=mosaic-tile">mosaics</a>, and <a href="/shop?category=natural-stone">natural stone</a>, or visit our Anaheim showroom at 1440 S. State College Blvd #6M.</p>

<h2>How long does tile installation take?</h2>
<p>A typical 250-square-foot floor takes <strong>3–5 working days</strong>: tear-out and prep, setting, then grouting after the mortar cures overnight — plan on staying off the floor until the grout has cured. A full shower rebuild runs <strong>1–2 weeks</strong> including waterproofing cure time and, when permitted, inspection. We give you a firm timeline with your quote.</p>
`,
    footer_html: `<p><em>Figures are typical Orange County market ranges for 2026 and are provided for planning only — they are not a quote. Actual cost depends on the tile you choose, substrate condition, and site specifics, and permit requirements are set by your city and can change. For exact pricing, <a href="/installation">request a free estimate</a> or call (714) 999-0009. Roma Flooring Designs is licensed, bonded, and insured (CA Lic #830966).</em></p>`,
    faq: [
      ['How much does tile installation cost per square foot in Orange County?', 'In 2026, installed floor tile in Orange County typically runs $10–$25 per square foot all-in — about $6–$14/sq ft for labor plus the tile and setting materials. Standard porcelain over a level slab sits near $10–$16; large-format tile, patterns, and natural stone run $15–$28.'],
      ['Why does tile cost more to install than vinyl plank?', 'Tile is skilled masonry work — substrate prep, mortar, layout, cutting, and grouting built up in layers on site — while vinyl plank clicks together quickly. Tile costs more up front but lasts decades, is fully waterproof and UV-proof, and typically reads as an upgrade at resale.'],
      ['Does large-format tile cost more to install?', 'Yes. Any tile with an edge 15 inches or longer requires a flatter substrate (often self-leveling underlayment) and tile-leveling systems to prevent lippage, which adds prep and labor — commonly a few dollars more per square foot than standard formats.'],
      ['How much does it cost to retile a shower in Orange County?', 'A full walk-in shower retile — tear-out, new pan and waterproofing, wall tile, niche, and a mosaic floor — typically runs $4,500–$9,000+ in 2026 depending on size and tile selection. A three-wall tub surround usually lands around $2,000–$4,500.'],
      ['How long does tile installation take?', 'A typical 250 sq ft floor takes about 3–5 working days including prep, setting, and grouting after overnight mortar cure. A full shower rebuild takes 1–2 weeks including waterproofing cure time and inspection when a permit is involved.'],
    ],
    related: ['tile', 'porcelain-tile', 'mosaic-tile', 'natural-stone'],
  },
  {
    slug: 'countertop-installation-cost-orange-county',
    title: 'Countertop Installation Cost in Orange County (2026)',
    h1: 'How Much Do New Countertops Cost in Orange County?',
    meta_title: 'Countertop Installation Cost in Orange County (2026) | Roma Flooring Designs',
    meta_description: 'What new countertops cost installed in Orange County in 2026 — quartz, granite, marble, quartzite, and porcelain slab per square foot, prefab vs. custom slab, and real kitchen examples. Free estimates.',
    intro_html: `<p><strong>In Orange County, new countertops typically cost $50–$120 per square foot installed in 2026</strong> — material, fabrication, and installation combined. For a standard kitchen with 45–55 square feet of counter space, that's roughly <strong>$2,500–$6,500</strong> for popular quartz or granite, and more for premium marble, quartzite, or waterfall details. Prefabricated countertops can bring a straightforward kitchen in for meaningfully less.</p>
<p>Countertops are quoted as one number, but the price is really three jobs — the slab, the fabrication, and the install — and each has its own levers. Below is how the local market prices them, material by material, so you can budget with confidence. For an exact figure, <a href="/installation">request a free estimate</a>, or bring your kitchen dimensions to our Anaheim showroom and we'll quote it from real slabs.</p>`,
    content_html: `
<h2>Countertop cost by material (per square foot, installed)</h2>
<table>
  <caption>Typical installed cost per square foot — Orange County, 2026</caption>
  <thead><tr><th>Material</th><th>Typical installed range</th><th>Care &amp; character</th></tr></thead>
  <tbody>
    <tr><td>Quartz (engineered)</td><td>$50–$100</td><td>No sealing, consistent patterns, the most popular choice; avoid direct hot pans</td></tr>
    <tr><td>Granite</td><td>$45–$100</td><td>Natural one-of-a-kind slabs, heat-tolerant; periodic sealing</td></tr>
    <tr><td>Porcelain slab</td><td>$60–$120</td><td>Thin, heat- and UV-proof, marble looks; great for outdoor kitchens and full-height backsplashes</td></tr>
    <tr><td>Quartzite</td><td>$70–$150</td><td>Natural stone harder than granite with marble-like veining; sealing required</td></tr>
    <tr><td>Marble</td><td>$60–$150+</td><td>The classic look; softer, etches with acids — best for baths and baking stations</td></tr>
  </tbody>
</table>
<div class="guide-callout"><p><strong>Rule of thumb:</strong> budget about <strong>$55–$75/sq ft installed for mid-range quartz or granite</strong> in Orange County. Premium slabs, waterfall edges, and full-height slab backsplashes are what push kitchens past $100/sq ft.</p></div>
<p>Torn between engineered and natural stone? Our <a href="/guides/quartz-vs-natural-stone-countertops">quartz vs. natural stone comparison</a> walks through durability, maintenance, and look in detail.</p>

<h2>What's inside the price</h2>
<p>A countertop quote bundles several distinct costs. Knowing the pieces makes competing bids comparable:</p>
<ul>
  <li><strong>Slab material</strong> — usually 40–60% of the total. The same color can vary widely by grade, lot, and brand.</li>
  <li><strong>Fabrication</strong> — templating, cutting, edge profiling, and polishing, plus cutouts: sink cutouts and cooktop cutouts typically add $100–$300 each.</li>
  <li><strong>Installation</strong> — delivery, setting, leveling, seaming, and securing; heavy 3cm stone takes a bigger crew.</li>
  <li><strong>Tear-out</strong> — removing and disposing of old tops usually runs $300–$800 for a typical kitchen (tile-over-mortar counters cost more to demo).</li>
  <li><strong>Plumbing</strong> — disconnecting and reconnecting the sink, faucet, and disposal is often a separate $150–$500 line, whether by the installer or your plumber.</li>
</ul>

<h2>Prefab vs. custom slab: the biggest lever on price</h2>
<p><strong>Prefabricated countertops</strong> — slabs pre-cut to standard depths with the front edge already finished — are a Southern California staple and the fastest way to cut the fabrication share of your bill. For a straightforward layout (standard 25.5" depth runs, common sink sizes, no waterfall), prefab granite or quartz can bring installed cost down toward the <strong>$40–$60/sq ft</strong> range.</p>
<p><strong>Custom slab fabrication</strong> buys you exact seam placement, book-matched veining, any edge profile, waterfall sides, and full choice of the slab yard. Kitchens with long runs, big islands, or dramatic stone are custom jobs by nature. Many of our projects mix the two — prefab in the laundry and baths, custom in the kitchen. <a href="/shop?category=prefab-countertops">Browse prefabricated countertops</a> to see what standard sizes cover.</p>

<h2>Real project examples</h2>
<table>
  <caption>Estimated installed cost by project — Orange County, 2026</caption>
  <thead><tr><th>Project</th><th>Counter area</th><th>Mid-range quartz/granite</th><th>Premium stone / details</th></tr></thead>
  <tbody>
    <tr><td>Bathroom vanity top</td><td>~10–15 sq ft</td><td>$600–$1,500</td><td>$1,500–$3,000</td></tr>
    <tr><td>Galley / condo kitchen</td><td>~30 sq ft</td><td>$1,800–$3,000</td><td>$3,000–$5,500</td></tr>
    <tr><td>Standard kitchen</td><td>~45–55 sq ft</td><td>$2,500–$5,500</td><td>$5,500–$10,000</td></tr>
    <tr><td>Large kitchen w/ island</td><td>~70–90 sq ft</td><td>$4,500–$9,000</td><td>$9,000–$18,000+</td></tr>
  </tbody>
</table>
<p>Ranges assume replacement on existing, level cabinets. Waterfall island sides, full-height slab backsplashes, and radius or laminated edges are the usual adders. <a href="/installation">Book a free estimate</a> for a measured number — small vanities often price by the piece rather than the foot.</p>

<h2>What drives countertop cost up or down</h2>
<ul>
  <li><strong>Slab grade and movement:</strong> dramatic veining, exotic quartzites, and designer quartz lines cost multiples of builder-grade colors in the same material.</li>
  <li><strong>Thickness:</strong> 3cm stone is the standard look and costs more than 2cm; porcelain runs thinner (12mm) with a built-up edge.</li>
  <li><strong>Edges and details:</strong> eased and bullnose edges are standard; ogee, mitered, and laminated edges add fabrication time. A waterfall side is priced like additional countertop plus two mitered joints.</li>
  <li><strong>Seams and layout:</strong> L-shapes and long runs that exceed one slab need seams — and matching veining across a seam takes more material and skill.</li>
  <li><strong>Backsplash choice:</strong> a 4" stone splash is cheap; full-height slab is dramatic but effectively doubles the visible stone. Tile is the middle path — see our <a href="/guides/kitchen-backsplash-tile-guide">backsplash tile guide</a>.</li>
  <li><strong>Sink style:</strong> undermount and farmhouse sinks need polished cutouts and support; drop-ins are simplest.</li>
</ul>

<h2>Do you need a permit to replace countertops?</h2>
<p>A like-for-like countertop swap is <strong>generally cosmetic work — no permit</strong> in most Orange County cities. Permits enter the picture when the project grows: moving or adding plumbing or gas (relocating a sink or switching cooktop fuel), adding island electrical outlets, or structural changes to cabinets and walls. Requirements vary by city and change over time, so confirm your project's specifics with your city's building division — when one is needed, we pull it as part of the job.</p>

<h2>How to save without cutting corners</h2>
<ul>
  <li><strong>Ask about prefab first</strong> — if your layout fits standard sizes, it's the single biggest saving available.</li>
  <li><strong>Put the drama where you see it:</strong> premium stone on the island, quieter quartz on perimeter runs.</li>
  <li><strong>Keep the sink and cooktop where they are</strong> — no new plumbing or electrical keeps the job cosmetic and the cost contained.</li>
  <li><strong>Choose a standard edge</strong> (eased or pencil) — modern kitchens favor them anyway.</li>
  <li><strong>Replace counters and backsplash together</strong> — demoing a backsplash later risks the new tops, and one mobilization is cheaper than two.</li>
</ul>
<p>See the options in person: <a href="/shop?category=quartz-countertops">quartz</a>, <a href="/shop?category=granite-countertops">granite</a>, <a href="/shop?category=quartzite-countertops">quartzite</a>, <a href="/shop?category=marble-countertops">marble</a>, and <a href="/shop?category=porcelain-slabs">porcelain slabs</a> — or pair new tops with <a href="/cabinets">custom cabinets</a>.</p>

<h2>How long does countertop replacement take?</h2>
<p>The install itself is usually <strong>one day</strong>. The full sequence — template after cabinets are final, fabrication, then install — typically runs <strong>1–3 weeks</strong> depending on the fabricator's queue and slab availability; prefab can move faster. Plan to be without a kitchen sink only between tear-out and install day, usually 24–48 hours when scheduling is tight. We give you a firm timeline with your quote.</p>
`,
    footer_html: `<p><em>Figures are typical Orange County market ranges for 2026 and are provided for planning only — they are not a quote. Actual cost depends on the slab you choose, layout, edge and backsplash details, and site specifics, and permit requirements are set by your city and can change. For exact pricing, <a href="/installation">request a free estimate</a> or call (714) 999-0009. Roma Flooring Designs is licensed, bonded, and insured (CA Lic #830966).</em></p>`,
    faq: [
      ['How much do new countertops cost in Orange County?', 'In 2026, installed countertops in Orange County typically run $50–$120 per square foot depending on material — about $2,500–$6,500 for a standard kitchen in mid-range quartz or granite. Premium marble, quartzite, waterfall edges, and full-height slab backsplashes push totals higher.'],
      ['Is quartz or granite cheaper to install?', 'They overlap heavily — both typically run $45–$100 per square foot installed in Orange County. Builder-grade granite is often the cheapest slab option, while designer quartz lines cost more; fabrication and install cost about the same for either.'],
      ['What are prefabricated countertops, and how much do they save?', 'Prefab countertops are slabs pre-cut to standard depths with the front edge already finished, so you skip most custom fabrication. For layouts that fit standard sizes, prefab granite or quartz can bring installed cost down toward $40–$60 per square foot.'],
      ['Does countertop replacement include removing the old counters?', 'Tear-out is usually a separate line item — typically $300–$800 for a standard kitchen, more for tile-over-mortar tops. Plumbing disconnect and reconnect for the sink and disposal is often itemized separately as well; we spell out both in every estimate.'],
      ['How long does it take to replace kitchen countertops?', 'Install day is usually a single day. End to end — templating, fabrication, install — plan on 1–3 weeks depending on slab availability and the fabrication queue; prefabricated tops can move faster. You\'re typically without a sink for only 24–48 hours.'],
    ],
    related: ['countertops', 'quartz-countertops', 'granite-countertops', 'porcelain-slabs'],
  },
];

async function upsertGuide(g) {
  const filter_json = { faq: g.faq, related: g.related };
  const sql = `
    INSERT INTO landing_pages
      (type, slug, title, h1, meta_title, meta_description, intro_html, content_html, footer_html,
       filter_json, is_indexable, content_status, created_at, updated_at)
    VALUES
      ('guide', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, true, 'reviewed', now(), now())
    ON CONFLICT (slug) DO UPDATE SET
      title = EXCLUDED.title, h1 = EXCLUDED.h1, meta_title = EXCLUDED.meta_title,
      meta_description = EXCLUDED.meta_description, intro_html = EXCLUDED.intro_html,
      content_html = EXCLUDED.content_html, footer_html = EXCLUDED.footer_html,
      filter_json = EXCLUDED.filter_json, is_indexable = true, content_status = 'reviewed',
      updated_at = now()
    RETURNING slug, (xmax = 0) AS inserted`;
  const params = [g.slug, g.title, g.h1, g.meta_title, g.meta_description,
    g.intro_html, g.content_html, g.footer_html, JSON.stringify(filter_json)];
  if (DRY) { console.log(`[dry-run] would upsert guide: ${g.slug}`); return; }
  const res = await pool.query(sql, params);
  const row = res.rows[0];
  console.log(`${row.inserted ? 'INSERTED' : 'UPDATED '} guide: /guides/${row.slug}`);
}

(async () => {
  try {
    for (const g of GUIDES) await upsertGuide(g);
    console.log(`\nDone. ${GUIDES.length} cost guide(s) processed.`);
  } catch (e) {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
