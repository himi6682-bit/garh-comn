import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "public", "icons");
fs.mkdirSync(dir, { recursive: true });

function png(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4);
  data.copy(out, 8);
  const crc = zlib.crc32(Buffer.concat([Buffer.from(type), data]));
  out.writeUInt32BE(crc >>> 0, 8 + data.length);
  return out;
}

function draw(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= size || py >= size) return;
    const i = (py * size + px) * 4;
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
    pixels[i + 3] = color[3];
  };
  const bg = [16, 14, 12, 255];
  const orange = [239, 106, 50, 255];
  const ink = [26, 16, 12, 255];
  const cream = [246, 241, 232, 255];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) set(x, y, bg);
  }
  const u = size / 512;
  roundRect(set, 48 * u, 48 * u, 416 * u, 416 * u, 96 * u, orange);
  const cx = 256 * u;
  const cy = 292 * u;
  const outer = 118 * u;
  const inner = 78 * u;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (y <= cy + u && d <= outer && d >= inner) set(x, y, ink);
    }
  }
  fillRect(set, cx - outer, cy, outer - inner, 118 * u, ink);
  fillRect(set, cx + inner, cy, outer - inner, 118 * u, ink);
  fillRect(set, cx - outer, cy + 112 * u, outer * 2, 10 * u, cream);
  return pixels;
}

function fillRect(set, x, y, w, h, color) {
  for (let yy = 0; yy < h; yy += 1) {
    for (let xx = 0; xx < w; xx += 1) set(x + xx, y + yy, color);
  }
}

function roundRect(set, x, y, w, h, r, color) {
  for (let yy = 0; yy < h; yy += 1) {
    for (let xx = 0; xx < w; xx += 1) {
      let inside = true;
      if (xx < r && yy < r) inside = (xx - r) ** 2 + (yy - r) ** 2 <= r * r;
      else if (xx >= w - r && yy < r) inside = (xx - (w - r)) ** 2 + (yy - r) ** 2 <= r * r;
      else if (xx < r && yy >= h - r) inside = (xx - r) ** 2 + (yy - (h - r)) ** 2 <= r * r;
      else if (xx >= w - r && yy >= h - r) inside = (xx - (w - r)) ** 2 + (yy - (h - r)) ** 2 <= r * r;
      if (inside) set(x + xx, y + yy, color);
    }
  }
}

for (const size of [32, 192, 512]) {
  fs.writeFileSync(path.join(dir, `icon-${size}.png`), png(size, draw(size)));
}
console.log("Wrote public/icons/icon-32.png, icon-192.png, icon-512.png");
