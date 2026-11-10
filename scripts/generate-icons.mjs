#!/usr/bin/env node
// Generates every app icon from one definition: the "macro ring C" (a ring open on the right, split into the four macro colours).
// No dependencies: the shapes are rasterised here (signed distance fields, supersampled) and written as PNG.
//   node scripts/generate-icons.mjs
// Writes into apps/app/assets/images: icon.png, android-icon-{foreground,background,monochrome}.png, splash-icon.png, favicon.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'app', 'assets', 'images');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
// Kanagawa Wave, the same values as the default dark palette (apps/app/src/theme/palettes-dark.ts).
const PAGE = hex('#1F1F28'); // sumiInk3, the page colour (also the splash / adaptive-icon background in app.json)
const COLORS = [hex('#FFA066'), hex('#98BB6C'), hex('#7FB4CA'), hex('#957FB8')]; // energy surimiOrange, protein springGreen, carbs springBlue, fat oniViolet

// Geometry on a 1024 grid (angles in degrees, counter-clockwise from 3 o'clock; the opening is centred on 0 degrees).
const R = 318; // radius of the ring's centre line
const W = 152; // stroke width
const OPENING = 58; // visual width of the opening on the right
const GAP = 5; // visual gap between two arcs
// The opening on the right makes the ring's bounding box lean left; shift it right so the icon looks optically centred.
const SHIFT = 40;
const WEIGHTS = [1.3, 1, 1, 1]; // relative arc lengths, energy a bit longer

const available = 360 - OPENING - GAP * (WEIGHTS.length - 1);
const weightSum = WEIGHTS.reduce((a, b) => a + b, 0);
const rad = (deg) => (deg * Math.PI) / 180;

/** Arcs of the ring for a given scale: centre-line angles with round caps already subtracted. */
function buildArcs(scale) {
  const r = R * scale;
  const w = W * scale;
  const cx = 512 + SHIFT * scale;
  const cap = (Math.asin(w / 2 / r) * 180) / Math.PI; // a round cap sticks out by w/2 beyond the path end
  let start = OPENING / 2;
  return WEIGHTS.map((weight, i) => {
    const len = (available * weight) / weightSum;
    const a0 = start + cap;
    const a1 = start + len - cap;
    start += len + GAP;
    return { cx, r, w, a0, a1, color: COLORS[i], p0: [cx + r * Math.cos(rad(a0)), 512 - r * Math.sin(rad(a0))], p1: [cx + r * Math.cos(rad(a1)), 512 - r * Math.sin(rad(a1))] };
  });
}

/** Signed distance (grid units) from (x, y) to the stroked arc; negative inside. */
function arcDistance(arc, x, y) {
  const dx = x - arc.cx;
  const dy = 512 - y;
  let theta = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (theta < 0) theta += 360;
  if (theta >= arc.a0 && theta <= arc.a1) return Math.abs(Math.hypot(dx, dy) - arc.r) - arc.w / 2;
  return Math.min(Math.hypot(x - arc.p0[0], y - arc.p0[1]), Math.hypot(x - arc.p1[0], y - arc.p1[1])) - arc.w / 2;
}

function roundRectDistance(x, y, radius) {
  const qx = Math.abs(x - 512) - (512 - radius);
  const qy = Math.abs(y - 512) - (512 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/**
 * Renders to straight RGBA bytes (size x size).
 * options: scale (ring size), mono (one colour for every arc), background ([r,g,b] or null = transparent),
 * backgroundRadius (rounded corners of the background, grid units), ss (supersampling per axis).
 */
function render(size, { scale = 1, mono = null, background = null, backgroundRadius = 0, ss = 3 } = {}) {
  const arcs = buildArcs(scale);
  const big = size * ss;
  const unit = 1024 / big; // grid units per sample
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0; // premultiplied accumulation
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px * ss + sx + 0.5) * 1024) / big;
          const y = ((py * ss + sy + 0.5) * 1024) / big;
          // layer 1: background
          let cr = 0, cg = 0, cb = 0, ca = 0;
          if (background) {
            const cover = backgroundRadius > 0 ? clamp01(0.5 - roundRectDistance(x, y, backgroundRadius) / unit) : 1;
            cr = background[0] * cover; cg = background[1] * cover; cb = background[2] * cover; ca = cover;
          }
          // layer 2: the nearest arc
          let best = Infinity, bestArc = null;
          for (const arc of arcs) {
            const d = arcDistance(arc, x, y);
            if (d < best) { best = d; bestArc = arc; }
          }
          const cover = clamp01(0.5 - best / unit);
          if (cover > 0) {
            const col = mono ?? bestArc.color;
            cr = col[0] * cover + cr * (1 - cover);
            cg = col[1] * cover + cg * (1 - cover);
            cb = col[2] * cover + cb * (1 - cover);
            ca = cover + ca * (1 - cover);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      out[i] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      out[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      out[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- minimal PNG writer ------------------------------------------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** rgba: straight RGBA bytes; withAlpha=false writes an RGB PNG (what the iOS App Store icon must be: no transparency). */
function png(size, rgba, withAlpha) {
  const channels = withAlpha ? 4 : 3;
  const raw = Buffer.alloc(size * (size * channels + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * channels + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (size * channels + 1) + 1 + x * channels;
      raw[dst] = rgba[src]; raw[dst + 1] = rgba[src + 1]; raw[dst + 2] = rgba[src + 2];
      if (withAlpha) raw[dst + 3] = rgba[src + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = withAlpha ? 6 : 2; // 8-bit, RGBA or RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
function write(name, size, options, withAlpha = true) {
  writeFileSync(join(OUT, name), png(size, render(size, options), withAlpha));
  console.log(`wrote ${name} (${size}x${size}${withAlpha ? ', alpha' : ', opaque'})`);
}

// iOS / default icon: full-bleed Kanagawa Wave square (the OS rounds the corners), no transparency.
write('icon.png', 1024, { background: PAGE }, false);
// Android adaptive icon: the OS crops to the central 66 %, so the ring (outer diameter 2*(R+W/2)*scale) must stay inside ~676 px.
const ANDROID_SCALE = 0.86;
write('android-icon-foreground.png', 1024, { scale: ANDROID_SCALE });
write('android-icon-background.png', 1024, { background: PAGE }, false);
write('android-icon-monochrome.png', 1024, { scale: ANDROID_SCALE, mono: [255, 255, 255] });
// Splash: the ring only (the splash background colour is the same page colour, see app.json).
write('splash-icon.png', 512, {});
// Favicon: a bigger ring on a rounded dark tile so it stays readable at 48 px.
write('favicon.png', 48, { scale: 1.12, background: PAGE, backgroundRadius: 200, ss: 6 });
