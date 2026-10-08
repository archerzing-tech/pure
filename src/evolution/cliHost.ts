// src/evolution/cliHost.ts
// P0-1 — CLI 宿主：把刚结束的会话直喂进 sleep-time 进化编排器（纯核
// src/evolution/sleepTimeOrchestrator.ts），接上 观测→建议→技能闸/overlay 门禁
// 的增量路由。CLI 没有会话档案（oneshot 的消息流只在内存里），所以走
// directSession 直喂而不是 listPendingSessions/loadSession；游标照常落
// ~/.pure/evolution/orchestrator.json（node fs —— 与 GUI 的 read_file/write_file
// invoke 各走各的缝，写的是同一份 JSON）。
//
// 纪律与 GUI 宿主同源：总开关由宿主把守（env PURE_EVOLUTION_DISABLED=1 或
// config.skills.evolution === false ⇒ 不调纯核 = 与今日逐字节一致）；技能闸
// 翻转是 settings.ts「一键应用」的 CLI 同款语义（flip + saveConfig + 记账）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PURE_DIR, loadConfig, saveConfig } from '../cliConfig';
import { FilePromptObservationStore } from '../shared/FilePromptObservationStore';
import { buildSkillGateAppliedRecord } from '../shared/subagentAdvisory';
import { loadDelegableRoleNames } from '../ui/delegableRoles';
import { memoryStore } from '../cliHarness';
import type { LLMAdapter, Message } from '../shared/types';
import { runCliOverlayGuardPass } from './overlayGuardHost';
import {
  SLEEP_TIME_BUDGETS,
  defaultConfirmPolicy,
  runSleepTimeCycle,
  sanitizeCursor,
  sessionTurnFromMessages,
  type CycleResult,
  type OrchestratorCursor,
  type SleepTimeDeps,
  type SleepTimeAction,
} from './sleepTimeOrchestrator';

const CURSOR_PATH = `${PURE_DIR}/evolution/orchestrator.json`;
const CLI_OBSERVATIONS_PATH = `${PURE_DIR}/observations/cli.jsonl`;

/** 进化总开关（CLI 口径）：env 显式禁用 或 GUI 面板关了总开关 ⇒ 不进循环。 */
export function cliEvolutionDisabled(): boolean {
  if (process.env.PURE_EVOLUTION_DISABLED === '1') return true;
  try {
    return loadConfig()?.skills?.evolution === false;
  } catch {
    return false;
  }
}

// ── 游标（node fs 直读写，形状闸 sanitizeCursor 在纯核与 GUI 共用；
// 坏文件当不存在 —— 纯核有查重兜底）──

function loadCursor(): OrchestratorCursor | undefined {
  try {
    if (!existsSync(CURSOR_PATH)) return undefined;
    return sanitizeCursor(JSON.parse(readFileSync(CURSOR_PATH, 'utf8')));
  } catch {
    return undefined;
  }
}

function saveCursor(cursor: OrchestratorCursor): void {
  try {
    mkdirSync(dirname(CURSOR_PATH), { recursive: true });
    writeFileSync(CURSOR_PATH, JSON.stringify(cursor), 'utf8');
  } catch {
    // 游标写不进就丢 —— 纯核的 reflect: 查重 + overlay 同名不覆盖兜底正确性。
  }
}

// ── 依赖装配 ──

function buildCliSleepTimeDeps(llm: LLMAdapter, projectPath: string, budget: 'cli' | 'exit', onAction?: (action: SleepTimeAction) => void): SleepTimeDeps {
  const observations = new FilePromptObservationStore(CLI_OBSERVATIONS_PATH);
  return {
    cursor: { load: async () => loadCursor(), save: async (c) => saveCursor(c) },
    // CLI 没有会话档案 —— 直喂由 runCliSleepCycle 塞进 deps.directSession。
    memory: memoryStore,
    llm,
    projectPath,
    // 生成角色也在可委派面内：这是唯一会自动写盘的观察者，不接就等于
    // 13.2 的数据只通到设置页的显示层，通不到真正会动手的那一半。
    roleSurface: () => loadDelegableRoleNames(),
    observations: () => {
      try {
        return observations.list();
      } catch {
        return [];
      }
    },
    // settings.ts「一键应用技能闸」同一语义：翻转 + persist + advice_applied 记账。
    applySkillGate: (advice) => {
      if (!advice.skillId) return;
      const applied = buildSkillGateAppliedRecord(advice, Date.now());
      if (!applied) return;
      const cfg = loadConfig();
      if (!cfg) return; // 没有 config 文件就没闸可拉
      cfg.skills = { ...cfg.skills, [advice.skillId]: false };
      saveConfig(cfg);
      observations.append(applied);
    },
    confirmPolicy: (action) => {
      if (action.kind === 'skill-gate') {
        try {
          if (loadConfig()?.skills?.[action.skillId] === false) return 'skip'; // 闸已关
        } catch { /* 读不到 config 就按默认策略走 */ }
      }
      return defaultConfirmPolicy()(action);
    },
    // P2-2 — procedure→工具固化（CLI 侧：node:fs 写盘 + Bun.spawn 试跑；
    // confirm 绑 true = 试跑通过即自动落盘，与 GUI sleep-time 同立场）。
    runSolidify: async (procedure) => {
      try {
        const { runSolidifyFlow } = await import('../harness/toolSolidification');
        const { mkdir, writeFile, access } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const toolsDir = join(homedir(), '.pure', 'tools');
        return await runSolidifyFlow({
          procedure,
          llm,
          io: {
            runCommand: (command, timeoutMs) => new Promise((resolve) => {
              const proc = Bun.spawn(command.split(/\s+/), {
                stdout: 'pipe',
                stderr: 'pipe',
                timeout: timeoutMs,
              });
              proc.exited.then(async (code) => {
                const ok = code === 0;
                const text = await new Response(proc.stdout).text();
                resolve({ ok, output: text.slice(0, 500) });
              }).catch(() => resolve({ ok: false, output: 'spawn failed' }));
            }),
            writeToolDir: async (name, manifest) => {
              const dir = join(toolsDir, name);
              await mkdir(dir, { recursive: true });
              await writeFile(join(dir, 'TOOL.json'), manifest, 'utf8');
            },
            toolExists: async (name) => {
              try {
                await access(join(toolsDir, name, 'TOOL.json'));
                return true;
              } catch {
                return false;
              }
            },
          },
          confirm: async () => true,
        });
      } catch (err) {
        return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
      }
    },
    budget: SLEEP_TIME_BUDGETS[budget],
    onAction,
  };
}

export interface CliSleepCycleInput {
  /** 反思/起草用 LLM：调用方经 resolveReflectAdapter 解析（P0-2 —— 配了
   *  REFLECT 相位路由走便宜模型，没配即主 adapter）。 */
  llm: LLMAdapter;
  /** 刚结束会话的 id（reflect: 查重键的一半 —— 与 Harness 落库格式对齐）。 */
  sessionId: string;
  projectPath: string;
  /** 会话完整消息流（直喂，不落档案；无真实 user 消息则跳过反思段）。 */
  messages: Message[];
  /** 'cli' = oneshot 末 30s 预算；'exit' = /exit 前 10s 速战速决。 */
  budget?: 'cli' | 'exit';
  onAction?: (action: SleepTimeAction) => void;
}

/**
 * CLI 的一轮 sleep-time 进化循环。总开关关了直接返回 undefined（零开销）；
 * 其余交给纯核 —— 永不 throw，进程退出路径上安全。
 */
export async function runCliSleepCycle(input: CliSleepCycleInput): Promise<CycleResult | undefined> {
  if (cliEvolutionDisabled()) return undefined;
  const turn = sessionTurnFromMessages(input.messages);
  const result = await runSleepTimeCycle({
    ...buildCliSleepTimeDeps(input.llm, input.projectPath, input.budget ?? 'cli', input.onAction),
    ...(turn ? { directSession: { ...turn, id: input.sessionId } } : {}),
  });
  // P1-2 — 同窗追加 overlay 回退判定（缝在 overlayGuardHost，GUI 挂 decay
  // 同一节流窗，CLI 挂 sleep 循环同一退出路径）。失败只降级本轮，绝不影响
  // 已完成的进化循环。
  try {
    const reverted = await runCliOverlayGuardPass({});
    if (reverted.length > 0) {
      console.warn(`[pure] overlay guard reverted: ${reverted.join(', ')}（原文见 .reverted.md，设置页可恢复）`);
    }
  } catch (err) {
    console.error('[pure] overlay guard pass failed:', err);
  }
  return result;
}
