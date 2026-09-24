// Generates EmailDigest PWA icons.
// Background: dark (#0a0a0a) circle slightly inset; text "ED" white center.
// 3 outputs: icon-192 (any), icon-512 (any), icon-512-maskable (safe-zone),
// plus apple-touch-icon (180x180).
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const BG = "#0a0a0a";
const FG = "#ffffff";
const ACCENT = "#7ab7ff";

function svg(size, opts = {}) {
  const { padding = 0, accent = ACCENT } = opts;
  const inner = size - padding * 2;
  // "ED" mark — circle with monogram
  const radius = inner * 0.42;
  const cx = size / 2;
  const cy = size / 2;
  const fontSize = inner * 0.42;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${accent}" stroke-width="${size * 0.025}" stroke-opacity="0.5"/>
  <text x="${cx}" y="${cy + fontSize * 0.34}" text-anchor="middle"
        font-family="system-ui, -apple-system, 'Helvetica Neue', sans-serif"
        font-weight="700" font-size="${fontSize}" fill="${FG}" letter-spacing="-2">ED</text>
</svg>`;
}

const PUBLIC = path.resolve(process.cwd(), "public");

async function render(size, name, opts) {
  const buf = Buffer.from(svg(size, opts));
  const out = path.join(PUBLIC, name);
  await sharp(buf).png({ compressionLevel: 9 }).toFile(out);
  console.log(`wrote ${name}`);
}

await render(192, "icon-192.png");
await render(512, "icon-512.png");
// Maskable: keep safe zone — 80% of canvas. Pad inside the SVG so the BG
// fills full canvas (Android home-screen mask doesn't cut the BG).
await render(512, "icon-512-maskable.png", { padding: 51 });
// iOS apple-touch-icon: 180x180, no transparency.
await render(180, "apple-touch-icon.png");
