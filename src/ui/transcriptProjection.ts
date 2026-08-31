import type { IntentAssessment } from '../coding-agent/types';
import type { MessageAttachment, MessageImage } from '../shared/types';
import {
  buildTranscriptToolExec,
  getTranscriptContent,
  getTranscriptThinkingSegments,
  type ToolExecMeta,
  type StoredToolCallInfo,
  type TranscriptEntry,
} from './store';

export type TranscriptReplayBlock =
  | { type: 'user'; content: string; images: MessageImage[]; attachments: MessageAttachment[] }
  | { type: 'analysis'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'assessment'; assessment: IntentAssessment }
  | { type: 'plan' }
  | { type: 'assistant'; content: string; isPlanPause: boolean }
  | { type: 'tool'; exec: ToolExecMeta; stopped: boolean }
  | { type: 'artifact'; items: Array<{ path: string }>; userRequest?: string };

function stoppedTool(call: StoredToolCallInfo): TranscriptReplayBlock {
  return {
    type: 'tool',
    stopped: true,
    exec: {
      toolName: call.toolName,
      success: false,
      duration: 0,
      args: call.args,
    },
  };
}

function visibleUserContent(content: string): string {
  return content
    .replace(/\s*\[(?:粘贴图片\/截图|Pasted screenshot\/image):[^\]]+\](?:\s*\n\s*(?:[~/]|[A-Za-z]:[\\/])[^\n]*)?/gi, '')
    .trim();
}

function artifactsFromToolExecs(execs: ToolExecMeta[]): Array<{ path: string }> {
  const paths = new Set<string>();
  for (const exec of execs) {
    if (!exec.success) continue;
    if ((exec.toolName === 'write_file' || exec.toolName === 'edit_file') && typeof exec.args?.path === 'string' && exec.args.path.trim()) {
      paths.add(exec.args.path);
    } else if (exec.toolName === 'replace_files' && Array.isArray(exec.args?.files)) {
      for (const file of exec.args.files) {
        if (typeof file === 'string' && file.trim()) paths.add(file);
      }
    }
  }
  return [...paths].map(path => ({ path }));
}

export function projectTranscript(entries: TranscriptEntry[]): TranscriptReplayBlock[] {
  const blocks: TranscriptReplayBlock[] = [];
  const pending = new Map<string, StoredToolCallInfo>();
  const completedTools: ToolExecMeta[] = [];
  let lastUserRequest = '';

  // Live rendering shows ONE artifact/project-directory card per turn, after
  // the final answer. The restore projection must match: accumulate the
  // turn's written files (deduped by path) and emit a single artifact block
  // at the turn boundary — never one card per assistant message.
  const turnArtifactPaths = new Map<string, { path: string }>();
  let turnHasExplicitArtifacts = false;

  const flushTurnArtifacts = (): void => {
    if (turnArtifactPaths.size === 0) return;
    blocks.push(lastUserRequest
      ? { type: 'artifact', items: [...turnArtifactPaths.values()], userRequest: lastUserRequest }
      : { type: 'artifact', items: [...turnArtifactPaths.values()] });
    turnArtifactPaths.clear();
  };

  const flushPending = (): void => {
    for (const call of pending.values()) blocks.push(stoppedTool(call));
    pending.clear();
  };

  for (const entry of entries) {
    if (entry.role === 'tool') {
      const call = entry.toolCallId ? pending.get(entry.toolCallId) : undefined;
      const fallback = buildTranscriptToolExec(entry);
      const exec = entry.toolExec
        ? {
            ...entry.toolExec,
            toolName: entry.toolExec.toolName || entry.toolName || call?.toolName || fallback.toolName,
            args: entry.toolExec.args ?? call?.args ?? fallback.args,
            resultText: entry.toolExec.resultText ?? fallback.resultText,
          }
        : {
            ...fallback,
            toolName: entry.toolName || call?.toolName || fallback.toolName,
            args: call?.args ?? fallback.args,
          };
      blocks.push({ type: 'tool', stopped: false, exec });
      completedTools.push(exec);
      if (entry.toolCallId) pending.delete(entry.toolCallId);
      continue;
    }

    if (entry.role === 'user') {
      // Turn boundary: the previous turn's artifact card lands here, before
      // the next request starts — exactly where live streaming put it.
      flushPending();
      flushTurnArtifacts();
      turnHasExplicitArtifacts = false;
      lastUserRequest = entry.content ?? '';
      if (entry.content || entry.images?.length || entry.attachments?.length) {
        blocks.push({ type: 'user', content: visibleUserContent(entry.content ?? ''), images: entry.images ?? [], attachments: entry.attachments ?? [] });
      }
      continue;
    }

    if (entry.role === 'assistant') {
      flushPending();
    }
    if (entry.analysis) blocks.push({ type: 'analysis', text: entry.analysis });
    // The plan card sits between the preflight analysis and the engine's
    // reasoning trace in the live transcript, so replay it at the same spot.
    if (entry.planCard) blocks.push({ type: 'plan' });
    for (const text of getTranscriptThinkingSegments(entry)) {
      blocks.push({ type: 'thinking', text });
    }
    if (entry.isPlanPause && entry.assessment) {
      blocks.push({ type: 'assessment', assessment: entry.assessment });
    }
    const content = getTranscriptContent(entry);
    if (content) {
      blocks.push({ type: 'assistant', content, isPlanPause: !!entry.isPlanPause });
    }
    if (entry.artifacts?.length) {
      turnHasExplicitArtifacts = true;
      for (const artifact of entry.artifacts) {
        if (!turnArtifactPaths.has(artifact.path)) turnArtifactPaths.set(artifact.path, artifact);
      }
    } else if (!turnHasExplicitArtifacts) {
      for (const artifact of artifactsFromToolExecs(completedTools)) {
        if (!turnArtifactPaths.has(artifact.path)) turnArtifactPaths.set(artifact.path, artifact);
      }
    }
    completedTools.length = 0;
    for (const call of entry.toolCalls ?? []) {
      if (call.id) pending.set(call.id, call);
    }
  }

  // Drain any completed tool results that arrived after the last assistant
  // entry (e.g. an interrupted session ending on a tool result) so their
  // artifact cards are not silently dropped.
  if (completedTools.length > 0 && !turnHasExplicitArtifacts) {
    for (const artifact of artifactsFromToolExecs(completedTools)) {
      if (!turnArtifactPaths.has(artifact.path)) turnArtifactPaths.set(artifact.path, artifact);
    }
    completedTools.length = 0;
  }
  flushPending();
  flushTurnArtifacts();
  return blocks;
}

export function projectSessionEvents(events: import('./store').SessionEvent[]): TranscriptReplayBlock[] {
  const blocks: TranscriptReplayBlock[] = [];
  const pending = new Map<string, StoredToolCallInfo>();
  const completedTools: ToolExecMeta[] = [];
  let lastUserRequest = '';
  const turnArtifactPaths = new Map<string, { path: string }>();
  let turnHasExplicitArtifacts = false;

  const flushTurnArtifacts = (): void => {
    if (turnArtifactPaths.size === 0) return;
    blocks.push(lastUserRequest
      ? { type: 'artifact', items: [...turnArtifactPaths.values()], userRequest: lastUserRequest }
      : { type: 'artifact', items: [...turnArtifactPaths.values()] });
    turnArtifactPaths.clear();
  };
  const addArtifactsFromTools = (): void => {
    if (turnHasExplicitArtifacts) return;
    for (const artifact of artifactsFromToolExecs(completedTools)) {
      if (!turnArtifactPaths.has(artifact.path)) turnArtifactPaths.set(artifact.path, artifact);
    }
  };
  const registerCalls = (event: import('./store').SessionEvent): void => {
    for (const call of event.toolCalls ?? []) {
      if (call.id) pending.set(call.id, call);
    }
    if (event.toolCallId && event.toolName && !event.toolCalls?.some((call) => call.id === event.toolCallId)) {
      pending.set(event.toolCallId, { id: event.toolCallId, toolName: event.toolName, args: {} });
    }
  };
  const flushPending = (): void => {
    for (const call of pending.values()) blocks.push(stoppedTool(call));
    pending.clear();
  };

  for (const event of events) {
    switch (event.type) {
      case 'user':
        flushPending();
        addArtifactsFromTools();
        completedTools.length = 0;
        flushTurnArtifacts();
        turnHasExplicitArtifacts = false;
        lastUserRequest = event.content ?? '';
        blocks.push({ type: 'user', content: visibleUserContent(event.content ?? ''), images: event.images ?? [], attachments: event.attachments ?? [] });
        break;
      case 'analysis':
        if (event.content) blocks.push({ type: 'analysis', text: event.content });
        break;
      case 'thinking':
        if (event.content) blocks.push({ type: 'thinking', text: event.content });
        break;
      case 'assessment':
        if (event.assessment) blocks.push({ type: 'assessment', assessment: event.assessment });
        break;
      case 'plan':
        blocks.push({ type: 'plan' });
        break;
      case 'assistant':
        flushPending();
        if (event.content) blocks.push({ type: 'assistant', content: event.content, isPlanPause: !!event.isPlanPause });
        if (event.artifacts?.length) {
          turnHasExplicitArtifacts = true;
          for (const artifact of event.artifacts) {
            if (!turnArtifactPaths.has(artifact.path)) turnArtifactPaths.set(artifact.path, artifact);
          }
        } else {
          addArtifactsFromTools();
        }
        completedTools.length = 0;
        registerCalls(event);
        break;
      case 'tool_result': {
        const call = event.toolCallId ? pending.get(event.toolCallId) : undefined;
        const stored = event.toolExec;
        const resultText = event.content ?? '';
        const exec: ToolExecMeta = stored
          ? {
              ...stored,
              toolName: stored.toolName || event.toolName || call?.toolName || 'tool',
              args: stored.args ?? call?.args,
              resultText: stored.resultText ?? (resultText || undefined),
            }
          : {
              toolName: event.toolName || call?.toolName || 'tool',
              success: !/^Error:\s/i.test(resultText),
              duration: 0,
              args: call?.args,
              resultText: resultText || undefined,
            };
        blocks.push({ type: 'tool', stopped: false, exec });
        completedTools.push(exec);
        if (event.toolCallId) pending.delete(event.toolCallId);
        break;
      }
      case 'artifact':
        if (event.artifacts?.length) {
          turnHasExplicitArtifacts = true;
          for (const artifact of event.artifacts) {
            if (!turnArtifactPaths.has(artifact.path)) turnArtifactPaths.set(artifact.path, artifact);
          }
        }
        break;
      case 'tool_call':
        registerCalls(event);
        break;
      case 'status':
        break;
    }
  }
  addArtifactsFromTools();
  flushPending();
  flushTurnArtifacts();
  return blocks;
}
