import type { IntentAssessment } from '../coding-agent/types';
import type { MessageAttachment, MessageImage } from '../shared/types';
import type { PathRepair } from './pathIndex';
import {
  buildTranscriptToolExec,
  getTranscriptContent,
  getTranscriptThinkingSegments,
  type SessionAgentActivity,
  type ToolExecMeta,
  type StoredToolCallInfo,
  type TranscriptEntry,
} from './store';

export type TranscriptReplayBlock =
  | { type: 'user'; content: string; images: MessageImage[]; attachments: MessageAttachment[]; repairs?: PathRepair[] }
  | { type: 'analysis'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'assessment'; assessment: IntentAssessment }
  | { type: 'plan' }
  | { type: 'assistant'; content: string; isPlanPause: boolean }
  | { type: 'tool'; exec: ToolExecMeta; stopped: boolean }
  | { type: 'artifact'; items: Array<{ path: string; op?: 'edit' | 'create' }>; userRequest?: string };

/**
 * 分支中断第四刀（收尾）：孤儿委派卡的中断结算从活动档案重建。
 *
 * 一个被用户暂停/停掉的子 agent 支，其结算 ToolResult 常常没赶上落盘——
 * 整轮暂停/Esc 掐断时转录里只剩 tool_call，此前回放一律走「本轮输出在此
 * 中断，该调用未执行完成」的谜之灰卡，用户主动中断的事实全丢。而
 * uiState.agentActivities 本来就按 callId 记着 lifecycle paused/cancelled
 * （同一份快照），这里把它接进回放：档案在，就按 25e8d1a 的中断口径重建
 * 结算（灰态 ⏸/⏹ + success:true + outcome），并从 toolTrace 还原卡的内部
 * 叙事；档案不在（真被掐死在出生前的普通调用）才退回原兜底。
 */
export function rebuildInterruptedToolExec(activity: SessionAgentActivity, call: StoredToolCallInfo): ToolExecMeta {
  const outcome = activity.lifecycle === 'paused' ? 'paused' as const
    : activity.lifecycle === 'cancelled' ? 'stopped' as const
    : undefined;
  if (!outcome) {
    return { toolName: call.toolName, success: false, duration: 0, args: call.args };
  }
  return {
    toolName: call.toolName,
    success: true,
    outcome,
    duration: 0,
    args: call.args,
    resultText: outcome === 'paused' ? '已暂停，进度已存档（重派同一任务可续）' : '已按你的要求停止，进度已存档（重派同一任务可续）',
    subagentTrace: (activity.toolTrace ?? []).map((step) => step.status === 'failed'
      ? `✗ ${step.name}${step.args ? ` ${step.args}` : ''}`
      : step.status === 'completed' ? `✓ ${step.name} 完成`
        : `→ ${step.name}${step.args ? ` ${step.args}` : ''}`),
  };
}

/** Interrupted-call fallback enriched from the activity ledger (see
 * rebuildInterruptedToolExec): only subagent delegations the ledger marks
 * paused/cancelled rebuild as a user-interruption settlement; anything else
 * keeps the historic "orphaned call" shape. */
function stoppedTool(call: StoredToolCallInfo, activity?: SessionAgentActivity): TranscriptReplayBlock {
  const exec = activity && (activity.lifecycle === 'paused' || activity.lifecycle === 'cancelled')
    ? rebuildInterruptedToolExec(activity, call)
    : { toolName: call.toolName, success: false, duration: 0, args: call.args };
  return {
    type: 'tool',
    stopped: true,
    exec,
  };
}

/** 插话框架文（插话重构/1a 定向投递）：模型看到的是带框架的一行，用户看到的
 * 必须是自己的原话——回放剥掉框架前缀和随附协议块，让重载渲染与实时回显
 * 一致（实时回显从来只有原话）。三条前缀对应宿主三种入转录的框架（顺路带上
 * / 中途追加 / 中途取消）。【系统接管执行】是宿主给模型的合并口径，压根不是
 * 用户的声音——剥成空串，调用方整条跳过，不渲染成用户气泡。 */
const USER_FRAME_PREFIXES = [
  /^【用户插话·顺路带上】/,
  /^【中途追加的任务，不是闲聊】用户要求在本次任务里追加：/,
  /^【中途取消，不是追加】用户中途收掉了这项工作：/,
];

function visibleUserContent(content: string): string {
  let text = content
    .replace(/\s*\[(?:粘贴图片\/截图|Pasted screenshot\/image):[^\]]+\](?:\s*\n\s*(?:[~/]|[A-Za-z]:[\\/])[^\n]*)?/gi, '');
  if (USER_FRAME_PREFIXES.some((re) => re.test(text))) {
    for (const re of USER_FRAME_PREFIXES) text = text.replace(re, '');
    // 随附协议块只存在于框架文里，认得框架才碰尾部——普通用户消息里出现
    // 「执行要求：」不会误伤。
    text = text
      .replace(/\n（这是任务进行中的插话[\s\S]*$/, '')
      .replace(/\n执行要求：[\s\S]*$/, '');
  } else if (/^【系统接管执行】/.test(text)) {
    return '';
  }
  return text.trim();
}

function artifactsFromToolExecs(execs: ToolExecMeta[]): Array<{ path: string; op?: 'edit' | 'create' }> {
  const paths = new Map<string, 'edit' | 'create'>();
  const add = (path: string, op: 'edit' | 'create'): void => {
    if (path.trim()) paths.set(path, op);
  };
  for (const exec of execs) {
    if (!exec.success) continue;
    if (exec.toolName === 'write_file' && typeof exec.args?.path === 'string') {
      add(exec.args.path, 'create');
    } else if (exec.toolName === 'edit_file' && typeof exec.args?.path === 'string') {
      add(exec.args.path, 'edit');
    } else if (exec.toolName === 'create_document' && typeof exec.args?.path === 'string') {
      add(exec.args.path, 'create');
    } else if (exec.toolName === 'replace_files' && Array.isArray(exec.args?.files)) {
      for (const file of exec.args.files) {
        if (typeof file === 'string') add(file, 'edit');
      }
    }
  }
  // `op` is only materialized for 'edit': a missing op already means
  // "created/unknown" everywhere it is consumed, so persisted JSON stays lean
  // and legacy replays compare equal.
  return [...paths].map(([path, op]) => (op === 'edit' ? { path, op } : { path }));
}

export function projectTranscript(entries: TranscriptEntry[], agentActivities?: SessionAgentActivity[]): TranscriptReplayBlock[] {
  const blocks: TranscriptReplayBlock[] = [];
  const pending = new Map<string, StoredToolCallInfo>();
  const activityByCall = new Map((agentActivities ?? []).filter((a) => a.callId).map((a) => [a.callId, a]));
  const completedTools: ToolExecMeta[] = [];
  let lastUserRequest = '';

  // Live rendering shows ONE artifact/project-directory card per turn, after
  // the final answer. The restore projection must match: accumulate the
  // turn's written files (deduped by path) and emit a single artifact block
  // at the turn boundary — never one card per assistant message.
  const turnArtifactPaths = new Map<string, { path: string; op?: 'edit' | 'create' }>();
  let turnHasExplicitArtifacts = false;

  const flushTurnArtifacts = (): void => {
    if (turnArtifactPaths.size === 0) return;
    blocks.push(lastUserRequest
      ? { type: 'artifact', items: [...turnArtifactPaths.values()], userRequest: lastUserRequest }
      : { type: 'artifact', items: [...turnArtifactPaths.values()] });
    turnArtifactPaths.clear();
  };

  const flushPending = (): void => {
    for (const call of pending.values()) blocks.push(stoppedTool(call, activityByCall.get(call.id)));
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
      // Engine-injected internal nudges (failure-policy hints, continuation
      // directives) live in modelContext but must never render as a user
      // bubble or act as a turn boundary.
      if (entry.internal) continue;
      // Turn boundary: the previous turn's artifact card lands here, before
      // the next request starts — exactly where live streaming put it.
      flushPending();
      flushTurnArtifacts();
      turnHasExplicitArtifacts = false;
      // 存在性判断用剥壳后的可见文本：插话框架剥出原话照常上屏；宿主机制
      // 行（【系统接管执行】）剥成空串就整条不渲染——它不是用户说的话。
      const visible = visibleUserContent(entry.content ?? '');
      if (visible) lastUserRequest = visible;
      if (visible || entry.images?.length || entry.attachments?.length) {
        blocks.push({ type: 'user', content: visible, images: entry.images ?? [], attachments: entry.attachments ?? [], repairs: entry.pathRepairs });
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

export function projectSessionEvents(events: import('./store').SessionEvent[], agentActivities?: SessionAgentActivity[]): TranscriptReplayBlock[] {
  const blocks: TranscriptReplayBlock[] = [];
  const pending = new Map<string, StoredToolCallInfo>();
  const activityByCall = new Map((agentActivities ?? []).filter((a) => a.callId).map((a) => [a.callId, a]));
  const completedTools: ToolExecMeta[] = [];
  let lastUserRequest = '';
  const turnArtifactPaths = new Map<string, { path: string; op?: 'edit' | 'create' }>();
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
    for (const call of pending.values()) blocks.push(stoppedTool(call, activityByCall.get(call.id)));
    pending.clear();
  };

  for (const event of events) {
    switch (event.type) {
      case 'user':
        // Engine-injected internal nudge — never rendered (see entry path).
        if (event.internal) break;
        flushPending();
        addArtifactsFromTools();
        completedTools.length = 0;
        flushTurnArtifacts();
        turnHasExplicitArtifacts = false;
        {
          const visible = visibleUserContent(event.content ?? '');
          if (visible) lastUserRequest = visible;
          if (visible || event.images?.length || event.attachments?.length) {
            blocks.push({ type: 'user', content: visible, images: event.images ?? [], attachments: event.attachments ?? [], repairs: event.pathRepairs });
          }
        }
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
