import { describe, expect, it } from 'bun:test';
import { attachmentToMessageImage, composeMessageWithAttachments, downscaleDimensions, downscaleImageDataUrl, MAX_IMAGE_PIXELS, type PasteAttachment } from './pasteChip';

const image: PasteAttachment = {
  id: 'paste-1',
  name: 'shot.png',
  size: 4,
  content: '',
  path: '/tmp/pure/session/shot.png',
  kind: 'image',
  dataUrl: 'data:image/png;base64,AAAA',
  mime: 'image/png',
};

describe('submitted image attachments', () => {
  it('converts an image chip into a native vision attachment', () => {
    expect(attachmentToMessageImage(image)).toEqual({
      dataUrl: image.dataUrl,
      mimeType: 'image/png',
      name: 'shot.png',
      path: image.path,
      sizeBytes: 4,
    });
  });

  it('keeps a textual marker for model context while the UI can render the image separately', () => {
    const text = composeMessageWithAttachments('请解析这张图', [image]);
    expect(text).toContain('请解析这张图');
    expect(text).toContain('shot.png');
    expect(text).toContain(image.path);
  });

  it('does not create a vision attachment before the image data is ready', () => {
    expect(attachmentToMessageImage({ ...image, dataUrl: '' })).toBeNull();
  });
});

describe('image downscaling', () => {
  it('caps total pixels at ~2MP while preserving the aspect ratio', () => {
    const { width, height } = downscaleDimensions(4000, 3000);
    expect(width * height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    expect(Math.abs(width / height - 4000 / 3000)).toBeLessThan(0.01);
    expect(width).toBeLessThan(4000);
  });

  it('leaves small images untouched and tolerates bad input', () => {
    expect(downscaleDimensions(800, 600)).toEqual({ width: 800, height: 600 });
    expect(downscaleDimensions(0, 600)).toEqual({ width: 0, height: 600 });
    expect(downscaleDimensions(Number.NaN, 600)).toEqual({ width: Number.NaN, height: 600 });
    expect(downscaleDimensions(2000, 1000, MAX_IMAGE_PIXELS * 2)).toEqual({ width: 2000, height: 1000 });
  });

  it('fails open when the DOM is unavailable (unit-test env) or the URL is not a raster image', async () => {
    // No Image/document in this suite: the original URL must come back intact.
    const raster = 'data:image/png;base64,AAAA';
    expect(await downscaleImageDataUrl(raster)).toBe(raster);
    // Non-raster formats (SVG / GIF animation) are never touched.
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
    expect(await downscaleImageDataUrl(svg)).toBe(svg);
    const gif = 'data:image/gif;base64,R0lGODlh';
    expect(await downscaleImageDataUrl(gif)).toBe(gif);
    // Empty / malformed URLs pass through.
    expect(await downscaleImageDataUrl('')).toBe('');
    expect(await downscaleImageDataUrl('not-a-data-url')).toBe('not-a-data-url');
  });
});
