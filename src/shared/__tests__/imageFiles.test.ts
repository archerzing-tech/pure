// src/shared/__tests__/imageFiles.test.ts
import { describe, it, expect } from 'bun:test';
import { IMAGE_READ_MAX_BYTES, imageMimeForPath, sniffImageMime } from '../imageFiles';

describe('imageFiles', () => {
  it('maps image extensions to mime types', () => {
    expect(imageMimeForPath('/tmp/a.png')).toBe('image/png');
    expect(imageMimeForPath('/tmp/b.JPG')).toBe('image/jpeg'); // case-insensitive
    expect(imageMimeForPath('c.jpeg')).toBe('image/jpeg');
    expect(imageMimeForPath('d.webp')).toBe('image/webp');
    expect(imageMimeForPath('e.bmp')).toBe('image/bmp');
    expect(imageMimeForPath('f.gif')).toBe('image/gif');
  });

  it('returns null for non-image paths', () => {
    expect(imageMimeForPath('/tmp/notes.txt')).toBeNull();
    expect(imageMimeForPath('/tmp/archive.tar.gz')).toBeNull(); // gz not an image ext
    expect(imageMimeForPath('noext')).toBeNull();
  });

  it('caps visual reads at 5MB', () => {
    expect(IMAGE_READ_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it('sniffs image signatures instead of trusting the extension', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImageMime(enc('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMime(enc('GIF87a......'))).toBe('image/gif');
    const webp = new Uint8Array(16);
    webp.set(enc('RIFF'), 0);
    webp.set(enc('WEBP'), 8);
    expect(sniffImageMime(webp)).toBe('image/webp');
    const bmp = new Uint8Array(14);
    bmp.set(enc('BM'), 0);
    expect(sniffImageMime(bmp)).toBe('image/bmp');
    expect(sniffImageMime(enc('BM'))).toBeNull(); // too short for a BMP header
    // 下载失败的错误页被存成 oss.png 的形态：扩展名是图片，签名不是。
    expect(sniffImageMime(enc('<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>'))).toBeNull();
    expect(sniffImageMime(enc('<html><body>502 Bad Gateway</body></html>'))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
  });
});
