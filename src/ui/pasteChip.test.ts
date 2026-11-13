import { describe, expect, it } from 'bun:test';
import { attachmentToMessageImage, composeMessageWithAttachments, downscaleDimensions, downscaleImageDataUrl, MAX_IMAGE_PIXELS, scaleImageDataUrl, type PasteAttachment } from './pasteChip';

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

  it('returns the intrinsic size from the same decode that builds the thumbnail', async () => {
    const restore = installFakeImageEnv({ width: 4000, height: 3000 });
    try {
      const scaled = await scaleImageDataUrl('data:image/png;base64,AAAA');
      // The size belongs to the INPUT (the user's original), the URL to the thumbnail.
      expect(scaled.width).toBe(4000);
      expect(scaled.height).toBe(3000);
      expect(scaled.dataUrl).toBe('data:image/png;base64,SMALL');
    } finally {
      restore();
    }
  });

  it('still reports the size when the image is already small enough to keep', async () => {
    const restore = installFakeImageEnv({ width: 800, height: 600 });
    try {
      const scaled = await scaleImageDataUrl('data:image/png;base64,SMALLENOUGH');
      expect(scaled).toEqual({ dataUrl: 'data:image/png;base64,SMALLENOUGH', width: 800, height: 600 });
    } finally {
      restore();
    }
  });

  it('carries a measured size into the vision attachment, and omits it when unknown', () => {
    expect(attachmentToMessageImage({ ...image, width: 1280, height: 720 })).toEqual({
      dataUrl: image.dataUrl,
      mimeType: 'image/png',
      name: 'shot.png',
      path: image.path,
      sizeBytes: 4,
      width: 1280,
      height: 720,
    });
    // No decode (test env) → no size keys at all, so the bubble never reserves a 0×0 box.
    expect(attachmentToMessageImage(image)).not.toHaveProperty('width');
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
    // ... and report "unknown size" rather than a fake one.
    expect(await scaleImageDataUrl('not-a-data-url')).toEqual({ dataUrl: 'not-a-data-url', width: 0, height: 0 });
  });
});

/** Minimal Image + canvas stand-ins: the only DOM the downscaler touches. */
function installFakeImageEnv(natural: { width: number; height: number }): () => void {
  const g = globalThis as any;
  const previousImage = g.Image;
  const previousDocument = g.document;
  class FakeImage {
    naturalWidth = natural.width;
    naturalHeight = natural.height;
    width = natural.width;
    height = natural.height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  g.Image = FakeImage;
  g.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => 'data:image/png;base64,SMALL',
    }),
  };
  return () => {
    g.Image = previousImage;
    g.document = previousDocument;
  };
}
