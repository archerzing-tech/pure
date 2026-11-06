// src/character/soulOverrideIO.ts
// SOUL.md 覆盖层的 node 侧读盘薄壳（2026-11-06）。
//
// 单独成文件而不进 soulOverride.ts：soulOverride 必须 bundle 安全（GUI 的
// WebView 引擎也跑覆盖层，node:fs 静态导入会让 vite build 判死——v3.3.3
// 判例），而 CLI/gateway 是 node 侧，直读两层盘上文件。GUI 不走这里：它经
// Tauri invoke('read_file') 读到文本后直接调 applySoulOverrideTexts。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySoulOverrideTexts, type SoulOverrideReport } from './soulOverride';

/** 读 <dir>/SOUL.md；缺文件或读不了返回 null（缺层=缺省，不报错）。 */
function readSoulAt(dir: string | null | undefined): string | null {
  if (!dir) return null;
  try {
    const p = join(dir, 'SOUL.md');
    if (!existsSync(p)) return null;
    const text = readFileSync(p, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** 读两层盘上 SOUL.md 并应用覆盖（globalUserRoot 先铺、workspaceRoot 覆盖）。 */
export function applySoulOverridesFromDisk(
  roots: { globalUserRoot?: string | null; workspaceRoot?: string | null } = {},
): SoulOverrideReport {
  return applySoulOverrideTexts({
    global: readSoulAt(roots.globalUserRoot),
    workspace: readSoulAt(roots.workspaceRoot),
  });
}
