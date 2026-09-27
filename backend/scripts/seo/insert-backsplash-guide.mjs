// Hand-authored pillar guide: Kitchen Backsplash Tile Guide.
//
// Replaces the short AI-generated body on /guides/kitchen-backsplash-tile-guide with a
// comprehensive hand-written guide (~1,400 words): why wall tile plays by different
// rules than floors, materials, layout patterns, height decisions, measuring, grout.
//
//   node scripts/seo/insert-backsplash-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'kitchen-backsplash-tile-guide',
  title: 'Kitchen Backsplash Tile Guide: Materials, Layouts & Ideas',
  h1: 'The Kitchen Backsplash Guide',
  meta_title: 'Kitchen Backsplash Tile Guide: Materials, Layouts & Ideas | Roma Flooring Designs',
  meta_description: 'How to choose backsplash tile — materials from subway to zellige, layout patterns, how high to run it, measuring and waste, grout color strategy, and real costs.',
  intro_html: `<p><strong>No surface in your kitchen delivers more design per dollar than the backsplash.</strong> It's a small area — usually 30 to 60 square feet — sitting dead center in the room's sightline, which means a modest tile budget can carry the whole kitchen's personality. It's also the one tile project where almost every rule that governs floors gets thrown out.</p>
<p>Here's how to choose the material, the pattern, and the details that make a backsplash look intentional rather than applied — and how to measure and budget it. Shortcut: <a href="/installation">bring a photo of your kitchen and a counter sample to our Anaheim showroom</a> and build the combination on a real table.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p>A backsplash is a <strong>wall</strong> — so gloss, delicate glass, handmade zellige, and intricate mosaics are all fair game (no PEI or slip ratings to satisfy). Pick the pattern <em>after</em> the countertop: busy counters want a quiet splash, quiet counters can carry a statement. Most kitchens need 30–60 sq ft and land between <strong>$900 and $2,500 installed</strong>.</p></div>

<h2>Walls play by different rules</h2>
<p>Floor tile has to survive feet, grit, and water — that's why floor guides obsess over PEI ratings and DCOF slip numbers. A backsplash carries nothing and is walked on by no one. That frees you to choose everything a floor forbids: <strong>high-gloss glazes</strong> that bounce light back into the room, <strong>thin glass and delicate mosaics</strong>, <strong>handmade tile</strong> with irregular edges, and soft materials like polished marble. The only jobs a backsplash has are wiping clean and looking good doing it — and fired glaze of any sheen handles grease and tomato sauce equally well.</p>

<h2>Materials, honestly compared</h2>
<table>
  <caption>Backsplash materials at a glance</caption>
  <thead><tr><th>Material</th><th>The appeal</th><th>Know going in</th></tr></thead>
  <tbody>
    <tr><td>Ceramic &amp; porcelain</td><td>Every color, shape, and price; effortless cleanup</td><td>The workhorse — hard to go wrong</td></tr>
    <tr><td>Glass</td><td>Luminous depth, great with under-cabinet lighting</td><td>Shows every wave in the wall; needs a skilled setter</td></tr>
    <tr><td>Marble &amp; natural stone</td><td>Real veining, ages into character</td><td>Seal it, especially behind the range — grease stains porous stone</td></tr>
    <tr><td>Zellige &amp; handmade</td><td>Shimmering, irregular, artisanal</td><td>The "flaws" are the product: undulating faces, shade play, hairline crazing. Order from one lot and embrace it</td></tr>
    <tr><td>Mosaics (sheet-mounted)</td><td>Intricate patterns install like 12x12 tile</td><td>Priced per sheet — see our <a href="/guides/mosaic-tile-guide">mosaic guide</a></td></tr>
    <tr><td>Slab (porcelain or quartz)</td><td>Seamless, grout-free, dramatic</td><td>Priced like countertop material — see the <a href="/guides/countertop-installation-cost-orange-county">countertop cost guide</a></td></tr>
  </tbody>
</table>

<h2>The pattern is half the design</h2>
<p>The same 3x12 white tile reads five different ways depending on how it's laid:</p>
<ul>
  <li><strong>Offset (brick) subway:</strong> the hundred-year classic. Use a one-half or one-third offset; it never dates.</li>
  <li><strong>Stacked (grid):</strong> the same tile turned modern — clean vertical and horizontal lines, loves minimalist kitchens. Stack vertically to visually raise low ceilings.</li>
  <li><strong>Herringbone / chevron:</strong> movement and energy; adds roughly 10–20% to labor and waste from all the angled cuts.</li>
  <li><strong>Shaped tile — hex, picket, scallop, kit-kat:</strong> the shape <em>is</em> the pattern; keep the color quiet and let geometry do the work.</li>
  <li><strong>Slab / full sheet:</strong> no pattern at all — veining as a single uninterrupted picture.</li>
</ul>
<p>Pairing rule that never misses: <strong>counter and splash take turns.</strong> A heavily veined quartz wants a calm field tile; a quiet counter is your license for zellige, bold mosaics, or a saturated color. Bring the actual counter sample when you shop — undertones lie in photos.</p>

<h2>How high should it go?</h2>
<ul>
  <li><strong>Standard — counter to upper cabinets (~18"):</strong> the default, and where most budgets land.</li>
  <li><strong>Full height behind the range:</strong> run tile from counter to hood as a focal panel, standard height elsewhere — the best-value drama in kitchen design.</li>
  <li><strong>To the ceiling on open walls:</strong> where cabinets were skipped for windows or shelves, tile-to-ceiling makes the wall architecture instead of leftover paint.</li>
  <li><strong>The 4" ledge:</strong> the builder-grade strip. If you're tiling anyway, spend the extra few square feet — it transforms the result.</li>
</ul>

<h2>Measuring and buying</h2>
<p>Multiply the length of counter runs by the height (standard band ≈ 1.5 ft), add the range focal panel if you're running one, and subtract nothing for windows or outlets — those offcuts rarely reuse. Then add <strong>10% waste for straight lays and 15% for herringbone, shaped tile, or handmade</strong> (where you also want extras to cull and to blend shade variation from). Mosaic and sheet goods round up to whole sheets. Full method in <a href="/guides/how-to-measure-a-room-for-flooring">our measuring guide</a> — walls work the same as floors, just in smaller numbers. Keep the spare pieces: a future outlet move or a cracked tile is a five-minute fix with matching stock and a headache without it.</p>

<h2>Grout: small line, big decision</h2>
<ul>
  <li><strong>Blend</strong> (grout matches tile) → the surface reads as one material; the safe, elegant default. <strong>Contrast</strong> (dark grout, light tile) → the layout becomes graphic; commit to it, it's the whole look.</li>
  <li><strong>Behind the range, use epoxy grout</strong> — stain-proof against grease and never needs sealing; worth the upcharge on the one panel that gets cooked on.</li>
  <li><strong>The counter-to-splash joint gets caulk, not grout</strong> — color-matched silicone flexes where the two planes meet; grout there cracks. It's the detail that separates pro work from weekend work.</li>
</ul>

<h2>What it costs</h2>
<p>A typical Orange County backsplash — 30 to 60 square feet, installed — runs about <strong>$900–$2,500</strong>: modest field tile at the low end, mosaics, zellige, and pattern work at the top, and slab panels priced separately per the fabrication involved. It's often bundled with counter replacement (one mobilization, and the old splash usually dies with the old counters anyway) — see the <a href="/guides/tile-installation-cost-orange-county">tile cost guide</a> and, if the whole room is in play, the <a href="/guides/kitchen-remodel-cost-anaheim-orange-county">kitchen remodel cost guide</a>.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Pick the counter first,</strong> then let the splash take the opposite role — quiet vs. statement.</li>
  <li><strong>Exploit the wall rules:</strong> gloss, glass, handmade — everything floors can't have.</li>
  <li><strong>Range panel full-height</strong> if the budget allows one upgrade.</li>
  <li><strong>Epoxy grout behind the range; caulk at the counter joint.</strong></li>
  <li><strong>Order 10–15% over, from one lot,</strong> and keep the spares.</li>
</ul>`,
  footer_html: `<p>Backsplashes are combination decisions — tile, counter, cabinet, grout — and combinations need a table, not a browser tab. <strong>Roma Flooring Designs</strong> stocks subway, mosaics, zellige-style, and slab options at our Anaheim showroom (1440 S. State College Blvd, Suite 6M); bring your counter sample or choose both together, and we'll quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['backsplash-wall', 'mosaic-tile', 'ceramic-tile'],
    angle: 'materials, mosaic vs subway, layout patterns, coverage/measuring, grout.',
    faq: [
      ['How much does a kitchen backsplash cost installed?',
       'In Orange County, a typical 30–60 sq ft backsplash runs about $900–$2,500 installed in 2026 — modest ceramic field tile at the low end, mosaics, handmade tile, and pattern layouts at the top. Full-height slab panels price separately, like countertop material.'],
      ['Can I use glossy or delicate tile on a backsplash?',
       'Yes — that\'s the advantage of a wall. Backsplashes carry no foot traffic, so PEI wear ratings and DCOF slip ratings don\'t apply: high-gloss glazes, thin glass, polished marble, and handmade zellige are all appropriate choices that would be wrong on a floor.'],
      ['How high should a kitchen backsplash go?',
       'Counter-to-upper-cabinets (about 18") is the standard. The best-value upgrade is running tile full height behind the range as a focal panel; on open walls without cabinets, tile-to-ceiling looks architectural. The 4" builder ledge is worth upgrading past if you\'re tiling anyway.'],
      ['How much backsplash tile should I order?',
       'Measure counter length times the band height (about 1.5 ft standard), add any full-height panels, then add 10% waste for straight layouts and 15% for herringbone, shaped, or handmade tile. Don\'t subtract for windows and outlets, round mosaics up to whole sheets, and keep the spares.'],
      ['What grout should I use on a backsplash?',
       'Match the grout to the tile for a seamless look, or contrast it to make the pattern graphic. Use epoxy grout behind the range — it\'s stain-proof against grease — and always color-matched caulk, never grout, at the joint where the backsplash meets the countertop.'],
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
