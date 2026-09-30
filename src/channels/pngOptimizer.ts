// src/channels/pngOptimizer.ts
// 通道出站 PNG 的体积优化：无损，失败时原样返回输入。
//
// 背景：headless Chrome 的 `Page.captureScreenshot` 对文字类内容（代码块、表格）
// 压缩得很差 —— RGB8 全彩编码把几十种颜色展开成每像素 3 字节，deflate 已饱和。
// 这类图像的用色数远低于 256，按 PNG 规范转成 8-bit 索引色（colorType 3）后
// 像素数据直接 ×3 变小，deflate 再压一层，代码块/表格能省 60–85%。
//
// 约束（按序判断，任何一条不满足就原样返回输入）：
//  - 只处理非隔行、8-bit、RGB / 全不透明 RGBA 的 PNG；
//  - 用色数 > 256（照片、渐变）无法无损索引，直接放弃 —— 不做有损量化；
//  - 重编码结果必须严格小于输入，否则保留原字节。
// 所以这是纯函数：`optimizePng(png)` 的输出要么是更小的等价 PNG，要么就是输入。

import { inflateSync, deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

interface ParsedPng {
  width: number;
  height: number;
  /** 反滤波后的像素，RGB 三元组，不透明；已丢弃原 alpha（全 255 由调用方保证）。 */
  rgb: Uint8Array;
}

/**
 * 解析并反滤波成 RGB 像素。只接受能无损转调色板的情况：
 * 非隔行、8-bit、colorType 2（RGB）或 colorType 6 且 alpha 全 255（RGBA）。
 * 其余（灰度/16-bit/带透明/隔行/结构异常）返回 null，调用方走原样返回。
 */
function parseRgbPng(png: Uint8Array): ParsedPng | null {
  if (png.length < 57) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null;

  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (pos + 12 <= png.length) {
    const length = view.getUint32(pos);
    if (length > 0x7fffffff || pos + 12 + length > png.length) return null;
    const type = String.fromCharCode(png[pos + 4], png[pos + 5], png[pos + 6], png[pos + 7]);
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      bitDepth = png[pos + 16];
      colorType = png[pos + 17];
      interlace = png[pos + 20];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }
  if (!width || !height || !idat.length) return null;
  if (bitDepth !== 8 || interlace !== 0) return null;
  if (colorType !== 2 && colorType !== 6) return null;

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  } catch {
    return null;
  }
  if (raw.length !== (stride + 1) * height) return null;

  const rgb = new Uint8Array(width * height * 3);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    // PNG 过滤是按字节在通道上可分的： bpp=channels 字节，跨像素可预测。
    const bpp = channels;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = row[i]; break;
        case 1: v = row[i] + a; break;
        case 2: v = row[i] + b; break;
        case 3: v = row[i] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      cur[i] = v & 0xff;
    }
    if (colorType === 6) {
      for (let x = 0; x < width; x++) {
        if (cur[x * 4 + 3] !== 255) return null;
        rgb[(y * width + x) * 3] = cur[x * 4];
        rgb[(y * width + x) * 3 + 1] = cur[x * 4 + 1];
        rgb[(y * width + x) * 3 + 2] = cur[x * 4 + 2];
      }
    } else {
      rgb.set(cur.subarray(0, width * 3), y * width * 3);
    }
    prev.set(cur);
  }
  return { width, height, rgb };
}

interface Palette {
  /** 索引 → 24bit 颜色。 */
  colors: number[];
  /** 24bit 颜色 → 索引；命中即无损。 */
  index: Map<number, number>;
}

/** 首次遍历建调色板；超过 maxColors 立即失败，避免在照片上白扫。 */
function buildPalette(rgb: Uint8Array, maxColors: number): Palette | null {
  const colors: number[] = [];
  const index = new Map<number, number>();
  for (let i = 0; i < rgb.length; i += 3) {
    const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    if (!index.has(key)) {
      if (colors.length >= maxColors) return null;
      index.set(key, colors.length);
      colors.push(key);
    }
  }
  return { colors, index };
}

function rleFilterPaeth(indices: Uint8Array, stride: number, height: number, level: number): Uint8Array {
  const bpp = 1;
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = indices.subarray(y * stride, (y + 1) * stride);
    const rowStart = y * (stride + 1);
    out[rowStart] = level;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? indices[y * stride + i - bpp] : 0;
      const b = y > 0 ? indices[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? indices[(y - 1) * stride + i - bpp] : 0;
      let d: number;
      switch (level) {
        case 0: d = row[i]; break;
        case 1: d = row[i] - a; break;
        case 2: d = row[i] - b; break;
        case 3: d = row[i] - ((a + b) >> 1); break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          d = row[i] - pred;
        }
      }
      out[rowStart + 1 + i] = d & 0xff;
    }
  }
  return out;
}

function encodeIndexedPng(palette: Palette, indices: Uint8Array, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: indexed
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const plte = Buffer.alloc(palette.colors.length * 3);
  palette.colors.forEach((key, i) => {
    plte[i * 3] = (key >>> 16) & 0xff;
    plte[i * 3 + 1] = (key >>> 8) & 0xff;
    plte[i * 3 + 2] = key & 0xff;
  });

  const stride = width;
  // 8-bit 索引行的小数据集上，up/up-average/paeth 通常比 none/sub 更利于
  // deflate；逐个试一遍取最小，成本可控（每遍都是 deflate level 9）。
  const candidates: Buffer[] = [];
  for (const level of [2, 4, 1, 0]) {
    const filtered = rleFilterPaeth(indices, stride, height, level);
    candidates.push(deflateSync(Buffer.from(filtered), { level: 9 }));
  }
  const best = candidates.reduce((a, b) => (b.length < a.length ? b : a));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', best),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

export interface PngOptimization {
  /** 输出 PNG 字节；无法优化时与输入相同。 */
  data: Uint8Array;
  /** 是否发生了重编码。 */
  applied: boolean;
  /** applied 时为 true 表示用色 ≤ 256 的无损索引化。 */
  lossless: boolean;
  originalBytes: number;
  optimizedBytes: number;
}

function unchanged(png: Uint8Array): PngOptimization {
  return { data: png, applied: false, lossless: true, originalBytes: png.length, optimizedBytes: png.length };
}

/** 何时允许把边缘 AA 色并进代表色：对纯色文字区是安全差。 */
const MERGE_MAX_COLORS = 256;
const MERGE_DISTANCE = 12;
const MERGE_MIN_PIXELS = 4;

/**
 * 有界误差合并：把距离 ≤ MERGE_DISTANCE 的低频色并入最近的代表色。
 * 目标是把「文字主体 + 少量抗锯齿中间色」压回 256 色；颜色多样的图像
 * （照片/渐变/复杂图表）合并不动它们，整体放弃。
 */
function mergeIntoPalette(palette: Palette, rgb: Uint8Array): Palette | null {
  const counts = new Map<number, number>();
  for (let i = 0; i < rgb.length; i += 3) {
    const key = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const merged = new Map<number, number>(palette.index);
  const colors = [...palette.colors];
  for (const [key, count] of counts) {
    if (merged.has(key)) continue;
    if (count >= MERGE_MIN_PIXELS) return null; // 超出代表色的色是主体色，不是边缘
    const r = (key >>> 16) & 0xff;
    const g = (key >>> 8) & 0xff;
    const b = key & 0xff;
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const dr = r - ((c >>> 16) & 0xff);
      const dg = g - ((c >>> 8) & 0xff);
      const db = b - (c & 0xff);
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestDist > MERGE_DISTANCE * MERGE_DISTANCE) return null;
    merged.set(key, bestIdx);
  }
  return { colors, index: merged };
}

/**
 * 出站 PNG 的体积优化入口：能索引就重编码，否则原样返回。
 * 输出必须严格小于输入才被采用；任何解析/编码异常都落到原样返回。
 */
export function optimizePng(png: Uint8Array): PngOptimization {
  try {
    if (png.length < 1024) return unchanged(png); // 小图没有可省的空间
    const parsed = parseRgbPng(png);
    if (!parsed) return unchanged(png);

    const { width, height, rgb } = parsed;
    let palette = buildPalette(rgb, MERGE_MAX_COLORS);
    let lossless = true;
    if (!palette) {
      // 真实截图的文字/图形边缘有抗锯齿中间色，精确 256 常差一点；
      // 只把贴着代表色的低频色并进去，文字主体像素不动。
      const base = buildPalette(rgb, Infinity);
      if (!base) return unchanged(png);
      palette = mergeIntoPalette(base, rgb);
      if (!palette) return unchanged(png); // 颜色太多样：照片/渐变，不动
      lossless = false;
    }

    const indices = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < rgb.length; p += 3, i++) {
      const idx = palette.index.get((rgb[p] << 16) | (rgb[p + 1] << 8) | rgb[p + 2]);
      if (idx === undefined) return unchanged(png); // 不应发生；守住无损底线
      indices[i] = idx;
    }
    const encoded = encodeIndexedPng(palette, indices, width, height);
    if (encoded.length >= png.length) return unchanged(png);
    return { data: new Uint8Array(encoded), applied: true, lossless, originalBytes: png.length, optimizedBytes: encoded.length };
  } catch {
    return unchanged(png);
  }
}

/**
 * 诊断：解析后统计唯一颜色数；不支持的 PNG 返回 null。
 */
export function countUniqueColors(png: Uint8Array): number | null {
  try {
    const parsed = parseRgbPng(png);
    if (!parsed) return null;
    const colors = new Set<number>();
    for (let i = 0; i < parsed.rgb.length; i += 3) colors.add((parsed.rgb[i] << 16) | (parsed.rgb[i + 1] << 8) | parsed.rgb[i + 2]);
    return colors.size;
  } catch {
    return null;
  }
}

/**
 * 带诊断的包装：返回优化结果与一条可选说明（用于日志/验收输出）。
 */
export function measureOptimization(png: Uint8Array): PngOptimization & { note: string } {
  const result = optimizePng(png);
  if (!result.applied) return { ...result, note: '原样保留（非全彩截图或无收益）' };
  const saved = result.originalBytes - result.optimizedBytes;
  const percent = ((saved / result.originalBytes) * 100).toFixed(0);
  return { ...result, note: `${result.lossless ? '无损索引化' : '有界误差索引化'}：${result.originalBytes} → ${result.optimizedBytes} 字节（省 ${percent}%）` };
}

/**
 * 供通道投递路径使用的容错包装：优化失败时静默回退原字节。
 */
export function gracefulPng(png: Uint8Array): Uint8Array {
  return optimizePng(png).data;
}
