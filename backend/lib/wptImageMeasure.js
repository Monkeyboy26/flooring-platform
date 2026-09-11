/**
 * Measure a WPT image buffer: real dimensions + pixel stats used to detect
 * documentation/filler slides (see isFillerStats in wptImages.js). Downscales
 * to a small sample for cheap, resolution-independent stats.
 *
 * `edgeFrac` is the fraction of strong-gradient pixels — a mosaic sheet's grid of
 * grout lines reads much higher than a plain field-tile swatch, so it's used to
 * demote mosaic images from primary (see classifyImages).
 *
 * @param {Buffer} buf
 * @returns {Promise<{width:number,height:number,whiteFrac:number,saturation:number,meanBright:number,edgeFrac:number}|null>}
 */
import sharp from 'sharp';

export async function analyzeImageBuffer(buf) {
  try {
    const img = sharp(buf);
    const md = await img.metadata();
    if (!md.width || !md.height) return null;
    const S = 64;
    const raw = await img.clone().resize(S, S, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
    const n = S * S;
    let white = 0, satSum = 0, brightSum = 0;
    const gray = new Float32Array(n);
    for (let p = 0, i = 0; i < raw.length; i += 3, p++) {
      const r = raw[i], g = raw[i + 1], b = raw[i + 2];
      if (r > 238 && g > 238 && b > 238) white++;
      satSum += Math.max(r, g, b) - Math.min(r, g, b);
      brightSum += (r + g + b) / 3;
      gray[p] = (r + g + b) / 3;
    }
    // Edge density: |dx|+|dy| gradient over the grayscale grid.
    let edges = 0;
    for (let y = 0; y < S - 1; y++) {
      for (let x = 0; x < S - 1; x++) {
        const idx = y * S + x;
        const gx = Math.abs(gray[idx] - gray[idx + 1]);
        const gy = Math.abs(gray[idx] - gray[idx + S]);
        if (gx + gy > 40) edges++;
      }
    }
    return {
      width: md.width,
      height: md.height,
      whiteFrac: white / n,
      saturation: satSum / n,
      meanBright: brightSum / n,
      edgeFrac: edges / ((S - 1) * (S - 1)),
    };
  } catch {
    return null;
  }
}
