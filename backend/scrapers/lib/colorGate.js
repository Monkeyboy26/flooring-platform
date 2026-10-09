// Pixel color gate — shared trimmed-mid-tone color comparison.
//
// Extracted verbatim from bosphorus.js so the MSI matcher (and any other
// scraper) can reuse the same calibrated gate. Downscale to 64x64, sort pixels
// by luminance, average the middle two quartiles (ignores shadows/highlights).
// Thresholds calibrated on the 2026-10 audit: catches obvious color swaps
// (Calypso Dark dL 97 / Forma Black dL 100) while keeping correct pairs (Memory
// Cobalt Blue dL 20, Forma White dL 66).
//
// IMPORTANT: a true black tile shot on a white background legitimately reads
// light (Arrow Black dL 71). So this gate must NOT be the sole authority to
// reject a filename/SKU-verified match — use it only to confirm a safe
// overwrite, veto a cross-reference promotion, or raise a flag.

export const COLOR_GATE_MAX_DL = 70;  // luminance
export const COLOR_GATE_MAX_DBY = 28; // yellow-blue axis
export const COLOR_GATE_MAX_DA = 22;  // red-green axis

let sharpModulePromise = null;
export function loadSharp() {
  if (!sharpModulePromise) {
    sharpModulePromise = import('sharp').then(m => m.default).catch(() => null);
  }
  return sharpModulePromise;
}

/**
 * Trimmed mid-tone color stats for an image URL: downscale to 64x64, sort
 * pixels by luminance, average the middle two quartiles. Returns
 * {L, by, aa} or null on any failure (callers treat null as "can't verify").
 */
export async function fetchColorStats(url, cache) {
  if (cache.has(url)) return cache.get(url);
  let stats = null;
  try {
    const sharp = await loadSharp();
    if (sharp) {
      // Accept either an http(s) URL (remote fetch) or a local filesystem path
      // (e.g. a downloaded /uploads image) — the MSI matcher compares a remote
      // CDN guess against an already-local sibling, which has no public URL.
      let buf = null;
      if (/^https?:\/\//i.test(url)) {
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(20000),
        });
        if (resp.ok) buf = Buffer.from(await resp.arrayBuffer());
      } else {
        const fs = await import('fs');
        if (fs.existsSync(url)) buf = fs.readFileSync(url);
      }
      if (buf) {
        const S = 64;
        const raw = await sharp(buf).resize(S, S, { fit: 'fill' })
          .removeAlpha().toColourspace('srgb').raw().toBuffer();
        const px = [];
        for (let i = 0; i < raw.length; i += 3) {
          const r = raw[i], g = raw[i + 1], b = raw[i + 2];
          px.push([(r + g + b) / 3, (r + g) / 2 - b, r - g]);
        }
        px.sort((a, b2) => a[0] - b2[0]);
        const mid = px.slice(px.length >> 2, (3 * px.length) >> 2);
        const n = mid.length || 1;
        stats = {
          L: mid.reduce((s, p) => s + p[0], 0) / n,
          by: mid.reduce((s, p) => s + p[1], 0) / n,
          aa: mid.reduce((s, p) => s + p[2], 0) / n,
        };
      }
    }
  } catch { /* stats stays null */ }
  cache.set(url, stats);
  return stats;
}

/** True when two images are plausibly the same color.
 *  Fail-closed: any fetch/decode failure returns false (can't verify). */
export async function colorsMatch(aUrl, bUrl, cache) {
  const [a, b] = await Promise.all([
    fetchColorStats(aUrl, cache), fetchColorStats(bUrl, cache),
  ]);
  if (!a || !b) return false;
  return Math.abs(a.L - b.L) <= COLOR_GATE_MAX_DL
    && Math.abs(a.by - b.by) <= COLOR_GATE_MAX_DBY
    && Math.abs(a.aa - b.aa) <= COLOR_GATE_MAX_DA;
}
