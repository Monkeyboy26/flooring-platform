// Hand-authored pillar guide: Tile Sizes Explained.
//
// Replaces the short AI-generated body on /guides/tile-sizes-explained with a
// comprehensive hand-written guide (~1,300 words): size families, how size changes
// a room, plank/large-format rules, layout and orientation, slivers, waste.
//
//   node scripts/seo/insert-tile-sizes-guide.mjs [--dry-run]
//
// IDEMPOTENT: upserts on slug. content_status='reviewed' so generate-guide-content.mjs
// never overwrites this copy. FAQ stored as [q, a] pairs in filter_json.faq.

import { pool } from '../../db.js';

const DRY = process.argv.includes('--dry-run');

const GUIDE = {
  slug: 'tile-sizes-explained',
  title: 'Tile Sizes Explained: How to Pick the Right One',
  h1: 'Tile Sizes, Explained',
  meta_title: 'Tile Sizes Explained: How to Pick the Right One | Roma Flooring Designs',
  meta_description: 'From 3x6 subway to 24x48 large format and slab panels — what each tile size does to a room, the large-format rules, plank offsets, layout tricks, and waste math.',
  intro_html: `<p><strong>After color, nothing changes a tiled room more than the size of the tile — because size controls the grout lines, and grout lines are what your eye actually reads.</strong> The same stone-look porcelain feels busy at 12x12, calm at 24x24, and architectural as a slab panel. Size also quietly sets your budget: bigger tile means flatter-substrate requirements and different labor.</p>
<p>Here's the map of the size families, what each does to a room, and the handful of installation rules that come attached. To judge scale honestly, <a href="/installation">stand over full pieces at our Anaheim showroom</a> — a 24x48 on a website is a postage stamp; in person it's a coffee table.</p>`,
  content_html: `
<h2>The 30-second answer</h2>
<div class="guide-callout"><p><strong>12x24 is the modern default</strong> for floors and bathroom walls — big enough to calm a room, small enough to install anywhere. Go <strong>24x24 or larger</strong> for open spaces and a seamless look (budget for substrate prep), <strong>planks</strong> for wood looks, and <strong>mosaics</strong> where slopes and traction demand them. Bigger tile = fewer grout lines = larger-feeling room — yes, even in small rooms.</p></div>

<h2>The size families</h2>
<table>
  <caption>Common tile sizes and where they belong</caption>
  <thead><tr><th>Family</th><th>Typical sizes</th><th>Home turf</th></tr></thead>
  <tbody>
    <tr><td>Mosaic</td><td>2" and under, on sheets</td><td>Shower floors, accents, niches</td></tr>
    <tr><td>Small format</td><td>3x6, 4x4, 3x12</td><td>Backsplashes, shower walls, classic looks</td></tr>
    <tr><td>Medium format</td><td>12x12, 12x24</td><td>The all-purpose floor and wall workhorses</td></tr>
    <tr><td>Large format</td><td>24x24, 24x48, 32x32</td><td>Open floors, seamless modern baths</td></tr>
    <tr><td>Plank</td><td>6x36, 8x48, 9x60</td><td>Wood-look floors</td></tr>
    <tr><td>Slab panel</td><td>~5x10 ft sheets</td><td>Shower walls, fireplace, counters — walls of stone with no joints</td></tr>
  </tbody>
</table>

<h2>What size does to a room</h2>
<p>Grout-line density is the mechanism. A 10x10 room in 12x12 tile draws a grid of ~100 lines; the same room in 24x24 draws 25. Fewer interruptions read as <strong>calm, expensive, and larger</strong> — which kills the old myth on the spot: <strong>small rooms don't need small tile.</strong> A 12x24 in a powder room looks intentional and stretches the space; what actually limits size in a small room is practical, not visual — you don't want slivers at two walls, and a floor that must slope to a drain needs small tile to follow it.</p>
<p>Scale has a ceiling, too: a 32x32 in a narrow hallway spends most of its pieces cut, and the effect is lost. The working rule — <strong>the largest tile the room can lay mostly whole</strong> is usually the right one.</p>

<h2>Plank sizes: the wood-look rules</h2>
<p>Wood-look porcelain lives in plank formats, and planks carry two rules worth knowing before install day:</p>
<ul>
  <li><strong>Offset 33% or less — never 50%.</strong> Long tiles bow slightly in firing (all of them, every brand); a half offset parks every crown next to a neighbor's low point and guarantees lippage. A third offset, or a random stagger, hides it completely.</li>
  <li><strong>Longer planks read more like real wood</strong> — an 8x48 or 9x60 mimics lumber proportions; a 6x24 reads as tile pretending. If the budget allows, buy length before width.</li>
</ul>

<h2>Large format: the rules that come with the look</h2>
<p>Industry-wise, any tile with an edge <strong>15" or longer</strong> is "large format," and the seamless look carries three attachments:</p>
<ul>
  <li><strong>A flatter substrate</strong> — typically within 1/8" over 10 feet. On real-world slabs that means leveling compound; budget prep, not just tile.</li>
  <li><strong>Leveling systems and more labor</strong> — clips and wedges to hold big rectified edges flush while the mortar cures. Worth it; priced in.</li>
  <li><strong>Tight joints want rectified tile</strong> — precision-ground edges that allow 1/16"–1/8" grout lines. The full rundown is in our <a href="/guides/how-to-choose-porcelain-tile">porcelain guide</a>, and the cost side in the <a href="/guides/tile-installation-cost-orange-county">tile cost guide</a>.</li>
</ul>

<h2>Layout: the free design decision</h2>
<ul>
  <li><strong>Run the long side with the room's long axis</strong> (or toward the main light source) — it stretches the space. Crosswise emphasizes width; use it deliberately.</li>
  <li><strong>Center the layout on the room</strong> (or its focal point), then check what dies at the walls: professionals shift the grid so cut pieces at edges stay at least a half tile. Slivers are the #1 tell of an unplanned floor.</li>
  <li><strong>Diagonal and herringbone</strong> transform simple tile into pattern — at the price of 10–20% more labor and waste.</li>
  <li><strong>Carry one size across connected rooms</strong> — a continuous field, minimal transitions, maximum flow. Where sizes must change (say, floor to shower pan), change material scale deliberately, as in <a href="/guides/choosing-bathroom-floor-tile">the bathroom guide</a>.</li>
</ul>

<h2>Waste math by size</h2>
<p>Size and pattern set your overage: <strong>10% for straight lays of medium formats; 15% for large format, planks, diagonals, and herringbone</strong> (bigger pieces = bigger offcuts that reuse less; patterns = more cuts). Small rooms with many fixtures also trend toward 15% — the cuts-per-square-foot ratio is higher. Round up to full cartons, keep the spares from the same lot, and run your numbers through <a href="/guides/how-to-measure-a-room-for-flooring">the measuring guide</a>.</p>

<h2>The 60-second checklist</h2>
<ul>
  <li><strong>Default to 12x24</strong>; step up to 24x24+ where the room lays mostly whole tiles.</li>
  <li><strong>Planks:</strong> ≤33% offset, buy length for realism.</li>
  <li><strong>15"+ edge?</strong> Budget substrate prep and leveling labor.</li>
  <li><strong>Plan the layout</strong> before ordering: long axis, centered grid, no slivers.</li>
  <li><strong>Waste:</strong> 10% straight / 15% large-pattern-plank — full cartons, one lot.</li>
</ul>`,
  footer_html: `<p>Scale is the one spec you can't judge on a screen. <strong>Roma Flooring Designs</strong> displays full-size pieces from mosaics to slab panels at our Anaheim showroom (1440 S. State College Blvd, Suite 6M) — bring your room dimensions and we'll lay out sizes side by side, plan the layout, and quote supply or supply-and-install on the spot. <a href="/installation">Book a free consultation</a> or call (714) 999-0009.</p>`,
  filter_json: {
    kind: 'guide',
    related: ['porcelain-tile', 'mosaic-tile', 'wood-look-tile'],
    angle: 'common sizes, large-format, how size affects grout lines and room feel, layout.',
    faq: [
      ['What is the most popular tile size?',
       '12x24 is the modern default for floors and bathroom walls — large enough to minimize grout lines and calm a room, small enough to install over typical substrates without special prep. 24x24 and 24x48 are the step up for open, seamless spaces.'],
      ['Is large tile OK in a small bathroom?',
       'Yes — it\'s a myth that small rooms need small tile. Fewer grout lines make a small space feel bigger, and a 12x24 in a powder room looks intentional. The practical limits are avoiding sliver cuts at the walls and using small mosaics where a floor must slope to a drain.'],
      ['What counts as large-format tile?',
       'Any tile with an edge 15 inches or longer. Large format requires a flatter substrate (typically within 1/8" over 10 feet), usually a leveling-clip system during installation, and rectified edges if you want the tight modern grout joints the look implies.'],
      ['What offset should wood-look plank tile use?',
       '33% or less — never a 50% brick offset. Long tiles bow slightly in firing, and a half offset places every crown next to a neighbor\'s low point, guaranteeing lippage. A one-third or random stagger hides the bow completely.'],
      ['How much extra tile should I order?',
       '10% overage for straight lays of medium formats; 15% for large format, planks, diagonal, or herringbone layouts and for small rooms with many cuts. Round up to full cartons from a single lot and keep the spares for future repairs.'],
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
