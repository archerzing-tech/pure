import type { IntentAssessment } from '../coding-agent/types';
import type { MessageImage } from '../shared/types';
import {
  buildTranscriptToolExec,
  getTranscriptContent,
  getTranscriptThinkingSegments,
  type ToolExecMeta,
  type StoredToolCallInfo,
  type TranscriptEntry,
} from './store';

export type TranscriptReplayBlock =
  | { type: 'user'; content: string; images: MessageImage[] }
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
      flushPending();
      lastUserRequest = entry.content ?? '';
      if (entry.content || entry.images?.length) {
        blocks.push({ type: 'user', content: visibleUserContent(entry.content ?? ''), images: entry.images ?? [] });
      }
      continue;
    }

    flushPending();
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
    const artifacts = entry.artifacts?.length ? entry.artifacts : artifactsFromToolExecs(completedTools);
    if (artifacts.length) {
      blocks.push(lastUserRequest
        ? { type: 'artifact', items: artifacts, userRequest: lastUserRequest }
        : { type: 'artifact', items: artifacts });
    }
    completedTools.length = 0;
    for (const call of entry.toolCalls ?? []) {
      if (call.id) pending.set(call.id, call);
    }
  }

  flushPending();
  return blocks;
}
