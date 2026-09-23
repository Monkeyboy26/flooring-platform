// Hand-authored OC cost guides (link-magnet content, Backlinks Track 3).
//
// Two flagship "cost" buying guides inserted as type='guide' landing_pages. Cost/permit
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
