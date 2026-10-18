// Renders the legacy (pre-Android 8) launcher PNGs from the Ascent chevron logo
// (public/icon.svg). Android 8+ uses the vector adaptive icon in
// android/app/src/main/res/drawable/ic_launcher_foreground.xml instead.
// No dependencies: rasterises the three round-capped polylines directly.
//   node scripts/android-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = join(dirname(fileURLToPath(import.meta.url)), '../android/app/src/main/res');
const BG = [0x03, 0x07, 0x12];
// Same geometry/colours as public/icon.svg (viewBox 0 0 32 32, stroke-width 3).
const CHEVRONS = [
  { pts: [[4, 28], [16, 20], [28, 28]], rgb: [0x43, 0x38, 0xca], a: 0.45 },
  { pts: [[6, 20], [16, 12], [26, 20]], rgb: [0x63, 0x66, 0xf1], a: 0.72 },
  { pts: [[8, 12], [16, 4], [24, 12]], rgb: [0xc4, 0xb5, 0xfd], a: 1 },
];
const HALF_STROKE = 1.5;

function distToSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function render(size, round) {
  const px = Buffer.alloc(size * size * 4);
  const logo = size * 0.62;            // logo occupies ~62% of the icon
  const off = (size - logo) / 2;
  const unit = logo / 32;
  const SS = 4;                         // 4x4 supersampling
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, cover = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      // Background shape: circle (round icon) or rounded square.
      const cx = fx - size / 2, cy = fy - size / 2;
      let inside;
      if (round) inside = Math.hypot(cx, cy) <= size / 2;
      else {
        const rad = size * 0.18, h = size / 2 - rad;
        inside = Math.hypot(Math.max(Math.abs(cx) - h, 0), Math.max(Math.abs(cy) - h, 0)) <= rad;
      }
      if (!inside) continue;
      let c = [...BG];
      const lx = (fx - off) / unit, ly = (fy - off) / unit;
      for (const ch of CHEVRONS) {
        const d = Math.min(distToSeg(lx, ly, ch.pts[0], ch.pts[1]), distToSeg(lx, ly, ch.pts[1], ch.pts[2]));
        if (d <= HALF_STROKE) c = c.map((v, i) => v * (1 - ch.a) + ch.rgb[i] * ch.a);
      }
      r += c[0]; g += c[1]; b += c[2]; cover++;
    }
    const i = (y * size + x) * 4;
    if (cover) { px[i] = r / cover; px[i + 1] = g / cover; px[i + 2] = b / cover; }
    px[i + 3] = Math.round((cover / (SS * SS)) * 255);
  }
  return png(size, px);
}

function png(size, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const v of buf) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(DENSITIES)) {
  const dir = join(RES, `mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ic_launcher.png'), render(size, false));
  writeFileSync(join(dir, 'ic_launcher_round.png'), render(size, true));
  console.log(`mipmap-${d}: ${size}px`);
}
