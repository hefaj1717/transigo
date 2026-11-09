// Generates the TEMPORARY carrier PWA icons (D104): navy background #0B3B8C with a white "T".
// No dependencies (PNG encoded by hand with zlib). To use a real logo, replace the PNG files in
// public/padroncino/icons/ (same names and sizes) — this script is then no longer needed.
// Run: node scripts/generate-pwa-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BG = [0x0b, 0x3b, 0x8c];
const FG = [0xff, 0xff, 0xff];
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "padroncino", "icons");

// [file, size, scale of the letter: 1 = full icon, < 1 = inside the maskable safe zone]
const ICONS = [
  ["icon-192.png", 192, 1],
  ["icon-512.png", 512, 1],
  ["icon-maskable-512.png", 512, 0.72],
  ["apple-touch-icon.png", 180, 0.9],
];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** True when pixel (x, y) belongs to the "T" (a bar and a stem, centred, scaled around the centre). */
function inLetter(x, y, size, scale) {
  // Coordinates relative to the centre, in units of the icon size, divided by the scale.
  const u = (x + 0.5 - size / 2) / size / scale;
  const v = (y + 0.5 - size / 2) / size / scale;
  const bar = Math.abs(u) <= 0.28 && v >= -0.28 && v <= -0.14;
  const stem = Math.abs(u) <= 0.08 && v >= -0.28 && v <= 0.3;
  return bar || stem;
}

function png(size, scale) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = inLetter(x, y, size, scale) ? FG : BG;
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [file, size, scale] of ICONS) {
  writeFileSync(join(OUT, file), png(size, scale));
  console.log(`public/padroncino/icons/${file} (${size}×${size})`);
}
