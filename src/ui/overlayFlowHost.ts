// src/ui/overlayFlowHost.ts
// 13.3 overlay 流的 GUI 宿主装配 —— Tauri IO（fixtures/overlay 文件）+ provider
// adapter + A/B 跑例。判卷/裁决在 personaOverlayFlow 只有一份定义；settings
// 建议卡的「起草 overlay」按钮与 sleep-time 编排器共用这里这一份装配，宿主
// 差异只剩确认缝：settings 弹人确认，编排器按「到 confirm 即 A/B
// verdict==='allow'」自动允许（门禁通过即自动落盘的既定立场）。

import { loadTauriCore, getApplicationTmpWorkspace } from '../shared/tauri';
import { join, homeDir } from '@tauri-apps/api/path';
import { createLLMAdapter } from './chat';
import { TauriToolAdapter } from './TauriToolAdapter';
import { draftPersonaOverlay } from '../harness/personaOverlayReflector';
import { SubagentOrchestrator } from '../coding-agent/SubagentOrchestrator';
import { allRoleNames, findRoleDefinition } from './delegableRoles';
import type { SubagentDefinition } from '../coding-agent/types';
import { extractSubagentOutput, type RoleCaseFixture } from '../evaluation/roleRegression';
import { runPersonaOverlayFlow, type OverlayFlowDeps } from './personaOverlayFlow';
import { writeOverlayGuardedly } from '../harness/overlayGuard';
import type { BudgetConfig, ToolCall } from '../shared/types';
import type { SubagentAdvice } from '../shared/subagentAdvisory';
import type { PureConfig } from './config';

/** A/B 每例的编排预算（与 settings 原装配一致 —— 便宜角色的回归小步快跑）。 */
export const OVERLAY_AB_BUDGET: BudgetConfig = {
  maxTurns: 12,
  maxTotalTokens: 120_000,
  maxExecutionTime: 12 * 60 * 1000,
  warningThreshold: 0.8,
  graceTurns: 1,
};

/** base persona 契约摘要（宿主用 def.createSystemPrompt 渲染，失败退 description）。 */
export function safeRoleContract(def: SubagentDefinition): string {
  try {
    return def.createSystemPrompt({});
  } catch {
    return def.description;
  }
}

/** 逐文件校验 fixture：一个坏文件不拖垮整批。 */
export function isRoleCaseFixture(value: unknown): value is RoleCaseFixture {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.args === 'object' && v.args !== null
    && Array.isArray(v.must) && v.must.every((m) => typeof m === 'string');
}

export interface OverlayHostOptions {
  role: string;
  /** 该角色当前的失败画像（E1.4 建议条目 —— 起草的唯一事实来源）。 */
  advice: SubagentAdvice;
  cfg: PureConfig;
  /** 确认缝：settings 弹人确认；编排器传 `async () => true`。 */
  confirm: OverlayFlowDeps['confirm'];
  /** 阶段回调（settings 做进度 toast；编排器不需要）。 */
  onStage?: OverlayFlowDeps['onStage'];
}

/**
 * 装配 runPersonaOverlayFlow 的全部宿主依赖。不可用（非 Tauri / core 缺失 /
 * 未知角色）返回 undefined —— 调用方按自己的语境提示。
 */
export async function buildOverlayFlowDeps(opts: OverlayHostOptions): Promise<OverlayFlowDeps | undefined> {
  const core = await loadTauriCore();
  if (!core) return undefined;
  const def = await findRoleDefinition(opts.role);
  if (!def) return undefined;
  // 生成角色也在面上：草稿的 `targetRole` 校验必须用同一份名单（含已归档的——
  // 一个在盘上存在的角色是合法目标），否则一条合法草稿会被判成「未知角色」
  // 而整条流退回。名字数组此前是内建七角色的第二份副本，已收进 delegableRoles。
  const knownRoles = await allRoleNames();
  const pureHome = await join(await homeDir(), '.pure');
  const workspace = await getApplicationTmpWorkspace(`role-overlay-${opts.role}`);
  const adapter = createLLMAdapter(opts.cfg);

  return {
    role: opts.role,
    baseContract: safeRoleContract(def),
    advice: opts.advice,
    knownRoles,
    draft: (input) => draftPersonaOverlay(adapter, input),
    loadFixtures: async (r) => {
      const out: RoleCaseFixture[] = [];
      try {
        const files = await core.invoke<Array<{ file: string; text: string }>>('list_role_cases', { role: r });
        for (const file of files ?? []) {
          try {
            const parsed: unknown = JSON.parse(file.text);
            if (isRoleCaseFixture(parsed)) out.push(parsed);
          } catch {
            // skip a broken fixture file, keep the rest
          }
        }
      } catch {
        return [];
      }
      return out;
    },
    overlayExists: async (r) => {
      try {
        await core.invoke('read_file', { workspace: pureHome, path: `personas/${r}.overlay.md` });
        return true;
      } catch {
        return false; // 读不到 = 还没这个 overlay，正是落盘前提
      }
    },
    writeOverlay: async (r, text) => {
      // P1-2 回退护栏 — 落盘写手升级：同一时刻写 .bak 前版快照 + meta 基线
      //（E1.4 画像里的真实数字），供周期判定与装载侧回退。
      await writeOverlayGuardedly(
        {
          readFile: async (path) => {
            try {
              return await core.invoke<string>('read_file', { workspace: pureHome, path });
            } catch {
              return undefined;
            }
          },
          writeFile: async (path, content) => {
            await core.invoke('write_file', { workspace: pureHome, path, content });
          },
        },
        r,
        text,
        { delegations: opts.advice.delegations, failures: opts.advice.failures, failureRate: opts.advice.failureRate },
      );
    },
    confirm: opts.confirm,
    runCase: async (fixture, ov) => {
      const tools = new TauriToolAdapter(workspace, opts.cfg.tavilyApiKey, opts.cfg.serperApiKey, opts.cfg.city, undefined, `role-overlay-${opts.role}`);
      const orch = new SubagentOrchestrator({
        llm: adapter,
        parentTools: tools,
        parentToolsDefsProvider: () => tools.getTools(),
        defaultBudget: OVERLAY_AB_BUDGET,
        parentSessionId: `role-overlay-${opts.role}`,
        ...(ov ? { personaOverlays: new Map([[opts.role, ov]]) } : {}),
      });
      orch.register(def);
      const toolCall: ToolCall = {
        id: `call_${fixture.id}`,
        index: 0,
        function: { name: opts.role, arguments: JSON.stringify(fixture.args) },
      };
      return extractSubagentOutput(await orch.execute(toolCall));
    },
    ...(opts.onStage ? { onStage: opts.onStage } : {}),
  };
}

/** settings 建议卡入口的薄封装：装配 + 跑流（行为与原内联装配逐字节一致）。 */
export async function runOverlayFlowForAdvice(
  opts: Omit<OverlayHostOptions, 'confirm'> & { confirm: OverlayFlowDeps['confirm'] },
): Promise<Awaited<ReturnType<typeof runPersonaOverlayFlow>> | undefined> {
  const deps = await buildOverlayFlowDeps(opts);
  if (!deps) return undefined;
  return runPersonaOverlayFlow(deps);
}
