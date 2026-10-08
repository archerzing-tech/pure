// src/harness/overlayGuard.ts
// P1-2 — overlay 落盘后的回退护栏（2026-10-01）。
//
// 洞（S1 之后才有真实对象）：13.3 的 overlay 是「起草 → A/B 一次 → allow 即
// 落盘」的单候选爬坡；落盘后若该角色持续回归，只有人工删文件。对照 MemSkill
// 的「保留最优快照、退化即回滚」：准入后这条腿是缺的。
//
// 设计（有意避开文件删除）：
//   - **落盘时快照**：写 overlay 的同一时刻把「落盘前状态」存进
//     `<role>.overlay.md.bak`（前版 overlay 文本；首次落盘则无 bak），并在
//     `<role>.overlay.meta.json` 记 writtenAt / prevExisted / 基线失败率。
//   - **回退 = meta 标记**：判定恶化后只在 meta 上写 revertedAt —— 不删任何
//     文件，完全可逆；被回退的 overlay 原文同时归档到 `.reverted.md` 供查看。
//   - **装载侧过滤**：宿主装载 overlay 时经 loadOverlayText 决定——meta 带
//     revertedAt 且 prevExisted ⇒ 装 .bak 前版；带 revertedAt 且无前版 ⇒ 不装
//     （回到 base persona）；不带 ⇒ 装正文。**没有 meta 的文件（用户手写）不受
//     此护栏管辖**——快照存在即授权，缺失即豁免，与 13.3 落盘流的ownership 对齐。
//   - **判定口径**（shouldRevertOverlay）：落盘后该角色派发 ≥8 次，失败率较
//     落盘基线恶化 ≥0.2 绝对值且 ≥1.5 倍（基线为 0 时只看绝对值）。只判卷
//     不诊断——回退记录带 reason，人来看。
//
// 本模块纯逻辑（IO 全注入）：GUI 经 Tauri read_file/write_file/
// list_persona_overlays，CLI 经 node:fs，测试经内存桩。

import type { PromptObservation } from '../shared/promptObservability';

export interface OverlayGuardMeta {
  version: 1;
  /** 本次 overlay 落盘时刻（判定窗口的起点）。 */
  writtenAt: number;
  /** 落盘前是否已有 overlay（决定回退目标是 .bak 前版还是 base persona）。 */
  prevExisted: boolean;
  /** 落盘时的失败画像基线（与 E1.4 同口径：delegations / failures / 百分比）。 */
  baseline: { delegations: number; failures: number; failureRate: number };
  /** 回退标记。存在即回退（装载侧过滤）；恢复 = 删掉这个字段。 */
  revertedAt?: number;
  revertedReason?: string;
}

/** 判定窗口内最少派发数：低于此不构成「持续回归」。 */
export const OVERLAY_GUARD_MIN_RUNS = 8;
/** 绝对恶化阈值（失败率小数）。 */
export const OVERLAY_GUARD_DELTA = 0.2;
/** 相对恶化阈值（倍数；基线为 0 时只看绝对值）。 */
export const OVERLAY_GUARD_RATIO = 1.5;

function overlayGuardFileNames(role: string): { overlay: string; bak: string; meta: string; reverted: string } {
  const overlay = `${role}.overlay.md`;
  return { overlay, bak: `${overlay}.bak`, meta: `${overlay}.meta.json`, reverted: `${overlay}.reverted.md` };
}

export function overlayGuardPaths(role: string): { overlay: string; bak: string; meta: string; reverted: string } {
  const names = overlayGuardFileNames(role);
  return {
    overlay: `personas/${names.overlay}`,
    bak: `personas/${names.bak}`,
    meta: `personas/${names.meta}`,
    reverted: `personas/${names.reverted}`,
  };
}

/** meta 的形状闸：坏 JSON / 错版本按「无 meta」处理（= 手写 overlay，豁免）。 */
export function parseOverlayGuardMeta(raw: string | undefined): OverlayGuardMeta | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as OverlayGuardMeta;
    if (parsed?.version !== 1 || typeof parsed.writtenAt !== 'number' || typeof parsed.prevExisted !== 'boolean') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/** 装载侧决策：这个角色的 overlay 该装哪段文本（undefined = 不装）。 */
export function loadOverlayText(
  meta: OverlayGuardMeta | undefined,
  overlayText: string,
  bakText: string | undefined,
): string | undefined {
  if (!meta || meta.revertedAt === undefined) return overlayText;
  // 已回退：有前版回前版，没前版回 base（不装）。
  return meta.prevExisted ? bakText : undefined;
}

/**
 * 用户触发的恢复（设置页「已回退 overlay」节）：删掉回退标记，装载侧随即
 * 回到 overlay 正文——恢复的就是被回退的那份文本（正文在回退时从未被动过），
 * 归档 .reverted.md 保留作历史。没被回退过 = 原样返回（幂等）。
 */
export function reinstateOverlayMeta(meta: OverlayGuardMeta): OverlayGuardMeta {
  const next: OverlayGuardMeta = { ...meta };
  delete next.revertedAt;
  delete next.revertedReason;
  return next;
}

/** 落盘后窗口内的角色结局统计（与 E1.4/subagentAdvisory 同口径计数）。 */
export function roleStatsSince(
  records: readonly PromptObservation[],
  role: string,
  since: number,
): { delegations: number; failures: number } {
  let delegations = 0;
  let failures = 0;
  for (const record of records) {
    if (record.type !== 'agent_run') continue;
    if (record.startedAt < since) continue;
    for (const call of record.toolCalls ?? []) {
      if (call.toolName !== role) continue;
      delegations++;
      if (call.success === false) failures++;
    }
  }
  return { delegations, failures };
}

export interface OverlayGuardVerdict {
  revert: boolean;
  reason?: string;
}

/** 判定：落盘后持续回归 ⇒ 回退。样本不足 / 恶化不达标 ⇒ 不动。 */
export function shouldRevertOverlay(
  meta: OverlayGuardMeta,
  since: { delegations: number; failures: number },
): OverlayGuardVerdict {
  if (meta.revertedAt !== undefined) return { revert: false }; // 已回退过，不反复横跳
  if (since.delegations < OVERLAY_GUARD_MIN_RUNS) {
    return { revert: false, reason: `runs ${since.delegations} < ${OVERLAY_GUARD_MIN_RUNS}` };
  }
  const rate = since.failures / since.delegations;
  const base = meta.baseline.failureRate / 100;
  const deltaOk = rate >= base + OVERLAY_GUARD_DELTA;
  const ratioOk = base > 0 ? rate >= base * OVERLAY_GUARD_RATIO : true;
  if (deltaOk && ratioOk) {
    return { revert: true, reason: `落盘后 ${since.delegations} 派发失败 ${since.failures}（${Math.round(rate * 100)}%），基线 ${meta.baseline.failureRate}%` };
  }
  return { revert: false, reason: `rate ${Math.round(rate * 100)}% vs baseline ${meta.baseline.failureRate}%` };
}

/** IO 接缝（GUI= Tauri invoke，CLI = node:fs，测试 = 内存桩）。 */
export interface OverlayGuardIo {
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * 落盘写手（13.3 流的 writeOverlay 升级版）：同一时刻落 overlay + .bak 前版
 * 快照 + meta 基线。IO 失败上抛（调用方的落盘路径本来就会失败）。
 */
export async function writeOverlayGuardedly(
  io: OverlayGuardIo,
  role: string,
  text: string,
  baseline: OverlayGuardMeta['baseline'],
  now = Date.now(),
): Promise<void> {
  const paths = overlayGuardPaths(role);
  const prev = await io.readFile(paths.overlay).catch(() => undefined);
  const prevExisted = typeof prev === 'string' && prev.trim().length > 0;
  if (prevExisted) await io.writeFile(paths.bak, prev!);
  const meta: OverlayGuardMeta = { version: 1, writtenAt: now, prevExisted, baseline };
  await io.writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  await io.writeFile(paths.overlay, `${text}\n`);
}

/**
 * 周期判定 pass（GUI 挂 decay/棘轮同一节流窗）：对每个带 meta 且未回退的
 * overlay，用落盘后的真实结局判定是否回退。回退动作 = 归档原文 + meta 写
 * revertedAt（不删文件、可逆）。返回报告供日志/通知。
 */
export async function runOverlayGuardPass(
  io: OverlayGuardIo,
  roles: readonly string[],
  records: readonly PromptObservation[],
  now = Date.now(),
): Promise<{ checked: number; reverted: string[] }> {
  const reverted: string[] = [];
  for (const role of roles) {
    const paths = overlayGuardPaths(role);
    const meta = parseOverlayGuardMeta(await io.readFile(paths.meta).catch(() => undefined));
    if (!meta || meta.revertedAt !== undefined) continue;
    const overlayText = await io.readFile(paths.overlay).catch(() => undefined);
    if (!overlayText) continue; // overlay 已被人删掉 —— 没什么可守的
    const verdict = shouldRevertOverlay(meta, roleStatsSince(records, role, meta.writtenAt));
    if (!verdict.revert) continue;
    await io.writeFile(paths.reverted, `# reverted ${new Date(now).toISOString()}\n# ${verdict.reason}\n\n${overlayText}`);
    await io.writeFile(paths.meta, `${JSON.stringify({ ...meta, revertedAt: now, revertedReason: verdict.reason }, null, 2)}\n`);
    reverted.push(role);
  }
  return { checked: roles.length, reverted };
}
