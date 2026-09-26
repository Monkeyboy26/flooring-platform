// Hand-authored pillar guide: The Best Waterproof Flooring for Any Room.
//
// Replaces the short AI-generated body on /guides/best-waterproof-flooring with a
// comprehensive hand-written guide (~1,700 words). Same standard as the other
// insert-*-guide scripts: honest about marketing claims (waterproof plank vs.
// waterproof floor), grounded in real specs, market ranges framed as estimates.
//
//   node scripts/seo/insert-waterproof-flooring-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'best-waterproof-flooring',
  title: 'The Best Waterproof Flooring for Any Room',
  h1: 'The Best Waterproof Flooring for Any Room',
  meta_title: 'The Best Waterproof Flooring for Any Room (Honest Guide) | Roma Flooring Designs',
  meta_description: 'Which floors are truly waterproof and which just claim to be — porcelain tile, LVP, sheet vinyl, and water-resistant laminate compared, room by room, with real costs.',
  intro_html: `<p><strong>"Waterproof" is the most used — and most abused — word in flooring.</strong> Strip away the marketing and there are really only two families of floor that genuinely don't care about water: <strong>tile</strong> and <strong>vinyl</strong>. Everything else, from "water-resistant" laminate to sealed hardwood, is playing defense on a clock.</p>
<p>This guide sorts the truly waterproof from the merely water-resistant, explains the one distinction most buyers miss — a waterproof <em>product</em> is not a waterproof <em>floor</em> — and matches the right option to each room. See everything side by side at <a href="/installation">our Anaheim showroom</a>, where we'll quote material or supply-and-install for your exact rooms.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Porcelain tile</strong> is the most waterproof floor you can buy — the only one we'll put inside a shower. <strong>LVP</strong> is the waterproof floor that looks and feels like wood, and the default pick for kitchens and whole-house plans. <strong>Sheet vinyl</strong> is the budget sleeper for laundry rooms — one piece, almost no seams. Everything marketed as "water-resistant" belongs only in rooms that stay dry.</p></div>

<h2>Waterproof vs. water-resistant: what the labels actually mean</h2>
<p><strong>Waterproof</strong> means the material itself is unaffected by water no matter how long the exposure — porcelain, ceramic, and vinyl simply don't absorb it. <strong>Water-resistant</strong> means the floor can shrug off surface water for a limited time before damage begins; with laminate that's typically a 24–72 hour surface-spill warranty, and with hardwood it's however long the finish keeps water out of the wood.</p>
<p>And one distinction matters more than either label: <strong>a waterproof plank is not a waterproof floor.</strong> Water that reaches a floating floor's edges — at walls, doorways, tubs, and toilets — can still find the subfloor underneath. The plank survives; your subfloor may not. That's why wet rooms deserve either tile (where the assembly itself can be waterproofed) or a vinyl installation detailed with sealed perimeters. More on that below.</p>

<h2>The contenders, ranked</h2>
<table>
  <caption>How the main flooring types handle water</caption>
  <thead><tr><th>Floor</th><th>Water rating</th><th>Best use</th></tr></thead>
  <tbody>
    <tr><td>Porcelain / ceramic tile</td><td>Waterproof — including showers</td><td>Bathrooms, showers, laundry, kitchens, outdoors</td></tr>
    <tr><td>LVP (rigid-core vinyl plank)</td><td>Waterproof plank</td><td>Kitchens, whole-house, rentals, baths</td></tr>
    <tr><td>Sheet vinyl</td><td>Waterproof, nearly seamless</td><td>Laundry, utility, budget baths</td></tr>
    <tr><td>Natural stone</td><td>Waterproof if sealed on schedule</td><td>Baths and entries, with maintenance</td></tr>
    <tr><td>Laminate ("water-resistant")</td><td>Surface spills only, 24–72 hr</td><td>Dry rooms: living, bedrooms, offices</td></tr>
    <tr><td>Engineered hardwood</td><td>Water-resistant finish at best</td><td>Living areas away from water</td></tr>
  </tbody>
</table>

<h2>Porcelain tile: the gold standard</h2>
<p>Porcelain absorbs 0.5% or less of its weight in water — effectively nothing — which is why it's the only flooring on this list rated for the inside of a shower. It's also immune to sun, heat, pet claws, and time; a properly installed tile floor is a decades-long decision. Two honest caveats: standard cement grout is <em>not</em> waterproof (water passing through grout doesn't hurt the tile, and in true wet areas the waterproofing membrane under the tile does the real work — that's normal and by design), and tile is the most expensive of these floors to install because it's built on site, layer by layer.</p>
<p>Deep dives: <a href="/guides/how-to-choose-porcelain-tile">how to choose porcelain tile</a> and <a href="/guides/choosing-bathroom-floor-tile">choosing bathroom floor tile</a>.</p>

<h2>LVP: waterproof that looks like wood</h2>
<p>Rigid-core luxury vinyl plank is the reason "waterproof flooring" became a category. The plank is 100% polymer — a dishwasher leak or a weekend pet accident is a cleanup, not a claim — and modern lines carry convincing wood visuals with attached acoustic pads. It's also the practical answer when you want <strong>one floor flowing through an open plan that includes the kitchen</strong>.</p>
<p>Buy it by the spec, not the brochure: a <strong>20 mil or thicker wear layer</strong> for busy households and pets, UV-stable lines for sun-blasted rooms, and honest expectations — vinyl can dent under heavy point loads, and it never quite feels like hardwood underfoot. For the full comparison against its main rival, see <a href="/guides/lvp-vs-laminate">LVP vs. laminate</a>.</p>

<h2>Sheet vinyl: the forgotten workhorse</h2>
<p>Sheet vinyl gets no marketing love, but it has one structural advantage nothing else on this list can match: it comes in rolls up to 12 feet wide, so a laundry room or small bath is often covered in <strong>a single piece with zero seams</strong> — nowhere for water to sneak through. Modern fiberglass-backed sheet lays flat, feels cushioned, and costs less than almost anything else installed. The tradeoffs: fewer premium looks, and repairs mean patching rather than swapping a plank.</p>

<h2>The "water-resistant" asterisk: laminate and wood</h2>
<p>Water-resistant laminate is a real improvement — quality lines now survive a surface spill overnight — but the HDF wood-fiber core swells permanently if water reaches a seam or edge, and no warranty covers that. Hardwood, engineered or solid, is protected only as long as its finish film is intact. Neither belongs in a bathroom or laundry room, full stop; in kitchens they're a calculated risk some homeowners accept for the look. Keep them where they excel: <a href="/guides/engineered-vs-solid-hardwood">living areas and bedrooms</a>.</p>

<h2>The best waterproof floor, room by room</h2>
<ul>
  <li><strong>Bathrooms:</strong> porcelain tile first — it handles the floor <em>and</em> the shower, and mosaics solve the shower pan. LVP is a fine budget floor for the dry zones of a bath.</li>
  <li><strong>Kitchens:</strong> LVP or tile. Tile wins on lifespan and looks with an island statement floor; LVP wins on comfort, budget, and open-plan continuity.</li>
  <li><strong>Laundry / mudroom:</strong> tile or sheet vinyl. This is the room where a seamless sheet or a tiled floor with a floor drain earns its keep.</li>
  <li><strong>Whole-house / open concept:</strong> LVP — one waterproof product everywhere, kitchen included. Wood-look porcelain is the premium version of the same idea.</li>
  <li><strong>Rentals:</strong> 20-mil LVP. Tenant-proof, water-forgiving, planks swap out.</li>
  <li><strong>Outdoors / patios:</strong> porcelain rated for exterior use — nothing else on this list goes outside.</li>
</ul>

<h2>The part nobody mentions: waterproof floors don't protect your house</h2>
<p>A waterproof floor protects <em>itself</em>. Water always looks for edges — the gap at the baseboard, the toilet flange, the tub perimeter, the doorway transition — and once it's under a floating floor it can sit against the subfloor unseen. Good wet-area installation is what actually protects the structure: sealed or caulked perimeters in baths and laundries, waterproofing membranes under shower and wet-room tile, and on Southern California's concrete slabs, a moisture check before anything goes down. That install detail, more than the plank you pick, is the difference between a wet floor and a wet house — it's also why we treat wet rooms as a different job than bedrooms.</p>

<h2>What it costs</h2>
<p>Typical Orange County ranges, installed: <strong>LVP about $4–$10 per square foot</strong> all-in, <strong>sheet vinyl a bit less</strong>, and <strong>porcelain tile about $10–$25</strong> depending on format and prep — tile costs more up front and amortizes over a much longer life. Details in our <a href="/guides/tile-installation-cost-orange-county">tile installation cost guide</a>, or run your rooms through the <a href="/guides/flooring-cost-calculator">flooring cost calculator</a>.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Shower or floor drain involved?</strong> Tile is the only candidate.</li>
  <li><strong>Wood look + waterproof?</strong> LVP with a 20+ mil wear layer — or wood-look porcelain for the forever version.</li>
  <li><strong>Laundry on a budget?</strong> Sheet vinyl, one seamless piece.</li>
  <li><strong>"Water-resistant" on the box?</strong> That's a dry-room floor. Read the warranty's fine print — surface spills on an intact floor is all it covers.</li>
  <li><strong>Any wet room:</strong> the installation details (sealed perimeter, membrane, slab moisture check) matter more than the product logo.</li>
</ul>`,
  footer_html: `<p>Waterproof claims are easiest to judge with the products in front of you. <strong>Roma Flooring Designs</strong> stocks porcelain tile, LVP, and sheet vinyl side by side at our Anaheim showroom (1440 S. State College Blvd, Suite 6M) — bring your room list and we'll match each room to the right floor and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['lvp-plank', 'porcelain-tile', 'sheet-vinyl'],
    angle: 'waterproof vs water-resistant, LVP, porcelain tile, kitchens/baths/basements.',
    faq: [
      ['What is the most waterproof flooring?',
       'Porcelain tile. It absorbs 0.5% or less of its weight in water and is the only common flooring rated for use inside a shower. Luxury vinyl plank and sheet vinyl are also fully waterproof as materials, and are the go-to wood-look and budget options.'],
      ['Is LVP really 100% waterproof?',
       'The plank itself is — it\'s all polymer, so no amount of surface water damages it. But water can still reach the subfloor through edges and perimeters of a floating floor, so wet rooms also need good installation detail (sealed perimeters, and a waterproofed assembly in showers).'],
      ['Is there such a thing as waterproof laminate?',
       'Not truly. The best laminate lines are water-resistant — typically warrantied for 24–72 hours of surface water on an intact floor — but the wood-fiber core swells permanently if water penetrates a seam or edge. Keep laminate in rooms that stay dry.'],
      ['What is the best waterproof flooring for a bathroom?',
       'Porcelain tile, because it covers the whole job — floor, walls, and shower — over a proper waterproofing membrane. LVP is a solid budget alternative for the bathroom floor outside the shower.'],
      ['Does waterproof flooring protect the subfloor?',
       'Not by itself. A waterproof floor protects its own surface; water that finds edges, toilet flanges, or tub perimeters can still sit against the subfloor unseen. Sealed perimeters and proper wet-area installation are what protect the structure.'],
    ],
  },
};

async function upsertGuide(g) {
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
    g.intro_html, g.content_html, g.footer_html, JSON.stringify(g.filter_json)];
  if (DRY) { console.log(`[dry-run] would upsert guide: ${g.slug}`); return; }
  const res = await pool.query(sql, params);
  const row = res.rows[0];
  console.log(`${row.inserted ? 'INSERTED' : 'UPDATED '} guide: /guides/${row.slug}`);
}

(async () => {
  try {
    await upsertGuide(GUIDE);
    console.log('Done.');
  } catch (e) {
    console.error('Failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
