// Generate a 1024×1024 source app icon (PNG) with zero dependencies (pure Node zlib).
// Placeholder brand mark: a bullseye/target on a blue rounded square (ASO = targeting keywords).
// Replace icons/icon.png with real artwork and re-run make-icons.sh to regenerate the set.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1024, H = 1024;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons", "icon.png");

const ACCENT = [68, 88, 232];
const ACCENT_DARK = [38, 52, 150];
const WHITE = [245, 247, 255];

const cx = W / 2, cy = H / 2;
const pad = 40, radius = 190;

function insideRoundedRect(x, y) {
  const x0 = pad, y0 = pad, x1 = W - pad, y1 = H - pad;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const r = Math.min(radius, (x1 - x0) / 2);
  const corners = [
    [x0 + r, y0 + r, x < x0 + r && y < y0 + r],
    [x1 - r, y0 + r, x > x1 - r && y < y0 + r],
    [x0 + r, y1 - r, x < x0 + r && y > y1 - r],
    [x1 - r, y1 - r, x > x1 - r && y > y1 - r],
  ];
  for (const [ccx, ccy, active] of corners) {
    if (active) return Math.hypot(x - ccx, y - ccy) <= r;
  }
  return true;
}

// Raw image: per row a filter byte (0) then RGBA pixels.
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4);
  raw[rowStart] = 0;
  for (let x = 0; x < W; x++) {
    const o = rowStart + 1 + x * 4;
    if (!insideRoundedRect(x, y)) {
      raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 0; raw[o + 3] = 0;
      continue;
    }
    const d = Math.hypot(x - cx, y - cy);
    let col;
    if (d < 78 || (d >= 168 && d <= 236)) {
      col = WHITE;
    } else {
      // vertical gradient accent → accent-dark
      const t = y / H;
      col = [
        Math.round(ACCENT[0] * (1 - t) + ACCENT_DARK[0] * t),
        Math.round(ACCENT[1] * (1 - t) + ACCENT_DARK[1] * t),
        Math.round(ACCENT[2] * (1 - t) + ACCENT_DARK[2] * t),
      ];
    }
    raw[o] = col[0]; raw[o + 1] = col[1]; raw[o + 2] = col[2]; raw[o + 3] = 255;
  }
}

// ── minimal PNG writer ──
const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const idat = deflateSync(raw, { level: 9 });
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes, ${W}×${H})`);
