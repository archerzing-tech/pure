// src/shared/__tests__/imageFiles.test.ts
import { describe, it, expect } from 'bun:test';
import { IMAGE_READ_MAX_BYTES, imageMimeForPath } from '../imageFiles';

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
});
