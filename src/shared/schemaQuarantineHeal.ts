// src/shared/schemaQuarantineHeal.ts
// Schema 隔离摘除的披露层（2026-11-07 决策边界 A 档收尾）。端点对捆绑工具
// schema 400（2026-11-01 rea 判例）时引擎自愈：一振剥 pattern（对模型行为
// 零影响，无需披露）、二振把该工具整个摘出清单。摘除是宿主动了模型的手脚，
// 此前三重静默——模型发现工具没了不知为什么（反复调用已消失的工具空耗轮
// 次）、用户无感、error_pattern 账目不可见。watchdog 判例（亮灯不静默）+
// 现状可见三件套：摘除必须披露。
// 引擎摘除时 record；各面 user-turn 装配（GUI buildEnvFacts / CLI
// buildCliEnvFacts）读走注入——模型看到「哪个工具因 schema 被摘、为什么、
// 现在调它会怎样」，自己决定换路或转告用户。读即清，无事件零注入。
// shared 层不碰存储，也不读 i18n（providerSelfHeal 同构）。

export interface SchemaQuarantineEvent {
  /** 被摘除的工具名。 */
  tool: string;
  /** 触发摘除的端点错误原文（截断），作为「为什么被拒」的证据。 */
  detail: string;
}

/** 从一段端点错误里摘出可读的一段（去掉围栏、压掉换行）。 */
function excerpt(message: string, limit = 160): string {
  const cleaned = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned;
}

/** 引擎用的截断入口（错误原文 → 证据行）。 */
export function schemaQuarantineDetail(message: string): string {
  return excerpt(message);
}

let quarantineEvents: SchemaQuarantineEvent[] = [];

export function recordSchemaQuarantineEvent(ev: SchemaQuarantineEvent): void {
  quarantineEvents.push(ev);
  if (quarantineEvents.length > 8) {
    quarantineEvents.splice(0, quarantineEvents.length - 8);
  }
}

/** 读走全部摘除事件（读即清）渲染成 user-turn 事实行；无事件返回空串。
 *  按工具名去重（同工具反复 400 天然归并）。 */
export function takeSchemaQuarantineFacts(): string {
  const events = quarantineEvents;
  quarantineEvents = [];
  if (events.length === 0) return '';
  const seen = new Map<string, SchemaQuarantineEvent>();
  for (const e of events) seen.set(e.tool, e);
  const rows = [...seen.values()].map(
    (e) =>
      `"${e.tool}" was dropped from your tool list — the endpoint rejected its schema twice, even pattern-free (${e.detail}); calling it now fails as an unknown tool. If the task still needs it, route around it or tell the user the MCP server ships an incompatible schema (disabling that server clears the session)`,
  );
  return `Tool schema quarantine (the host removed these tools to keep the session alive — the removal is the fact, what to do next is your call): ${rows.join('; ')}.`;
}

/** 测试与跨面清场用（进程级模块状态的读即清语义，见 flaky-quartet 判例）。 */
export function resetSchemaQuarantineForTests(): void {
  quarantineEvents = [];
}
