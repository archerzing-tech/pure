// src/channels/richOutput.ts
// 富输出的降级矩阵（设计文档 §7）：把回答里的 ```chart / ```svg / ```mermaid /
// ```puml 块光栅化成 PNG 附件；通道能力不足或没有对应渲染器时诚实降级为文本。
//
// 渲染器是注入的接缝：gateway 注入本地渲染器（charts/svg 真跑），单测注入替身。
// mermaid / puml 需要 DOM/headless 渲染器 —— 没注入时**不假装成功**，只回一条
// 说明并把源码留给用户。
import type { ChannelCapabilities, OutboundAttachment } from './types';

export type RichKind = 'chart' | 'svg' | 'mermaid' | 'puml';

export interface RichBlock {
  kind: RichKind;
  source: string;
  index: number;
}

export interface RichRenderers {
  svgToPng?(svg: string): Promise<Uint8Array | null>;
  chartToPng?(source: string): Promise<Uint8Array | null>;
  mermaidToPng?(source: string): Promise<Uint8Array | null>;
  pumlToPng?(source: string): Promise<Uint8Array | null>;
}

export interface RichRenderResult {
  attachments: OutboundAttachment[];
  notes: string[];
}

const FENCE = /```(chart|svg|mermaid|puml|plantuml)[ \t]*\n([\s\S]*?)```/g;

export function extractRichBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const match of text.matchAll(FENCE)) {
    const kind = match[1] === 'plantuml' ? 'puml' : (match[1] as RichKind);
    blocks.push({ kind, source: match[2].trim(), index: blocks.length });
  }
  return blocks;
}

/** 能力驱动的降级矩阵（数据表，不是 per-channel 的 if/else）。 */
export function degradationPlan(capabilities: ChannelCapabilities): Record<RichKind, 'attach' | 'text'> {
  const images = (capabilities.canDeliverImages ?? capabilities.media.images) === true;
  return {
    svg: images ? 'attach' : 'text',
    chart: images ? 'attach' : 'text',
    mermaid: images ? 'attach' : 'text',
    puml: images ? 'attach' : 'text',
  };
}

const RENDERERS: Record<RichKind, keyof RichRenderers> = {
  svg: 'svgToPng',
  chart: 'chartToPng',
  mermaid: 'mermaidToPng',
  puml: 'pumlToPng',
};

/**
 * 把回答里的富输出块转成 PNG 附件。缺渲染器 / 渲染失败只记一条 note，
 * 绝不让附件生成拖垮这次回复。
 */
export async function renderRichOutput(
  text: string,
  capabilities: ChannelCapabilities,
  renderers: RichRenderers = {},
): Promise<RichRenderResult> {
  const blocks = extractRichBlocks(text);
  const result: RichRenderResult = { attachments: [], notes: [] };
  if (blocks.length === 0) return result;
  const plan = degradationPlan(capabilities);

  for (const block of blocks) {
    if (plan[block.kind] === 'text') {
      result.notes.push(`${block.kind} 图未转成图片（该通道不支持图片），已在正文保留源码。`);
      continue;
    }
    const renderer = renderers[RENDERERS[block.kind]];
    if (!renderer) {
      result.notes.push(`${block.kind} 图未光栅化（没有可用的 headless 渲染器），已在正文保留源码。`);
      continue;
    }
    try {
      const png = await renderer.call(renderers, block.source);
      if (!png || png.length === 0) {
        result.notes.push(`${block.kind} 图渲染失败，已在正文保留源码。`);
        continue;
      }
      result.attachments.push({ name: `diagram-${block.index + 1}.png`, mimeType: 'image/png', data: png });
    } catch {
      result.notes.push(`${block.kind} 图渲染失败，已在正文保留源码。`);
    }
  }
  return result;
}
