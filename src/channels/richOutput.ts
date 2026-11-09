// src/channels/richOutput.ts
// 富输出的降级矩阵（设计文档 §7）：把回答里的 ```chart / ```svg / ```mermaid /
// ```puml 块光栅化成 PNG 附件；通道能力不足或没有对应渲染器时诚实降级为文本。
// 渲染器是注入的接缝：gateway 注入本地渲染器（charts/svg 真跑），单测注入替身。
// mermaid / puml 需要 DOM/headless 渲染器 —— 没注入时**不假装成功**，只回一条
// 说明并把源码留给用户。
// 刀 4（formProjections）：chart / map / paint 三形式在 text 降级分支不再裸
// JSON/源码直出——先试文本投影（条形图/标记清单/形状清单），成功就把正文里的
// 该围栏块替换成投影（projectedText），失败保持源码（绝不产出错误的图）。
import { projectForm } from '../shared/formProjections';
import type { ChannelCapabilities, OutboundAttachment } from './types';

export type RichKind = 'chart' | 'svg' | 'mermaid' | 'puml' | 'map' | 'paint';

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
  /** 投影替换后的正文（仅当至少一个块投影成功才存在；调用方用它替换原文）。 */
  projectedText?: string;
}

const FENCE = /```(chart|svg|mermaid|puml|plantuml|map|paint)[ \t]*\n([\s\S]*?)```/g;

/** 有文本投影器的形式（刀 4）：text 降级时先投影，不留裸载荷。 */
const PROJECTABLE: ReadonlySet<string> = new Set(['chart', 'map', 'paint']);

export function extractRichBlocks(text: string): RichBlock[] {
  const blocks: RichBlock[] = [];
  for (const match of text.matchAll(FENCE)) {
    const kind = match[1] === 'plantuml' ? 'puml' : (match[1] as RichKind);
    blocks.push({ kind, source: match[2].trim(), index: blocks.length });
  }
  return blocks;
}

/** 能力驱动的降级矩阵（数据表，不是 per-channel 的 if/else）。map/paint 没有
 *  headless 渲染器，恒走 text（投影）分支。 */
export function degradationPlan(capabilities: ChannelCapabilities): Record<RichKind, 'attach' | 'text'> {
  const images = (capabilities.canDeliverImages ?? capabilities.media.images) === true;
  return {
    svg: images ? 'attach' : 'text',
    chart: images ? 'attach' : 'text',
    mermaid: images ? 'attach' : 'text',
    puml: images ? 'attach' : 'text',
    map: 'text',
    paint: 'text',
  };
}

const RENDERERS: Partial<Record<RichKind, keyof RichRenderers>> = {
  svg: 'svgToPng',
  chart: 'chartToPng',
  mermaid: 'mermaidToPng',
  puml: 'pumlToPng',
};

/**
 * 把回答里的富输出块转成 PNG 附件；text 降级的投影形式顺带把正文里的块替换成
 * 文本投影。缺渲染器 / 渲染失败只记一条 note，绝不让附件生成拖垮这次回复。
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

  // 正文投影：逐块重扫原文，投影成功的块记录替换区间，最后重组正文。
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const match of text.matchAll(FENCE)) {
    const lang = match[1] === 'plantuml' ? 'puml' : match[1];
    if (!PROJECTABLE.has(lang)) continue;
    const planKind = plan[lang as RichKind];
    if (planKind !== 'text') continue; // attach 模式下正文保持源码（图片另有附件）
    const projected = projectForm(lang, match[2]);
    if (projected) {
      replacements.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, text: projected });
    }
  }
  if (replacements.length > 0) {
    replacements.sort((a, b) => a.start - b.start);
    const parts: string[] = [];
    let cursor = 0;
    for (const rep of replacements) {
      parts.push(text.slice(cursor, rep.start), rep.text);
      cursor = rep.end;
    }
    parts.push(text.slice(cursor));
    result.projectedText = parts.join('');
    result.notes.push('图形块在文本表面已转为可读投影（条形图/清单），完整源码见桌面端。');
  }

  for (const block of blocks) {
    if (plan[block.kind] === 'text') {
      if (!PROJECTABLE.has(block.kind)) {
        result.notes.push(`${block.kind} 图未转成图片（该通道不支持图片），已在正文保留源码。`);
      }
      continue; // 投影形式的 text 降级已在上面处理（投影成功）/静默（失败保源码）
    }
    const rendererKey = RENDERERS[block.kind];
    const renderer = rendererKey ? renderers[rendererKey] : undefined;
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
