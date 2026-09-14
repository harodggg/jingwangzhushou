/**
 * 纯 Node.js 生成扩展图标（不依赖任何第三方库）
 * 图形：蓝色渐变圆角方块 + 白色漏斗（过滤）+ 红色斜杠（拦截）
 * 用法：node tools/make-icons.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 图形绘制 ---------------- */
function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

/** 圆角矩形覆盖率（超采样点是否在图形内） */
function inRoundRect(x, y, r) {
  const ax = Math.abs(x), ay = Math.abs(y);
  if (ax > 1 || ay > 1) return false;
  if (ax <= 1 - r || ay <= 1 - r) return true;
  const dx = ax - (1 - r), dy = ay - (1 - r);
  return dx * dx + dy * dy <= r * r;
}

/** 漏斗形状：上部倒三角 + 下方细颈 */
function inFunnel(x, y) {
  // y: -0.72(顶) -> 0.72(底)
  if (y < -0.72 || y > 0.78) return false;
  if (y <= 0.14) {
    const t = (y + 0.72) / 0.86;          // 0 -> 1
    const half = 0.66 * (1 - t) + 0.085;  // 0.66 -> 0.085
    return Math.abs(x) <= half;
  }
  return Math.abs(x) <= 0.085;
}

/** 从左下到右上的斜杠 */
function inSlash(x, y) {
  if (y < -0.95 || y > 0.95) return false;
  const cx = -y * 0.95; // 斜线方程 x = -y
  const dist = Math.abs(x - cx) / Math.SQRT2;
  return dist <= 0.115 && Math.abs(x) <= 0.98 && Math.abs(y) <= 0.98;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // 每像素 4x4 超采样
  const top = [59, 130, 246];
  const bottom = [29, 78, 216];
  const white = [255, 255, 255];
  const red = [220, 38, 38];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = ((px + (sx + 0.5) / SS) / size) * 2 - 1;
          const ny = ((py + (sy + 0.5) / SS) / size) * 2 - 1;
          if (!inRoundRect(nx, ny, 0.42)) continue;

          const bg = mix(top, bottom, (ny + 1) / 2);
          let color = bg;
          if (inFunnel(nx, ny)) color = white;
          if (inSlash(nx, ny)) color = red;

          r += color[0]; g += color[1]; b += color[2]; a += 255;
        }
      }
      const total = SS * SS;
      const i = (py * size + px) * 4;
      if (a === 0) continue;
      // 已按覆盖采样平均，alpha 反映边缘覆盖率
      const covered = a / 255;
      rgba[i] = Math.round(r / covered);
      rgba[i + 1] = Math.round(g / covered);
      rgba[i + 2] = Math.round(b / covered);
      rgba[i + 3] = Math.round((covered / total) * 255);
    }
  }
  return encodePNG(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('generated', path.relative(path.join(__dirname, '..'), file), fs.statSync(file).size, 'bytes');
}
