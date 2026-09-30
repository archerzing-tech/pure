// src/channels/prompting.ts
// 通道表面的提示词装配（设计文档 §10）。能力描述不放进 shared/PromptAssembler，
// 因为那条依赖边会反过来（shared 不该知道通道层）。这里生成 capabilities 文本，
// 交给 PromptAssembler 的 `capabilities` 片段。
import { promptAssembler, type PromptAssembly } from '../shared/PromptAssembler';
import { resolvePromptBudget, type PromptBudgetConfig } from '../shared/providers';
import type { ToolDefinition } from '../shared/types';
import type { ChannelCapabilities } from './types';

const MARKDOWN_NOTE: Record<ChannelCapabilities['markdown'], string> = {
  none: 'This channel does NOT render markdown: write plain text, no **bold**, no tables, no code fences if avoidable.',
  basic: 'This channel renders basic markdown (bold, lists, short code). Avoid wide tables and nested structures.',
  full: 'This channel renders markdown fully (headings, lists, tables, code fences).',
};

/** 与 buildCliCapabilities / buildGuiCapabilities 并列的第三条分支。 */
export function buildChannelCapabilities(caps: ChannelCapabilities): string {
  const media = [
    caps.media.images ? 'images' : null,
    caps.media.files ? 'files' : null,
    caps.media.audio ? 'audio' : null,
    caps.media.video ? 'video' : null,
  ].filter(Boolean).join(' / ') || 'text only';
  const limit = `Keep the whole reply under ${caps.maxTextLength} characters; longer answers are split into several messages or attached as a file.`;
  return [
    'You are answering inside a chat application through the pure Channel Gateway — there is no terminal and no GUI in front of the user.',
    MARKDOWN_NOTE[caps.markdown],
    limit,
    `This channel accepts: ${media}. Streaming mode: ${caps.streaming}.`,
    'Long deliverables (files, images, generated artifacts) are delivered as attachments — state the artifact and let the host attach it; do not paste huge blobs into the message body.',
    'Prefer short, self-contained answers: the user reads them on a phone, often in a group chat, and cannot scroll back easily.',
  ].join('\n');
}

export interface ChannelPromptInput {
  capabilities: ChannelCapabilities;
  toolDefinitions: ToolDefinition[];
  budget: PromptBudgetConfig;
  userText?: string;
  modelIdentity?: { provider: string; model: string };
  conventions?: string;
  hasSubagents?: boolean;
  mode?: 'yolo' | 'plan' | 'build';
  sessionId?: string;
}

export function assembleChannelPrompt(input: ChannelPromptInput): PromptAssembly {
  return promptAssembler.assemble({
    surface: 'channel',
    capabilities: buildChannelCapabilities(input.capabilities),
    toolDefinitions: input.toolDefinitions,
    budget: input.budget,
    modelIdentity: input.modelIdentity,
    conventions: input.conventions,
    hasSubagents: input.hasSubagents,
    mode: input.mode,
    sessionId: input.sessionId,
  }, input.userText);
}

export function channelOutputReserve(budget: PromptBudgetConfig): number {
  return resolvePromptBudget(budget).outputReserveTokens;
}
