// src/channels/__tests__/pngOptimizer.test.ts
import { describe, expect, test } from 'bun:test';
import { deflateSync, inflateSync } from 'node:zlib';
import { measureOptimization, optimizePng } from '../pngOptimizer';

// ── 测试内 PNG 编解码（最小实现，仅覆盖被测路径） ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeRgbPng(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => [number, number, number],
  opts: { colorType?: 2 | 6; bitDepth?: number; interlace?: number } = {},
): Buffer {
  const channels = (opts.colorType ?? 2) === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y);
      const o = y * (stride + 1) + 1 + x * channels;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      if (channels === 4) raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = opts.bitDepth ?? 8;
  ihdr[9] = opts.colorType ?? 2;
  ihdr[12] = opts.interlace ?? 0;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** 解码 colorType 3 的输出，返回 [索引 → 颜色, 每像素颜色]，用于无损断言。 */
function decodeIndexed(png: Buffer): { palette: [number, number, number][]; pixels: [number, number, number][] } {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let plte: Buffer = Buffer.alloc(0);
  while (pos + 12 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect(data[8]).toBe(8);
      expect(data[9]).toBe(3);
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const palette: [number, number, number][] = [];
  for (let i = 0; i < plte.length; i += 3) palette.push([plte[i], plte[i + 1], plte[i + 2]]);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width;
  const pixels: [number, number, number][] = [];
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= 1 ? cur[i - 1] : 0;
      const b = prev[i];
      const c = i >= 1 ? prev[i - 1] : 0;
      let v: number;
      if (filter === 0) v = row[i];
      else if (filter === 1) v = row[i] + a;
      else if (filter === 2) v = row[i] + b;
      else if (filter === 3) v = row[i] + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) pixels.push(palette[cur[x]]);
    prev.set(cur);
  }
  return { palette, pixels };
}

// ── 样本 ──

const PALETTE_COLORS: [number, number, number][] = [
  [255, 255, 255], [24, 24, 27], [6, 182, 212], [59, 130, 246], [239, 68, 68], [34, 197, 94], [234, 179, 8],
];

/** 模拟代码块截图：低色数 + 帧内残差噪声（filter 残差高熵，RGB 编码压不动）。 */
function codeLikePng(width = 256, height = 200, colorType: 2 | 6 = 2): { png: Buffer; pixels: Uint8Array } {
  const channels = colorType === 6 ? 4 : 3;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pixels = new Uint8Array(width * height * 3);
  const png = makeRgbPng(width, height, (x, y) => {
    const jitter = rand() < 0.15 ? 1 : 0;
    const base = PALETTE_COLORS[(x * 7 + y * 13) % PALETTE_COLORS.length];
    const px: [number, number, number] = [(base[0] + jitter) & 0xff, (base[1] + jitter) & 0xff, (base[2] + jitter) & 0xff];
    pixels.set(px, (y * width + x) * 3);
    return px;
  }, { colorType });
  return { png, pixels };
}

// ── 用例 ──

describe('pngOptimizer', () => {
  test('低色数 RGB 截图：无损索引化且逐像素等价', () => {
    const { png: input, pixels } = codeLikePng();
    const result = measureOptimization(input);
    expect(result.applied).toBe(true);
    expect(result.lossless).toBe(true);
    expect(result.optimizedBytes).toBeLessThan(result.originalBytes);
    const decoded = decodeIndexed(Buffer.from(result.data));
    expect(decoded.palette.length).toBeLessThanOrEqual(256);
    for (let i = 0; i < decoded.pixels.length; i++) {
      expect(decoded.pixels[i]).toEqual([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]);
    }
  });

  test('帧内已平滑的色块图：优化后严格更小', () => {
    const input = makeRgbPng(400, 300, (x, y) => PALETTE_COLORS[(x > 200 ? 2 : 0) + (y > 150 ? 3 : 0)]);
    const result = optimizePng(input);
    expect(result.applied).toBe(true);
    expect(result.data.length).toBeLessThan(input.length);
  });

  test('超过 256 色（渐变）：原样保留', () => {
    const input = makeRgbPng(64, 64, (x, y) => [x * 4, y * 4, (x + y) * 2]);
    const result = optimizePng(input);
    expect(result.applied).toBe(false);
    expect(Buffer.from(result.data)).toEqual(Buffer.from(input));
  });

  test('RGBA 全不透明：可优化且无损', () => {
    const { png: input, pixels } = codeLikePng(160, 120, 6);
    const result = optimizePng(input);
    expect(result.applied).toBe(true);
    const decoded = decodeIndexed(Buffer.from(result.data));
    for (let i = 0; i < decoded.pixels.length; i++) {
      expect(decoded.pixels[i]).toEqual([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]);
    }
  });

  test('RGBA 带半透明像素：原样保留', () => {
    const input = makeRgbPng(64, 64, (x, y) => (x === y ? [0, 0, 0] : [255, 255, 255]), { colorType: 6 });
    // 把其中一个 alpha 改成 128：直接构造 raw
    const raw = Buffer.alloc((64 * 4 + 1) * 64);
    for (let y = 0; y < 64; y++) {
      raw[y * (64 * 4 + 1)] = 0;
      for (let x = 0; x < 64; x++) {
        const o = y * (64 * 4 + 1) + 1 + x * 4;
        raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255;
        raw[o + 3] = x === y ? 128 : 255;
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(64, 0);
    ihdr.writeUInt32BE(64, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
    const result = optimizePng(png);
    expect(result.applied).toBe(false);
    void input;
  });

  test('灰度 / 16-bit / 隔行：原样保留', () => {
    const gray = makeRgbPng(16, 16, () => [0, 0, 0], { colorType: 2, bitDepth: 16 });
    expect(optimizePng(gray).applied).toBe(false);
    const interlaced = makeRgbPng(16, 16, () => [0, 0, 0], { interlace: 1 });
    expect(optimizePng(interlaced).applied).toBe(false);
  });

  test('损坏输入（坏签名 / 假 CRC / 截断）：原样保留不抛异常', () => {
    const good = codeLikePng(32, 32).png;
    const badSignature = Buffer.from(good);
    badSignature[1] = 0x00;
    expect(optimizePng(badSignature).applied).toBe(false);

    const badCrc = Buffer.from(good);
    badCrc[badCrc.length - 1] ^= 0xff; // IEND CRC 位翻转 → IHDR 校验失败仍应安全
    expect(optimizePng(badCrc).applied).toBe(false);

    expect(optimizePng(good.subarray(0, 20)).applied).toBe(false);
  });

  test('小图（< 1024 字节）直接跳过', () => {
    const tiny = makeRgbPng(8, 8, () => [1, 2, 3]);
    expect(tiny.length).toBeLessThan(1024);
    const result = optimizePng(tiny);
    expect(result.applied).toBe(false);
  });

  test('measureOptimization 的说明文案', () => {
    const applied = measureOptimization(codeLikePng().png);
    expect(applied.note).toContain('无损索引化');
    expect(applied.note).toContain('省');
    const skipped = measureOptimization(makeRgbPng(64, 64, (x, y) => [x * 4, y * 4, 0]));
    expect(skipped.note).toContain('原样保留');
  });
});
