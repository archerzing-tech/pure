// src/ui/personaOverlayFlow.ts
// 北极星第 6 步 13.3（part 3）— overlay 起草流的编排核心（无 Tauri / 无 DOM）。
//
// 设计口径（capability-self-extension-design.md §13.3）：overlay 只在跑通该角色的
// 回归 A/B 后落盘（写盘前强跑；样本不足一律 DENY）。Settings 处理器只负责把
// Tauri IO、provider adapter、确认弹窗接进来；判卷/裁决与这里的分支只有一份定义，
// 因此 e2e（scripts/e2e-overlay-flow.ts）能用 mock provider 驱动**同一段代码**，
// 而不必复刻逻辑。依赖全部注入，模块本身零副作用。

import { compilePersonaOverlays } from '../harness/personaOverlays';
import type { OverlayDraftInput } from '../harness/personaOverlayReflector';
import type { RoleCaseFixture, RoleSideScore } from '../evaluation/roleRegression';
import { runRoleRegressionAB, type RoleRegressionResult, type RunRoleCase } from '../evaluation/roleRegressionRun';

export type OverlayFlowOutcome =
  | 'written'
  | 'none'
  | 'invalid'
  | 'deny'
  | 'reject'
  | 'exists'
  | 'cancelled'
  | 'failed';

export interface OverlayFlowDeps {
  role: string;
  /** base persona 契约（宿主用 def.createSystemPrompt 渲染，失败退 description）。 */
  baseContract: string;
  /** 该角色当前的失败画像（E1.4 的建议条目）。 */
  advice: OverlayDraftInput['advice'];
  /** 当前全部可委派角色名（overlay 校验用）。 */
  knownRoles: string[];
  /** 便宜模型起草（宿主绑定 adapter 后传入）。 */
  draft: (input: OverlayDraftInput) => Promise<string | undefined>;
  /** 该角色的回归 fixtures（宿主已逐文件校验/跳过坏文件）。 */
  loadFixtures: (role: string) => Promise<RoleCaseFixture[]>;
  /** 目标 overlay 文件是否已存在（同名不覆盖）。 */
  overlayExists: (role: string) => Promise<boolean>;
  /** 落盘（宿主写 ~/.pure/personas/<role>.overlay.md）。 */
  writeOverlay: (role: string, text: string) => Promise<void>;
  /** 落盘前确认；返回 false = 用户取消。 */
  confirm: (info: { role: string; file: string; base: RoleSideScore; overlay: RoleSideScore }) => Promise<boolean>;
  /** A/B 的宿主接缝：跑一例（base 侧 overlay 为 undefined）。 */
  runCase: RunRoleCase;
  /** 阶段回调（宿主做进度提示）。 */
  onStage?: (stage: 'draft' | 'gate' | 'write', detail?: string) => void;
  /** 可取消：A/B 在每例前后检查，abort 后流程返回 'cancelled' 且不落盘。 */
  signal?: AbortSignal;
  /** A/B 样本数上限（宿主可收更紧；核心另有硬上限）。 */
  maxCases?: number;
}

export interface OverlayFlowResult {
  outcome: OverlayFlowOutcome;
  /** deny/reject/failed 时的人话原因（宿主直接展示）。 */
  reason?: string;
  base?: RoleSideScore;
  overlay?: RoleSideScore;
}

/**
 * 起草 → 校验 → A/B 门槛 → 确认 → 落盘。任何一步失败都返回明确的 outcome，
 * 绝不静默落盘：校验器/门槛都是**在写盘前**跑的。
 */
export async function runPersonaOverlayFlow(deps: OverlayFlowDeps): Promise<OverlayFlowResult> {
  const { role } = deps;

  // 1) 起草
  deps.onStage?.('draft');
  let overlay: string | undefined;
  try {
    overlay = await deps.draft({ role, advice: deps.advice, baseContract: deps.baseContract });
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (!overlay) return { outcome: 'none' };

  // 2) 校验（part 1 的同一编译器）
  const compiled = compilePersonaOverlays([{ file: `${role}.overlay.md`, text: overlay }], deps.knownRoles);
  if (compiled.errors.length > 0 || !compiled.overlays.has(role)) {
    return { outcome: 'invalid', reason: compiled.errors.join('; ') };
  }

  // 3) A/B 门槛（写盘前强跑）
  const fixtures = await deps.loadFixtures(role);
  deps.onStage?.('gate', String(fixtures.length));
  let ab: RoleRegressionResult;
  try {
    ab = await runRoleRegressionAB({
      role,
      fixtures,
      overlay,
      runCase: deps.runCase,
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.maxCases !== undefined ? { maxCases: deps.maxCases } : {}),
    });
  } catch (err) {
    // Cancellation is not a failure — nothing was written either way.
    if (err instanceof Error && err.name === 'AbortError') return { outcome: 'cancelled' };
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (ab.verdict === 'deny_insufficient_data') return { outcome: 'deny', reason: ab.reason, base: ab.base, overlay: ab.overlay };
  if (ab.verdict === 'reject') return { outcome: 'reject', reason: ab.reason, base: ab.base, overlay: ab.overlay };

  // 4) 确认 + 落盘（同名不覆盖）
  if (await deps.overlayExists(role)) return { outcome: 'exists', base: ab.base, overlay: ab.overlay };
  const ok = await deps.confirm({ role, file: `${role}.overlay.md`, base: ab.base, overlay: ab.overlay });
  if (!ok) return { outcome: 'cancelled', base: ab.base, overlay: ab.overlay };

  deps.onStage?.('write');
  try {
    await deps.writeOverlay(role, overlay);
  } catch (err) {
    return { outcome: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
  return { outcome: 'written', base: ab.base, overlay: ab.overlay };
}
