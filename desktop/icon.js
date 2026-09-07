/**
 * The tray icon, drawn rather than shipped.
 *
 * It was a 1×1 transparent PNG with a comment admitting as much, which on macOS
 * means an invisible menu bar item: the one affordance that keeps the scheduler
 * discoverable was a gap you had to know the position of.
 *
 * Generated at launch instead of committed as a binary. It costs under a
 * millisecond for a 32×32 image, it keeps the repository free of assets nobody
 * can review in a diff, and it means the icon is the same three lines of
 * geometry as the mark in the sidebar — a rounded square with a smaller square
 * knocked out of the middle — rather than a picture of it that drifts.
 *
 * Drawn as a **template image**: every pixel black, with the shape carried
 * entirely in the alpha channel. That is the contract macOS wants, and it is
 * what makes the icon invert by itself in a dark menu bar instead of
 * disappearing into it.
 */

import zlib from 'node:zlib';

/** Signed distance to a rounded rectangle centred on the origin. */
function roundedRect(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - (halfW - radius);
  const dy = Math.abs(y) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Coverage of the shape at one pixel, 0..1.
 *
 * Sampled on a 3×3 grid inside the pixel rather than taken at its centre. At
 * 16 points across a whole glyph, the difference between antialiased and not is
 * the difference between a mark and a smudge.
 */
function coverage(px, py, size) {
  const scale = size / 32;
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = (px + (sx + 0.5) / 3 - size / 2) / scale;
      const y = (py + (sy + 0.5) / 3 - size / 2) / scale;
      // The body, then the square taken out of its middle.
      const inBody = roundedRect(x, y, 13, 13, 4.5) <= 0;
      const inHole = roundedRect(x, y, 4.5, 4.5, 1.8) <= 0;
      if (inBody && !inHole) hits++;
    }
  }
  return hits / 9;
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A square RGBA PNG of the mark, `size` pixels on a side. */
export function trayIconPng(size = 32) {
  // One filter byte per row, then RGBA. Black throughout; the shape is alpha.
  const raw = Buffer.alloc(size * (1 + size * 4));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      p += 3; // r,g,b stay 0
      raw[p++] = Math.round(coverage(x, y, size) * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
