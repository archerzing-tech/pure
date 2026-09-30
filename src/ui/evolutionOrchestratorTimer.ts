// src/ui/evolutionOrchestratorTimer.ts
// P0-1 — GUI 空闲 sleep-time 进化循环。编排纯核（src/evolution/
// sleepTimeOrchestrator.ts）只管状态机与预算；本模块是 GUI 宿主：10 分钟轮询、
// 两轮最小间隔 30 分钟、触发时重读 config（总开关是唯一决策点）、聊天进行中
// 让路（进化绝不和运行时抢资源）、游标落 ~/.pure/evolution/orchestrator.json、
// 每轮结束 dispatch 'pure:evolution-cycle'（子系统间事件说话，仿
// pure:memory-decay-run 先例）。骨架照 memoryDecayTimer：递归 setTimeout、
// 降级不阻塞、防忙循环保底重排（失败也记 lastCycleAt，间隔照走）。
//
// 会话档案走既有 Rust 缝（load_session_list / load_session），overlay 走
// overlayFlowHost 共用装配（confirm 自动允许 —— 到 confirm 即 A/B 门禁
// verdict==='allow'），技能闸翻转照 settings 建议卡「一键应用」同一语义。

import { loadConfig, persistConfig, invalidateConfigCache, defaults, type PureConfig } from './config';
import { memoryStore } from './memoryStore';
import { readGuiObservations } from './observationSource';
import { isTauriRuntime, loadTauriCore, tauriInvoke } from '../shared/tauri';
import { join, homeDir } from '@tauri-apps/api/path';
import { createTauriObservationSink } from '../shared/tauriObservationSink';
import { buildSkillGateAppliedRecord } from '../shared/subagentAdvisory';
import type { Message } from '../shared/types';
import {
  SLEEP_TIME_BUDGETS,
  computeIdleCycleDelayMs,
  defaultConfirmPolicy,
  runSleepTimeCycle,
  sanitizeCursor,
  sessionTurnFromMessages,
  type OrchestratorCursor,
  type SleepTimeDeps,
  type SleepTimeSessionRef,
  type SleepTimeTurnInput,
} from '../evolution/sleepTimeOrchestrator';
import { buildOverlayFlowDeps } from './overlayFlowHost';
import { runPersonaOverlayFlow } from './personaOverlayFlow';
import { createLLMAdapter } from './chat';
import { reflectModelFor } from '../shared/phaseModels';

/** 轮询节奏：每 10 分钟醒来看一眼（开关/忙碌/间隔都可能在变）。 */
export const ORCHESTRATOR_POLL_MS = 10 * 60 * 1000;
/** 两轮进化之间的最小间隔：进化是慢变量，30 分钟足够。 */
export const ORCHESTRATOR_MIN_GAP_MS = 30 * 60 * 1000;

const CURSOR_PATH = 'evolution/orchestrator.json';

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let lastCycleAt: number | undefined;

/** 宿主接缝（main.ts 注入 —— chat 是 main 的局部单例，不可反向依赖）。 */
export interface OrchestratorTimerHost {
  /** 聊天正在流式输出 = 忙，让路。 */
  isBusy: () => boolean;
  /** 当前工作区（记忆按项目隔离，会话与反思都归属它）。 */
  getWorkspace: () => string;
}

let host: OrchestratorTimerHost = { isBusy: () => false, getWorkspace: () => '' };

/** 距下一轮该等多久：没跑过 → 等一个轮询窗（启动不抢跑）；跑过 → 30 分钟间隔。 */
export function computeNextCycleDelayMs(lastCycleAt: number | undefined, now = Date.now()): number {
  return computeIdleCycleDelayMs(lastCycleAt, now, ORCHESTRATOR_POLL_MS, ORCHESTRATOR_MIN_GAP_MS);
}

function scheduleNext(delayMs?: number): void {
  if (!started) return;
  timer = setTimeout(() => { void tick(); }, delayMs ?? computeNextCycleDelayMs(lastCycleAt));
}

async function tick(): Promise<void> {
  if (!started) return;
  // 触发时刻是唯一决策点：重读 config —— 用户刚关总开关就绝不再跑。
  const cfg = loadConfig();
  if (cfg?.skills?.evolution === false) {
    scheduleNext(ORCHESTRATOR_POLL_MS); // 关了继续轮询，用户随时可能再开
    return;
  }
  if (!isTauriRuntime()) {
    scheduleNext(ORCHESTRATOR_POLL_MS); // 浏览器模式没有 Tauri IO
    return;
  }
  if (host.isBusy()) {
    scheduleNext(ORCHESTRATOR_POLL_MS); // 聊天进行中 —— 进化让路
    return;
  }
  const now = Date.now();
  if (lastCycleAt && now - lastCycleAt < ORCHESTRATOR_MIN_GAP_MS) {
    scheduleNext(computeNextCycleDelayMs(lastCycleAt, now));
    return;
  }
  // 先记账再跑：哪怕循环抛异常/被杀，间隔照走 —— 绝不陷入忙循环。
  lastCycleAt = now;
  try {
    await runSleepTimeCycle(await buildGuiSleepTimeDeps(cfg ?? defaults()));
  } catch (err) {
    console.error('[pure] evolution cycle failed:', err);
  }
  document.dispatchEvent(new CustomEvent('pure:evolution-cycle'));
  scheduleNext();
}

// ── 游标持久化（read_file / write_file invoke —— 与 overlay 落盘同一条缝；
// 形状闸 sanitizeCursor 在纯核，CLI 宿主同一份）──

async function loadCursor(): Promise<OrchestratorCursor | undefined> {
  const core = await loadTauriCore();
  if (!core) return undefined;
  try {
    const pureHome = await join(await homeDir(), '.pure');
    const raw = await core.invoke<string>('read_file', { workspace: pureHome, path: CURSOR_PATH });
    return sanitizeCursor(JSON.parse(raw));
  } catch {
    return undefined; // 缺文件/坏 JSON → 从头开始（reflect: 查重与 overlay 同名不覆盖兜底）
  }
}

async function saveCursor(cursor: OrchestratorCursor): Promise<void> {
  const core = await loadTauriCore();
  if (!core) return;
  try {
    const pureHome = await join(await homeDir(), '.pure');
    await core.invoke('write_file', { workspace: pureHome, path: CURSOR_PATH, content: JSON.stringify(cursor) });
  } catch (err) {
    console.error('[pure] evolution cursor save failed:', err);
  }
}

// ── 会话档案（GUI 的 session.json 走 load_session / load_session_list Rust 缝）──

interface RawSessionMeta {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messageCount?: number;
  workspace?: string;
}

async function listPendingSessions(): Promise<SleepTimeSessionRef[]> {
  const workspace = host.getWorkspace();
  try {
    const list = await tauriInvoke<RawSessionMeta[]>('load_session_list');
    return (list ?? [])
      .filter((s) => typeof s.id === 'string' && s.id
        && typeof s.updatedAt === 'number' && s.updatedAt > 0
        && (s.workspace ?? '') === workspace) // 只反思当前项目的会话（记忆按项目隔离）
      .map((s) => ({ id: s.id as string, updatedAt: s.updatedAt as number }));
  } catch {
    return [];
  }
}

async function loadSession(id: string): Promise<SleepTimeTurnInput | undefined> {
  try {
    const data = await tauriInvoke<{ snapshot?: { modelContext?: { messages?: Message[] }; messages?: Message[] } } | null>(
      'load_session',
      { sessionId: id },
    );
    if (!data?.snapshot) return undefined;
    const messages = data.snapshot.modelContext?.messages ?? data.snapshot.messages ?? [];
    return sessionTurnFromMessages(messages);
  } catch {
    return undefined;
  }
}

// ── 依赖装配 ──

async function buildGuiSleepTimeDeps(cfg: PureConfig): Promise<SleepTimeDeps> {
  // P0-2 — 反思/overlay 起草走 E0.3 的 REFLECT 相位通道（同 Harness 的
  // llmFor('REFLECT') 契约）：配了 reflect 相位路由就建便宜模型 adapter，
  // 没配回退主模型（现状不变，零新配置面）。
  const reflectModel = reflectModelFor(cfg.phaseModels, cfg.model);
  return {
    cursor: { load: loadCursor, save: saveCursor },
    listPendingSessions,
    loadSession,
    memory: memoryStore,
    llm: reflectModel ? createLLMAdapter({ ...cfg, model: reflectModel }) : createLLMAdapter(cfg),
    projectPath: host.getWorkspace(),
    observations: async () => {
      try {
        return (await readGuiObservations()).records;
      } catch {
        return [];
      }
    },
    runOverlayFlow: async (advice, signal) => {
      const deps = await buildOverlayFlowDeps({
        role: advice.role,
        advice,
        cfg,
        confirm: async () => true, // 到 confirm 即 A/B verdict==='allow' → 门禁通过即自动落盘
      });
      if (!deps) return { outcome: 'failed', reason: 'overlay host unavailable' };
      return runPersonaOverlayFlow(signal ? { ...deps, signal } : deps);
    },
    applySkillGate: (advice) => {
      if (!advice.skillId) return;
      const applied = buildSkillGateAppliedRecord(advice, Date.now());
      if (!applied) return;
      // settings.ts「一键应用技能闸」同一语义：翻转 + persist + 观测记账。
      const cur = loadConfig() ?? defaults();
      cur.skills[advice.skillId] = false;
      persistConfig(cur);
      invalidateConfigCache();
      createTauriObservationSink()?.append(applied);
    },
    confirmPolicy: (action) => {
      if (action.kind === 'skill-gate') {
        const cur = loadConfig();
        if (cur?.skills?.[action.skillId] === false) return 'skip'; // 闸已关，无事可做
      }
      return defaultConfirmPolicy()(action);
    },
    budget: SLEEP_TIME_BUDGETS.gui,
    onAction: (action) => {
      console.info(`[pure] evolution cycle: ${action.kind}`);
    },
  };
}

/** 启动空闲进化循环（幂等；main.ts deferred init 调用）。 */
export function startEvolutionOrchestratorTimer(timerHost: OrchestratorTimerHost): void {
  if (started) return;
  started = true;
  host = timerHost;
  scheduleNext();
}

/** 停止空闲进化循环（幂等；测试/卸载用）。 */
export function stopEvolutionOrchestratorTimer(): void {
  started = false;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}
