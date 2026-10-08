// src/ui/overlayRevertHost.ts
// P1-2 — 已回退 overlay 的 GUI 宿主缝（判定/恢复纯逻辑在 harness/overlayGuard.ts，
// 这里只做 Tauri IO 与数据源装配——与 toolQuarantineHost 同构）。
//
// 为什么单独一个模块：回退护栏有两个人用——装载面经 loadOverlayText 决定装哪段
// 文本，设置页要列出已回退的、给恢复入口。两处各读各的 meta 会漂移成两个真相
// （「装载面认为它回退了、面板认为它没有」）。这里一个 owner。
//
// 红线（与 toolQuarantineHost 同一条）：`skills.evolution === false` 时返回
// 「什么都没有」——总开关关掉的会话不装载进化层，也不该看到回退卡或恢复动作。

import { isTauriRuntime, loadTauriCore, tauriInvoke } from '../shared/tauri';
import { join, homeDir } from '@tauri-apps/api/path';
import { loadConfig } from './config';
import { parseOverlayGuardMeta, reinstateOverlayMeta, type OverlayGuardMeta } from '../harness/overlayGuard';

export interface RevertedOverlayEntry {
  role: string;
  meta: OverlayGuardMeta;
}

function evolutionEnabled(): boolean {
  try {
    return loadConfig()?.skills?.evolution !== false;
  } catch {
    return true;
  }
}

/** 带自写 overlay 的角色清单（一次新鲜重扫——十秒前刚回退的必须立刻在屏上）。 */
async function scanRoles(): Promise<string[]> {
  if (!isTauriRuntime() || !evolutionEnabled()) return [];
  try {
    const files = await tauriInvoke<Array<{ file: string }>>('list_persona_overlays');
    return (files ?? []).map((f) => f.file.replace(/\.overlay\.md$/, ''));
  } catch (error) {
    console.warn('[overlay-revert] scan failed:', error);
    return [];
  }
}

async function readMeta(role: string): Promise<OverlayGuardMeta | undefined> {
  const core = await loadTauriCore();
  if (!core) return undefined;
  const pureHome = await join(await homeDir(), '.pure');
  try {
    // 坏 JSON / 错版本按「无 meta」处理（= 手写 overlay，豁免）——形状闸在纯核。
    return parseOverlayGuardMeta(await core.invoke<string>('read_file', {
      workspace: pureHome,
      path: `personas/${role}.overlay.meta.json`,
    }));
  } catch {
    return undefined;
  }
}

/** 设置页的数据源：当前带回退标记的 overlay（最近回退的排最前）。 */
export async function loadRevertedOverlays(): Promise<RevertedOverlayEntry[]> {
  const out: RevertedOverlayEntry[] = [];
  for (const role of await scanRoles()) {
    const meta = await readMeta(role);
    if (meta?.revertedAt !== undefined) out.push({ role, meta });
  }
  return out.sort((a, b) => (b.meta.revertedAt ?? 0) - (a.meta.revertedAt ?? 0));
}

/**
 * 用户动作：恢复 = 删掉 meta 的回退标记，装载侧随即回到 overlay 正文（正文
 * 在回退时从未被动过）；不碰 overlay 内容本身——恢复的就是被回退的那份文本，
 * 归档 .reverted.md 保留作历史。
 */
export async function reinstateOverlay(role: string): Promise<void> {
  if (!isTauriRuntime() || !evolutionEnabled()) return;
  const meta = await readMeta(role);
  if (!meta) throw new Error(`no readable overlay meta for ${role}`);
  const core = await loadTauriCore();
  if (!core) throw new Error('tauri core unavailable');
  const pureHome = await join(await homeDir(), '.pure');
  await core.invoke('write_file', {
    workspace: pureHome,
    path: `personas/${role}.overlay.meta.json`,
    content: `${JSON.stringify(reinstateOverlayMeta(meta), null, 2)}\n`,
  });
}
