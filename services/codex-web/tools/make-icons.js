/**
 * 生成 PWA 图标（零依赖：手写 PNG 编码 + 自己光栅化）。
 * 图形就是终端里的 `>_` 提示符：蓝色底 + 白色箭头和下划线。
 *
 * 用法: node tools/make-icons.js
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

// ---------------------------------------------------------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
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
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array(size*size*4) → PNG Buffer */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 光栅化
const BG = [79, 140, 255];      // --accent
const FG = [255, 255, 255];

/** 点到线段的最短距离。 */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function roundedAlpha(x, y, size, radius) {
  // 圆角矩形覆盖率（只在四角做判断）
  const r = radius;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  const d = Math.hypot(x - cx, y - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}

function render(size, { maskable }) {
  const rgba = new Uint8Array(size * size * 4);
  // maskable 留安全区：图形缩到中间 62%；普通图标圆角 22%
  const s = maskable ? 0.62 : 0.78;
  const off = (1 - s) / 2;
  const X = (v) => (off + v * s) * size;
  const Y = (v) => (off + v * s) * size;
  const thick = Math.max(1.6, 0.062 * s * size);

  // `>` 两段折线
  const A = [X(0.16), Y(0.22)], B = [X(0.46), Y(0.50)], C = [X(0.16), Y(0.78)];
  // 下划线
  const ux0 = X(0.56), ux1 = X(0.88), uy0 = Y(0.72), uy1 = Y(0.80);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;

      // 字形覆盖率
      const dChev = Math.min(
        distToSegment(px, py, A[0], A[1], B[0], B[1]),
        distToSegment(px, py, B[0], B[1], C[0], C[1]),
      );
      const chev = Math.max(0, Math.min(1, thick / 2 + 0.5 - dChev));
      const inU = px >= ux0 && px <= ux1 && py >= uy0 && py <= uy1;
      const glyph = Math.max(chev, inU ? 1 : 0);

      const a = maskable ? 1 : roundedAlpha(px, py, size, size * 0.22);
      const r = BG[0] + (FG[0] - BG[0]) * glyph;
      const g = BG[1] + (FG[1] - BG[1]) * glyph;
      const b = BG[2] + (FG[2] - BG[2]) * glyph;

      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
const jobs = [
  ["icon-192.png", 192, { maskable: false }],
  ["icon-512.png", 512, { maskable: false }],
  ["maskable-512.png", 512, { maskable: true }],
];
for (const [name, size, opts] of jobs) {
  const buf = render(size, opts);
  writeFileSync(join(OUT, name), buf);
  console.log(`  ${name}  ${size}x${size}  ${buf.length} bytes`);
}
console.log("图标生成完毕 →", OUT);
