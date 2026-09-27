// Hand-authored pillar guide: Mosaic Tile Guide.
//
// Replaces the short AI-generated body on /guides/mosaic-tile-guide with a
// comprehensive hand-written guide (~1,300 words): what sheet-mounted mosaics are,
// materials, where they belong (shower floors as the functional home), the
// per-sheet pricing quirk, measuring, grout, and design restraint.
//
//   node scripts/seo/insert-mosaic-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'mosaic-tile-guide',
  title: 'Mosaic Tile Guide: Uses, Patterns & Installation',
  h1: 'The Mosaic Tile Guide',
  meta_title: 'Mosaic Tile Guide: Uses, Patterns & Installation | Roma Flooring Designs',
  meta_description: 'How mosaic tile works — sheet-mounted formats, glass vs. stone vs. porcelain, where mosaics belong (and where they don\'t), per-sheet pricing, measuring, and grout.',
  intro_html: `<p><strong>Mosaics are where tile stops being a building material and starts being jewelry.</strong> Hexes, penny rounds, herringbone strips, marble basketweave, shimmering glass — the small formats carry the detail, color, and pattern that big field tile can't. They're also the most misunderstood product in the showroom: priced differently, installed differently, and best used more sparingly than Pinterest suggests.</p>
<p>Here's how mosaics actually work — the sheet system, the materials, the one place they're a functional necessity rather than a flourish, and the pricing quirk that surprises everyone. See the real thing at <a href="/installation">our Anaheim showroom</a>, where sheets read completely differently than swatch photos.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p>Mosaics are small tiles — usually 2" and under — <strong>pre-mounted on roughly 12x12 mesh sheets</strong> that install like a single large tile. They're priced <strong>per sheet</strong> (≈ one square foot). Use them where they're functional — <strong>shower floors</strong> — and where a small dose carries the design: backsplashes, niches, and feature strips. Restraint is the skill.</p></div>

<h2>How the sheet system works</h2>
<p>Setting hundreds of penny rounds one at a time died a century ago. Modern mosaics arrive face-up on a mesh (or paper-faced) backing, spaced and patterned at the factory, so your installer sets a whole square foot at once and the pattern self-aligns sheet to sheet. Sheets also cut cleanly into strips — that's how a mosaic becomes a border, a niche liner, or an accent band inside a field of larger tile.</p>
<p>The small format has a structural superpower too: dense grout joints every inch or two let a mosaic surface <strong>bend over slopes and curves</strong> that would crack a large tile — which is exactly why shower pans want them.</p>

<h2>Materials, and where each belongs</h2>
<table>
  <caption>Mosaic materials at a glance</caption>
  <thead><tr><th>Material</th><th>The appeal</th><th>Best placement</th></tr></thead>
  <tbody>
    <tr><td>Porcelain / ceramic</td><td>Durable, affordable, every color</td><td>Anywhere — floors, showers, walls</td></tr>
    <tr><td>Glass</td><td>Depth and shimmer no glaze can match</td><td>Walls and backsplashes; verify floor-rated before underfoot use</td></tr>
    <tr><td>Marble &amp; stone blends</td><td>Basketweave, herringbone, timeless</td><td>Baths and fireplaces; seal before and after grouting</td></tr>
    <tr><td>Pebble</td><td>Spa-floor texture underfoot</td><td>Shower floors; heavy grout upkeep — go in informed</td></tr>
    <tr><td>Metal &amp; mixed blends</td><td>Accent glints in a strip</td><td>Backsplash bands and borders, dry areas</td></tr>
  </tbody>
</table>

<h2>Where mosaics belong</h2>
<ul>
  <li><strong>Shower floors — the functional home.</strong> This is the one place mosaics aren't optional decoration: the grout grid supplies barefoot traction where the floor is soapiest, and the small pieces follow the pan's slope to the drain. Match the mosaic to your wall tile's family and the shower reads designed, not assembled — more in <a href="/guides/choosing-bathroom-floor-tile">our bathroom tile guide</a>.</li>
  <li><strong>Backsplashes and feature panels.</strong> Thirty square feet of herringbone marble behind a range is a statement; a whole kitchen of it is noise. The <a href="/guides/kitchen-backsplash-tile-guide">backsplash guide</a> covers the pairing rules.</li>
  <li><strong>Niches, bands, and borders.</strong> The cheapest luxury in tile: line a shower niche with the mosaic version of your field stone — a few sheets, outsized effect.</li>
  <li><strong>Fireplace surrounds and powder-room walls.</strong> Small rooms and small surfaces are where bold mosaics get to be the whole show.</li>
  <li><strong>Full floors — with eyes open.</strong> A mosaic bathroom floor (penny rounds, hex) is a classic look that comes with maximum grout to clean and seal. Beautiful; know the chore you're adopting.</li>
</ul>

<h2>The pricing quirk: per sheet, not per piece</h2>
<p>Mosaics are priced <strong>per sheet</strong>, and a sheet is roughly a square foot — so a "$18 sheet" is $18/sq ft material, sitting well above ordinary field tile. Installation runs higher too: more grout to work, more edges to align, stone blends to seal. That's the real reason the pros use mosaics in doses — <strong>the cost concentrates where the eye goes</strong>, which is also exactly how to get the most design out of them. Budget math lives in our <a href="/guides/tile-installation-cost-orange-county">tile cost guide</a>.</p>

<h2>Measuring and ordering</h2>
<p>Count in sheets: measure the area, round <strong>up to whole sheets</strong>, and add <strong>10–15% waste</strong> — more for pattern-matched sheets (herringbone, basketweave) where edges must align, less for uniform grids like penny rounds. Strips and borders: figure how many strips one sheet yields and round up again. And keep the offcuts — mosaic repairs are trivial with matching stock and impossible without it. General method in <a href="/guides/how-to-measure-a-room-for-flooring">the measuring guide</a>.</p>

<h2>Grout: a third of what you see</h2>
<p>On a 1" mosaic, grout is a huge share of the visible surface — the grout color decision <em>is</em> a design decision:</p>
<ul>
  <li><strong>Blend</strong> for texture-without-pattern (white-on-white penny rounds); <strong>contrast</strong> to turn the grid graphic. There's no neutral choice at mosaic scale.</li>
  <li><strong>Wet areas want epoxy grout</strong> — with this much grout underfoot in a shower, stain-proof and seal-free pays for itself.</li>
  <li><strong>Stone mosaics get sealed <em>before</em> grouting</strong> — otherwise grout pigment lodges in the stone's pores. It's a one-line spec that separates good installs from regrets.</li>
</ul>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Shower pan:</strong> 2" or smaller mosaic, epoxy grout — function first.</li>
  <li><strong>Design dose:</strong> one mosaic moment per room; let field tile carry the rest.</li>
  <li><strong>Glass or stone on a floor?</strong> Verify floor-rated / plan the sealing schedule.</li>
  <li><strong>Order by the sheet</strong>, 10–15% over, pattern-matched sheets need the high end.</li>
  <li><strong>Pick grout color with the sample in hand</strong> — it's a third of the look.</li>
</ul>`,
  footer_html: `<p>Mosaic sheets have to be seen at arm's length — the pattern, the shimmer, and the grout share are invisible in photos. <strong>Roma Flooring Designs</strong> stocks hundreds of mosaics — porcelain, glass, marble, pebble — alongside their matching field tiles at our Anaheim showroom (1440 S. State College Blvd, Suite 6M). Bring your project and we'll build the combination and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['mosaic-tile', 'backsplash-wall', 'natural-stone'],
    angle: 'sheet-mounted mosaics, materials, accent walls/floors/showers, measuring sheets.',
    faq: [
      ['What is mosaic tile?',
       'Small tiles — typically 2" and under, in shapes like hex, penny round, and herringbone — factory-mounted on roughly 12x12 mesh sheets that install as a unit. The sheet system keeps spacing and pattern consistent and lets an installer set a square foot at a time.'],
      ['Why are mosaics used on shower floors?',
       'Two functional reasons: the dense grout joints act as barefoot traction exactly where the floor is soapiest, and small pieces follow the shower pan\'s slope to the drain without cracking the way large tile would. It\'s the one place mosaics are a necessity, not decoration.'],
      ['How is mosaic tile priced?',
       'Per sheet, and a sheet is roughly one square foot — so an $18 sheet is about $18/sq ft in material, above typical field tile. Installation also runs higher (more grout and alignment work), which is why designers use mosaics in focused doses.'],
      ['How much mosaic tile should I order?',
       'Measure the area, round up to whole sheets, and add 10–15% waste — the high end for pattern-matched layouts like herringbone and basketweave where sheet edges must align. Keep the offcuts for future repairs.'],
      ['What grout is best for mosaic tile?',
       'In showers and wet areas, epoxy grout — with this much grout surface it\'s worth being stain-proof and seal-free. Choose the color deliberately (it\'s up to a third of the visible surface), and seal stone mosaics before grouting so pigment can\'t lodge in the pores.'],
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
