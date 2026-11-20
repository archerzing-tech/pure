// 卡内预览资源识别与加载器注入的行为锁（2026-11-20）。
// 注入位置错了，加载器会晚于页面脚本，瓦片请求根本不会经过它；识别面放宽到
// 普通 JSON 会把 API 响应也塞进缓存，改变页面语义。两条都在这里钉住。

import { describe, expect, it } from 'bun:test';
import {
  PREVIEW_ASSET_IMAGE_PLACEHOLDER,
  PREVIEW_ASSET_LOADER_MARKER,
  buildPreviewAssetLoader,
  injectPreviewAssetLoader,
  isPreviewAssetUrl,
} from '../previewAssets';

describe('isPreviewAssetUrl', () => {
  it('accepts the shapes that actually appear as tiles, models and textures', () => {
    expect(isPreviewAssetUrl('https://tiles.example/3/4/5.png')).toBe(true);
    expect(isPreviewAssetUrl('https://cdn.example/models/scene.glb?v=2')).toBe(true);
    expect(isPreviewAssetUrl('https://cdn.example/tiles/tileset.json')).toBe(true);
    expect(isPreviewAssetUrl('https://cdn.example/tiles/1/2/3')).toBe(true);
    expect(isPreviewAssetUrl('https://cdn.example/tile?z=1&x=2&y=3')).toBe(true);
    expect(isPreviewAssetUrl('https://cdn.example/fonts/inter.woff2')).toBe(true);
  });

  it('leaves same-page relative paths, data URLs and ordinary API JSON alone', () => {
    expect(isPreviewAssetUrl('./cover.png')).toBe(false);
    expect(isPreviewAssetUrl('/assets/cover.png')).toBe(false);
    expect(isPreviewAssetUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isPreviewAssetUrl('https://api.example.com/v1/users')).toBe(false);
    expect(isPreviewAssetUrl('https://api.example.com/v1/data.json')).toBe(false);
    // 非 http(s)（file:, ftp:）不经过宿主缓存。
    expect(isPreviewAssetUrl('ftp://cdn.example/a.glb')).toBe(false);
  });
});

describe('injectPreviewAssetLoader', () => {
  const source =
    '<!doctype html><html><head><script>window.ownScript = 1</script></head>' +
    '<body><img src="https://tiles.example/1/2/3.png"></body></html>';

  it('runs before the page’s own scripts and carries the issued token', () => {
    const out = injectPreviewAssetLoader(source, 'token-abc');
    expect(out).toContain('token-abc');
    expect(out.indexOf(PREVIEW_ASSET_LOADER_MARKER)).toBeGreaterThan(-1);
    expect(out.indexOf(PREVIEW_ASSET_LOADER_MARKER)).toBeLessThan(out.indexOf('window.ownScript = 1'));
  });

  it('embeds the shared transparent placeholder instead of a second copy', () => {
    const loader = buildPreviewAssetLoader('t');
    expect(loader).toContain(PREVIEW_ASSET_IMAGE_PLACEHOLDER);
    expect(loader).not.toContain('__PURE_ASSET_PLACEHOLDER__');
    expect(loader).not.toContain('__PURE_ASSET_TOKEN__');
    expect(PREVIEW_ASSET_IMAGE_PLACEHOLDER.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('falls back to the <html> tag and then to the very front when there is no head', () => {
    const noHead = '<html><body><script>run()</script></body></html>';
    expect(injectPreviewAssetLoader(noHead, 't').indexOf(PREVIEW_ASSET_LOADER_MARKER))
      .toBeLessThan(injectPreviewAssetLoader(noHead, 't').indexOf('run()'));

    const fragment = '<div>only markup</div>';
    expect(injectPreviewAssetLoader(fragment, 't').startsWith('<script>')).toBe(true);
  });
});
