// Hand-authored pillar guide: Choosing Bathroom Floor Tile.
//
// Replaces the short AI-generated body on /guides/choosing-bathroom-floor-tile with a
// comprehensive hand-written guide (~1,500 words). Completes the bathroom topic cluster
// (bathroom-remodel-cost + tile-installation-cost + best-waterproof-flooring).
//
//   node scripts/seo/insert-bathroom-tile-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'choosing-bathroom-floor-tile',
  title: 'Choosing Bathroom Floor Tile: What to Know',
  h1: 'How to Choose Bathroom Floor Tile',
  meta_title: 'Choosing Bathroom Floor Tile: What to Know | Roma Flooring Designs',
  meta_description: 'How to choose bathroom floor tile that\'s safe wet and easy to live with — DCOF slip ratings, porcelain vs. stone, shower-floor mosaics, sizes, grout, and heated floors.',
  intro_html: `<p><strong>A bathroom floor is the one floor in your house you'll regularly walk on barefoot, soaking wet.</strong> That single fact should drive every tile decision in the room — before color, before size, before what's trending. The good news: get two specs right and almost any look you love is on the table.</p>
<p>Here's how to choose a bathroom floor that's safe when wet, easy to keep clean, and still beautiful in fifteen years — and where the shower floor plays by different rules than the rest of the room. Want to shortcut the research? <a href="/installation">Bring your bathroom's dimensions to our Anaheim showroom</a> and we'll lay real samples side by side.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>Matte porcelain with a wet DCOF of 0.42 or higher</strong> for the main floor, <strong>2" mosaics on the shower floor</strong>, and any tile you love on the walls. Choose natural stone only if you'll keep up with sealing — and keep polished tile off bathroom floors entirely.</p></div>

<h2>Slip resistance: the spec that matters most</h2>
<p>Every reputable tile lists a <strong>DCOF</strong> (dynamic coefficient of friction) on its spec sheet. The ANSI A326.3 standard says tile for level interior floors that get wet should measure <strong>0.42 or higher</strong> — treat that as your bathroom floor minimum, not a nice-to-have. In practice:</p>
<ul>
  <li><strong>Matte and textured porcelain</strong> — most meet or beat 0.42; this is the bathroom workhorse.</li>
  <li><strong>Lappato / semi-polished</strong> — varies line by line; check the number, don't assume.</li>
  <li><strong>Polished tile</strong> — beautiful on walls, a skating rink on a wet floor. Keep it vertical.</li>
</ul>
<p>Texture is a balance: enough grip to be safe barefoot, not so much that it traps soap film and grime. A standard matte finish hits that balance for most homes; save aggressive grip textures for outdoor showers and pool surrounds.</p>

<h2>Porcelain, ceramic, or natural stone?</h2>
<table>
  <caption>Bathroom floor materials compared</caption>
  <thead><tr><th>Material</th><th>On the floor</th><th>Maintenance</th></tr></thead>
  <tbody>
    <tr><td>Porcelain</td><td>The default — waterproof, dense, DCOF-rated options everywhere</td><td>Essentially none</td></tr>
    <tr><td>Ceramic</td><td>Fine in light-duty baths; softer glaze than porcelain</td><td>Essentially none</td></tr>
    <tr><td>Marble / natural stone</td><td>Gorgeous, but porous and slick when polished</td><td>Sealing on schedule; acids etch marble</td></tr>
    <tr><td>Pebble / textured stone mosaics</td><td>Great traction, spa look</td><td>Lots of grout to keep sealed and clean</td></tr>
  </tbody>
</table>
<p><strong>Porcelain</strong> earns the default for the same reasons it dominates every wet application: near-zero water absorption, hard glaze, and today's inkjet printing means the marble look you want exists in porcelain — without the sealing schedule. <strong>Real stone</strong> is still worth it when authenticity matters: honed (not polished) finishes for traction, sealed on schedule, and expect marble to develop character — etching from bath products is chemistry, not a defect. The full spec rundown is in our <a href="/guides/how-to-choose-porcelain-tile">porcelain buying guide</a>.</p>

<h2>The shower floor plays by different rules</h2>
<p>Whatever you pick for the main floor, the shower pan wants <strong>small-format mosaics — typically 2" squares, hexes, or penny rounds</strong>. Two reasons: all those grout joints act as built-in traction exactly where the floor is soapiest, and small tiles follow the pan's slope to the drain without cracking or rocking the way a large tile would. (A linear drain is the exception that lets large-format tile run into the shower on a single plane — a sleek look, priced accordingly.)</p>
<p>The designer move: pick a mosaic in the same color family or the same product line as your field tile, so the floor reads continuous while the texture quietly changes where it needs to. Browse <a href="/shop?category=mosaic-tile">mosaics</a> alongside your field tile — and see our <a href="/guides/mosaic-tile-guide">mosaic guide</a> for patterns and pricing quirks (mosaics price per sheet, not per piece).</p>

<h2>Size: bigger than you think, smaller than the living room</h2>
<p><strong>12x24 is the modern bathroom default</strong> — large enough to minimize grout, small enough to handle with a floor that slopes gently to a door threshold. 24x24 and large formats look stunning in bigger bathrooms but demand a dead-flat substrate and add install cost. And despite the old rule, small rooms don't need small tile: a 12x24 in a powder room looks intentional, and fewer grout lines make a tight space feel bigger. Just avoid formats so large you end up with slivers at two walls — more in our <a href="/guides/tile-sizes-explained">tile sizes guide</a>.</p>

<h2>Grout: the part you'll actually clean</h2>
<p>Nobody regrets thinking about grout early. Three decisions:</p>
<ul>
  <li><strong>Color:</strong> matching grout disappears (and forgives); contrasting grout turns the layout into a pattern (and shows every shadow of grime). Mid-gray tones age the most gracefully on floors.</li>
  <li><strong>Type:</strong> modern high-performance cement grouts resist stains well; epoxy grout costs more installed but is essentially stain-proof and never needs sealing — worth it on shower floors.</li>
  <li><strong>Less of it:</strong> larger tile and rectified tight joints mean less grout to maintain, period.</li>
</ul>

<h2>Heated floors: the upgrade people actually use</h2>
<p>Tile's one honest drawback — cold underfoot on a winter morning — has a fix: an electric radiant mat under the tile, on its own thermostat and timer. It's a modest add during a remodel (it must go in <em>before</em> the tile does), turns the bathroom's coldest feature into its most-loved one, and pairs perfectly with porcelain. If you're already remodeling, price it in; see our <a href="/guides/bathroom-remodel-cost-anaheim-orange-county">bathroom remodel cost guide</a> for where it fits in the budget.</p>

<h2>What it costs</h2>
<p>A typical 40–80 sq ft bathroom floor runs about <strong>$800–$2,000 installed</strong> in the Orange County market, with small rooms carrying per-job minimums; a full shower retile is its own project at $4,500–$9,000+. Component math, wet-area pricing, and what drives the ranges are in our <a href="/guides/tile-installation-cost-orange-county">tile installation cost guide</a>.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Main floor:</strong> matte porcelain, wet <strong>DCOF ≥ 0.42</strong>, PEI 3+.</li>
  <li><strong>Shower pan:</strong> 2" mosaics (or a linear-drain large-format design).</li>
  <li><strong>Stone?</strong> Honed finish, sealed on schedule — and make peace with patina on marble.</li>
  <li><strong>Grout:</strong> mid-tone color, epoxy in the shower, tight rectified joints where the budget allows.</li>
  <li><strong>Order 10–15% overage</strong> from one lot and keep spares (<a href="/guides/how-to-measure-a-room-for-flooring">measuring guide</a>).</li>
  <li><strong>Remodeling anyway?</strong> Decide on radiant heat before tile day — it can't be added after.</li>
</ul>`,
  footer_html: `<p>Bathroom tile is easiest to judge wet — literally. <strong>Roma Flooring Designs</strong> stocks porcelain, stone, and mosaics side by side at our Anaheim showroom (1440 S. State College Blvd, Suite 6M); bring your layout and we'll match field tile to shower mosaics, check the DCOF specs with you, and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['porcelain-tile', 'natural-stone', 'mosaic-tile'],
    angle: 'slip resistance (DCOF), porcelain vs stone, small-format for shower floors, maintenance.',
    faq: [
      ['What is the best tile for bathroom floors?',
       'Matte porcelain with a wet DCOF of 0.42 or higher is the best all-around choice — waterproof, slip-rated, and nearly maintenance-free, with marble and stone looks available in porcelain. Natural stone works too if you keep up with sealing and choose a honed finish.'],
      ['What DCOF rating do I need for a bathroom floor?',
       'ANSI A326.3 calls for a wet DCOF of 0.42 or higher on level interior floors that get wet — treat that as the minimum for bathroom floors. The number is listed on any reputable tile\'s spec sheet.'],
      ['Why do shower floors use small tile?',
       'Two reasons: the dense grout joints of 2" mosaics act as traction exactly where the floor is soapiest, and small tiles follow the pan\'s slope to the drain without cracking. Large tile in a shower generally requires a linear-drain, single-slope design.'],
      ['Can I use marble on a bathroom floor?',
       'Yes, with eyes open: choose a honed (not polished) finish for traction, seal it on schedule, and accept that bath products can etch marble over time — that patina is chemistry, not a defect. Marble-look porcelain delivers the same style without the maintenance.'],
      ['Should I use small or large tile in a small bathroom?',
       'Larger than you\'d think — a 12x24 works beautifully in a powder room, and fewer grout lines actually make a small space feel bigger. Just avoid formats so large you\'d end up with narrow slivers at the walls.'],
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
