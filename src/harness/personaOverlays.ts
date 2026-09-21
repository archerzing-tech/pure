// src/harness/personaOverlays.ts
// 阶段 13.3 — 存量子 Agent prompt 自改进的装载半边。
//
// persona 拆两层：代码里的 base（不动）+ 进化 overlay（`~/.pure/personas/<role>.overlay.md`，
// 只增补约束/技巧，不重写 base）。本模块是 pure compiler：把宿主（GUI 走 Tauri invoke、
// CLI 走 node:fs）收集来的 `{ file, text }` 源编译成 role → overlay 文本映射。
// 它对文件系统一无所知——宿主用自己现成的 IO 收集源（同 13.2 externalSubagents 的分界），
// Bun 测试因此可以覆盖整条编译管线而无需 mock IO。
//
// 回滚契约：删掉 overlay 文件即回原样（注册表启动时扫描，运行中不热删——
// 下个会话自然消失，见 capability-self-extension-design.md 边界情况表）。

/** 每角色 overlay 字符上限。overlay 每次委派都会拼进 system prompt（阶段 8 的
 * token 预算要为它留空间），只增补约束/技巧的形态本来也不该长——超限直接拒绝，
 * 让起草方（反思器）学会收着写。 */
export const MAX_OVERLAY_CHARS = 4000;

const ROLE_RE = /^[a-z][a-z0-9_]{1,63}$/;

export interface PersonaOverlaySource {
  /** 文件名（不含路径）——用于错误归因。 */
  file: string;
  text: string;
}

export interface PersonaOverlaysResult {
  /** role name → overlay 文本。 */
  overlays: Map<string, string>;
  /** 每个被拒文件一行人话错误（坏角色名 / 空文本 / 超限 / 未知角色 / 重名）。
   * 宿主把它们打到 console/stderr，一个坏文件不拖累整个目录。 */
  errors: string[];
}

/** 编译 overlay 源。`knownRoles` 是当前全部可委派角色名（内建 + 外部声明）；
 * 提供时，指向不存在角色的 overlay 会被拒（宿主收集完角色后才知道全集，
 * 所以做成可选——省略时接受一切合法角色名）。同一角色多个文件：按源顺序
 * 先到先得，后者报重名。 */
export function compilePersonaOverlays(
  sources: PersonaOverlaySource[],
  knownRoles?: Iterable<string>,
): PersonaOverlaysResult {
  const known = knownRoles ? new Set(knownRoles) : null;
  const overlays = new Map<string, string>();
  const errors: string[] = [];
  for (const source of sources) {
    const role = overlayFileRole(source.file);
    if (!role) {
      errors.push(`${source.file}: filename must be <role>.overlay.md (role = [a-z][a-z0-9_]{1,63})`);
      continue;
    }
    const text = source.text.trim();
    if (text.length < 8) {
      errors.push(`${source.file}: overlay text is required (≥8 chars)`);
      continue;
    }
    if (text.length > MAX_OVERLAY_CHARS) {
      errors.push(`${source.file}: overlay exceeds ${MAX_OVERLAY_CHARS} chars (${text.length}) — keep it to added constraints/techniques, not an essay`);
      continue;
    }
    if (known && !known.has(role)) {
      errors.push(`${source.file}: no delegable role named "${role}" — skipped`);
      continue;
    }
    if (overlays.has(role)) {
      errors.push(`${source.file}: duplicate overlay for role "${role}" — the earlier file wins`);
      continue;
    }
    overlays.set(role, text);
  }
  return { overlays, errors };
}

/** `<role>.overlay.md` → role；不合形的文件名返回 null。 */
export function overlayFileRole(file: string): string | null {
  if (!file.endsWith('.overlay.md')) return null;
  const role = file.slice(0, -'.overlay.md'.length);
  return ROLE_RE.test(role) ? role : null;
}

/** 合并点语义：base 一字不动，overlay 作为「增补约束」追加在 base 之后、
 * 机械性输出格式说明（subagentReportNote）之前。无 overlay 时返回值与输入
 * 逐字节一致——没有 overlay 文件的行为与 13.3 之前完全相同。 */
export function applyPersonaOverlay(basePrompt: string, overlay: string | undefined): string {
  if (!overlay) return basePrompt;
  return `${basePrompt}\n\n${overlay}`;
}
