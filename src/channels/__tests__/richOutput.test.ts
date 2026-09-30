import { describe, it, expect } from 'bun:test';
import { degradationPlan, extractRichBlocks, renderRichOutput } from '../richOutput';
import { createLocalRichRenderers } from '../rasterize/localRenderer';
import type { ChannelCapabilities } from '../types';

const CAPS_IMAGES: ChannelCapabilities = { chatTypes: ['dm'], media: { images: true }, streaming: 'none', maxTextLength: 4000, markdown: 'full' };
const CAPS_TEXT: ChannelCapabilities = { chatTypes: ['dm'], media: {}, streaming: 'none', maxTextLength: 4000, markdown: 'none' };

const ANSWER = [
  '看这张图：',
  '',
  '```chart',
  'type bar',
  '苹果 10',
  '香蕉 20',
  '```',
  '',
  '以及流程图：',
  '',
  '```mermaid',
  'graph TD; A-->B',
  '```',
  '',
  '```svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg>',
  '```',
].join('\n');

describe('rich output extraction', () => {
  it('finds chart/svg/mermaid/puml blocks in order', () => {
    const blocks = extractRichBlocks(ANSWER);
    expect(blocks.map((b) => b.kind)).toEqual(['chart', 'mermaid', 'svg']);
    expect(extractRichBlocks('```plantuml\n@startuml\n@enduml\n```')[0].kind).toBe('puml');
    expect(extractRichBlocks('no blocks here')).toEqual([]);
  });

  it('plans attachments only when the channel accepts images', () => {
    expect(degradationPlan(CAPS_IMAGES).chart).toBe('attach');
    expect(degradationPlan(CAPS_TEXT).chart).toBe('text');
  });

  it('honors canDeliverImages over the inbound media flag', () => {
    const inboundOnly: ChannelCapabilities = { ...CAPS_IMAGES, canDeliverImages: false };
    expect(degradationPlan(inboundOnly).svg).toBe('text');
  });
});

describe('renderRichOutput', () => {
  it('attaches PNGs for every block a renderer covers', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const result = await renderRichOutput(ANSWER, CAPS_IMAGES, {
      svgToPng: async () => png,
      chartToPng: async () => png,
      mermaidToPng: async () => png,
    });
    expect(result.attachments.map((a) => a.name)).toEqual(['diagram-1.png', 'diagram-2.png', 'diagram-3.png']);
    expect(result.attachments.every((a) => a.mimeType === 'image/png')).toBe(true);
    expect(result.notes).toEqual([]);
  });

  it('degrades honestly when no renderer covers a kind', async () => {
    const result = await renderRichOutput(ANSWER, CAPS_IMAGES, { svgToPng: async () => new Uint8Array([1]) });
    expect(result.attachments.map((a) => a.name)).toEqual(['diagram-3.png']);
    expect(result.notes.join('\n')).toContain('chart 图未光栅化');
    expect(result.notes.join('\n')).toContain('mermaid 图未光栅化');
  });

  it('degrades every block to text on a channel without image support', async () => {
    const result = await renderRichOutput(ANSWER, CAPS_TEXT, { svgToPng: async () => new Uint8Array([1]) });
    expect(result.attachments).toEqual([]);
    expect(result.notes.length).toBe(3);
    expect(result.notes[0]).toContain('不支持图片');
  });

  it('reports a failed render without throwing', async () => {
    const result = await renderRichOutput('```svg\n<svg/>\n```', CAPS_IMAGES, { svgToPng: async () => { throw new Error('boom'); } });
    expect(result.attachments).toEqual([]);
    expect(result.notes[0]).toContain('渲染失败');
  });

  it('returns empty quickly when there is nothing to render', async () => {
    expect(await renderRichOutput('plain answer', CAPS_IMAGES)).toEqual({ attachments: [], notes: [] });
  });
});

describe('local renderer (real rasterization)', () => {
  it('turns a ```chart block into a real PNG', async () => {
    const renderers = createLocalRichRenderers();
    const png = await renderers.chartToPng!('title 销量\ntype bar\n苹果 10\n香蕉 20');
    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(1000);
    // PNG magic bytes.
    expect([...png!.slice(0, 4)]).toEqual([137, 80, 78, 71]);
  });

  it('turns an inline SVG into a PNG', async () => {
    const renderers = createLocalRichRenderers();
    const png = await renderers.svgToPng!('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#3b82f6"/></svg>');
    expect(png).not.toBeNull();
    expect(png!.length).toBeGreaterThan(100);
  });

  it('does not claim mermaid/puml support', () => {
    const renderers = createLocalRichRenderers();
    expect(renderers.mermaidToPng).toBeUndefined();
    expect(renderers.pumlToPng).toBeUndefined();
  });
});
