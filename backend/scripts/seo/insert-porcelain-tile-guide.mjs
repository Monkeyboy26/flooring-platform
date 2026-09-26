// Hand-authored flagship pillar guide: How to Choose Porcelain Tile.
//
// Replaces the short AI-generated body on /guides/how-to-choose-porcelain-tile with a
// comprehensive, hand-written buying guide (~2,000 words). Porcelain tile is Roma's
// deepest catalog, so this is the flagship pillar page for the guides program.
// Written to the same standard as insert-cost-guides.mjs: specific, honest, grounded
// in tile-industry standards (ANSI A137.1 / A326.3, PEI, DCOF) — typical market
// ranges are clearly framed as estimates, never our exact prices.
//
//   node scripts/seo/insert-porcelain-tile-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. Safe to re-run. FAQ stored as [q, a] pairs in
// filter_json.faq (renderGuidePage emits FAQPage JSON-LD from it).

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'how-to-choose-porcelain-tile',
  title: 'How to Choose Porcelain Tile: A Complete Buying Guide',
  h1: 'How to Choose Porcelain Tile',
  meta_title: 'How to Choose Porcelain Tile: A Complete Buying Guide | Roma Flooring Designs',
  meta_description: 'How to choose porcelain tile with confidence — PEI wear ratings, DCOF slip resistance, rectified edges, glazed vs. through-body, sizes, and what it costs installed.',
  intro_html: `<p><strong>Porcelain tile is the most versatile hard-surface flooring you can buy</strong> — dense enough for commercial lobbies, waterproof enough for showers, and now printed so convincingly that it passes for marble, oak, or poured concrete at a fraction of their upkeep. But walk into any showroom and you'll face hundreds of options that look similar on the wall and perform very differently on your floor.</p>
<p>This guide covers the handful of specs that actually matter — wear rating, slip resistance, edge type, and format — so you can read a spec sheet like a pro and choose a tile that still looks right ten years in. If you'd rather talk it through, <a href="/installation">our Anaheim showroom offers free design consultations and installation estimates</a>.</p>`,
  content_html: `
<h2>Porcelain vs. ceramic: what actually differs</h2>
<p>Porcelain and ceramic are both kiln-fired clay tile, and the difference comes down to density. Porcelain is pressed from finer clay and fired hotter, so it absorbs <strong>0.5% or less of its weight in water</strong> (the ANSI A137.1 threshold that legally separates "porcelain" from ordinary ceramic). Standard ceramic is softer and more porous.</p>
<p>In practice, that density buys you four things:</p>
<ul>
  <li><strong>Better wear resistance</strong> — porcelain shrugs off traffic that would scratch or craze a soft ceramic glaze.</li>
  <li><strong>Frost and outdoor tolerance</strong> — water can't soak in and freeze-crack the tile, so porcelain works on patios and pool decks.</li>
  <li><strong>Chip forgiveness</strong> — the body under the glaze is dense and often color-matched, so chips telegraph less.</li>
  <li><strong>Bigger formats</strong> — the strength of the body is what makes 24x48 tiles and slab-look panels possible.</li>
</ul>
<p>Ceramic still has a place: it costs less, cuts easier, and is perfectly durable on <em>walls</em> — backsplashes, shower surrounds, wainscots. Our rule of thumb: <strong>porcelain on every floor, either one on walls.</strong> Browse both in our <a href="/shop?category=porcelain-tile">porcelain tile</a> and <a href="/shop?category=ceramic-tile">ceramic tile</a> collections.</p>

<h2>PEI wear ratings: match the tile to the traffic</h2>
<p>The PEI rating (Porcelain Enamel Institute, 1–5) measures how well a glazed surface resists visible wear. It's the single fastest way to rule tiles in or out for a given room:</p>
<table>
  <caption>PEI wear ratings and where each belongs</caption>
  <thead><tr><th>Rating</th><th>Wear resistance</th><th>Right for</th></tr></thead>
  <tbody>
    <tr><td>PEI 1</td><td>Very light</td><td>Walls only — never floors</td></tr>
    <tr><td>PEI 2</td><td>Light</td><td>Barefoot/slipper areas: bathrooms, walls</td></tr>
    <tr><td>PEI 3</td><td>Moderate</td><td>All normal residential floors and counters</td></tr>
    <tr><td>PEI 4</td><td>Heavy</td><td>Busy households, entries, kitchens, light commercial</td></tr>
    <tr><td>PEI 5</td><td>Extra heavy</td><td>Commercial and retail floors</td></tr>
  </tbody>
</table>
<div class="guide-callout"><p><strong>Rule of thumb:</strong> PEI 3 is the residential floor minimum. Choose PEI 4 for entryways, kitchens, and homes with kids or large dogs — the price difference is usually small, the durability difference isn't.</p></div>
<p>Note that unglazed through-body porcelain isn't PEI-rated at all — there's no glaze layer to wear through, which is why it's a favorite for the hardest-working commercial floors.</p>

<h2>Glazed, color-body, and through-body porcelain</h2>
<p>How a porcelain tile is built determines how gracefully it ages:</p>
<ul>
  <li><strong>Glazed porcelain</strong> — a printed glaze over a dense body. This is most of the market today, and modern inkjet glazing is what makes convincing marble-look and wood-look tile possible. Its one weakness: a deep chip exposes a body that may not match the surface color.</li>
  <li><strong>Color-body porcelain</strong> — the clay body is tinted to match the glaze, so chips and cut edges blend in. Worth seeking out for kitchens, entries, and anywhere heavy things get dropped.</li>
  <li><strong>Through-body (full-body) porcelain</strong> — the color and pattern run through the entire tile with no glaze. The most damage-proof construction; common in commercial and outdoor lines, usually in stone- and concrete-look styles.</li>
</ul>

<h2>Rectified vs. non-rectified edges</h2>
<p>After firing, a <strong>rectified</strong> tile is mechanically ground to a precise dimension with a sharp, square edge. That precision lets your installer set <strong>grout joints as tight as 1/16"–1/8"</strong>, which is what creates the seamless, monolithic look you see in design magazines — and it's essential for large formats and marble-look tile, where wide grout lines break the illusion.</p>
<p><strong>Non-rectified</strong> (pressed or "cushioned-edge") tiles vary slightly in size from tile to tile, so they need <strong>3/16" or wider joints</strong> to absorb the variation. That's not a flaw — a softer edge with a visible joint suits rustic, handmade, and traditional looks, and the tile usually costs less.</p>
<p>Two buying notes: rectified edges are sharper, so lippage (one edge sitting proud of its neighbor) is more noticeable and installers typically use leveling systems on large rectified formats — slightly more labor. And always confirm the <em>caliber</em> (production size run) matches across every box; mixing calibers is the classic cause of uneven joints.</p>

<h2>Finish and slip resistance (DCOF)</h2>
<p>Finish is a safety decision, not just an aesthetic one. The number to know is <strong>DCOF</strong> (dynamic coefficient of friction, ANSI A326.3): tile for level interior floors that get wet should measure <strong>DCOF ≥ 0.42</strong>. Any reputable spec sheet lists it.</p>
<ul>
  <li><strong>Polished / high-gloss</strong> — mirror-flat and dramatic, but slick when wet. Best on walls, fireplace surrounds, and dry formal spaces.</li>
  <li><strong>Matte / natural</strong> — the workhorse finish. Most matte porcelains meet the 0.42 wet threshold and hide smudges and hard-water spots far better than gloss.</li>
  <li><strong>Textured / grip / outdoor</strong> — structured surfaces for pool decks, patios, and outdoor steps. Many lines offer the same color in an indoor matte and an outdoor grip finish so a great room can flow to the patio in one look.</li>
  <li><strong>Lappato / semi-polished</strong> — a soft sheen between matte and polished; check the DCOF per tile, it varies.</li>
</ul>
<p>For <strong>shower floors</strong>, skip large tile entirely and use <a href="/shop?category=mosaic-tile">mosaics</a> — the dense grout lines act as traction and let the installer slope the pan to the drain. More on wet-area choices in our <a href="/guides/choosing-bathroom-floor-tile">bathroom floor tile guide</a>.</p>

<h2>Choosing the size and format</h2>
<p>Size changes how a room reads. Fewer grout lines make a space feel larger and calmer, which is why the market has moved from 12x12 toward <strong>12x24, 24x24, and 24x48</strong> field tile, <strong>plank formats</strong> (6x36, 8x48, 9x60) for wood looks, and slab-look <strong>large-format panels</strong> for walls and showers.</p>
<p>Practical guardrails:</p>
<ul>
  <li>Any tile with an edge <strong>15" or longer</strong> counts as large-format and demands a flat substrate (typically within 1/8" over 10 feet) — budget for floor prep, not just tile.</li>
  <li>Set wood-look planks with an offset of <strong>33% or less</strong> (not 50%) — long tiles bow slightly in firing, and a half offset stacks every crown next to a neighbor's low point, guaranteeing lippage.</li>
  <li>Small rooms don't require small tile — a 12x24 in a powder room looks intentional and modern. Just avoid formats so large you'd have slivers at two walls.</li>
</ul>
<p>Our <a href="/guides/tile-sizes-explained">tile sizes guide</a> goes deeper on matching format to room.</p>

<h2>Shade variation: read the V rating</h2>
<p>Every tile line carries a variation rating from <strong>V1</strong> (uniform, every piece alike) to <strong>V4</strong> (dramatic piece-to-piece differences). Stone looks usually run V2–V3; that movement is what makes them believable. Just know what you're buying: order a V3/V4 tile from a photo of one piece and the installed floor will contain pieces that look nothing like it. Ask to see several tiles from the actual production lot — and make sure all your boxes share one <strong>lot/shade number</strong>, because the same SKU can shift color between production runs.</p>

<h2>Where porcelain works — room by room</h2>
<ul>
  <li><strong>Kitchens &amp; entries:</strong> PEI 4, matte, color-body if you can. Wood-look planks or 24x24 concrete looks are the current favorites.</li>
  <li><strong>Bathrooms:</strong> matte porcelain floors (DCOF ≥ 0.42), mosaic shower pans, and either porcelain or ceramic on the walls.</li>
  <li><strong>Living areas:</strong> large formats with tight rectified joints for a seamless look; porcelain is a top choice over radiant heat and stays pleasantly cool through Southern California summers.</li>
  <li><strong>Outdoors:</strong> through-body or grip-finish porcelain rated for exterior use. Porcelain's near-zero absorption means Orange County's rare frosts are a non-issue; UV-stable color is standard.</li>
  <li><strong>Walls &amp; backsplashes:</strong> anything goes — this is where polished finishes, glossy ceramics, and delicate mosaics belong.</li>
</ul>

<h2>What porcelain tile costs</h2>
<p>Typical market ranges (materials only): everyday glazed porcelain runs about <strong>$2–$6 per square foot</strong>, designer lines and convincing marble looks about <strong>$6–$12</strong>, and specialty large-format panels more. Professional installation in the Orange County market generally adds roughly <strong>$6–$15 per square foot</strong> depending on format, pattern, substrate prep, and tear-out — large rectified formats and patterns like herringbone sit at the top of that range because of the leveling and cutting labor involved. Treat these as planning estimates, then <a href="/installation">get a free measured quote</a> for a real number, or start with our <a href="/guides/flooring-cost-calculator">flooring cost calculator</a>.</p>

<h2>How much to buy</h2>
<p>Measure the area, then add <strong>10% waste</strong> for straightforward layouts and <strong>15% for diagonals, herringbone, large formats, or rooms with many cuts</strong> — and round up to full cartons. Buy your overage up front from the same lot: a box of spares from a matching shade is cheap insurance against a future repair that can't be color-matched. Step-by-step math in <a href="/guides/how-to-measure-a-room-for-flooring">how to measure a room for flooring</a>.</p>

<h2>The 60-second spec-sheet checklist</h2>
<ul>
  <li><strong>Porcelain body</strong> (water absorption ≤ 0.5%), not standard ceramic, for any floor</li>
  <li><strong>PEI 3+</strong> for bedrooms and baths, <strong>PEI 4</strong> for kitchens, entries, and busy homes</li>
  <li><strong>DCOF ≥ 0.42</strong> anywhere the floor gets wet</li>
  <li><strong>Rectified edges</strong> if you want tight modern joints; budget for leveling on large formats</li>
  <li><strong>Color-body or through-body</strong> for chip-prone, hard-working areas</li>
  <li><strong>V rating understood</strong> and all boxes from <strong>one caliber and lot</strong></li>
  <li><strong>10–15% overage</strong>, rounded up to full cartons</li>
</ul>`,
  footer_html: `<p>The fastest way to choose well is to see full pieces in real light. <strong>Roma Flooring Designs</strong> stocks hundreds of porcelain lines at our Anaheim showroom (1440 S. State College Blvd, Suite 6M) — bring your room dimensions and photos, and we'll narrow the field, check real lot samples, and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['porcelain-tile', 'ceramic-tile', 'mosaic-tile'],
    angle: 'PEI rating, water absorption, rectified vs non-rectified, finish, size, indoor/outdoor, cost vs ceramic.',
    faq: [
      ['Is porcelain tile better than ceramic tile?',
       'For floors, yes — porcelain absorbs 0.5% or less water (the ANSI A137.1 standard), so it is denser, more wear-resistant, and usable outdoors, while standard ceramic is softer and best kept to walls and backsplashes. Ceramic remains a good, lower-cost choice for wall applications.'],
      ['What PEI rating do I need for floor tile?',
       'PEI 3 is the minimum for normal residential floors. Choose PEI 4 for kitchens, entryways, and homes with kids or pets; PEI 1 and 2 tiles belong on walls or very light-traffic bathroom floors only.'],
      ['How do I know if a tile is slip-resistant enough for a bathroom?',
       'Check the DCOF value on the spec sheet — level interior floors that get wet should measure 0.42 or higher under ANSI A326.3. For shower floors, use small mosaics regardless: the extra grout lines add traction and allow the pan to slope to the drain.'],
      ['What does "rectified" tile mean, and does it cost more to install?',
       'Rectified tile is precision-ground after firing so every piece is exactly the same size, allowing tight 1/16"–1/8" grout joints for a seamless look. It typically costs slightly more to buy and install, since large rectified formats need a flatter substrate and tile-leveling systems to prevent lippage.'],
      ['Can porcelain tile be used outdoors in Southern California?',
       'Yes — porcelain’s near-zero water absorption makes it frost-proof and its color is UV-stable, so it works well on patios, walkways, and pool surrounds. Choose a textured or grip finish rated for exterior use rather than a polished or standard matte finish.'],
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
