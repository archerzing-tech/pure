// src/shared/formValidationFeedback.ts
// Form-validation truth feedback（刀 6 校验真话回流，2026-11-03）。
// 感知手脚哲学（设置自愈定调）：渲染/投影层的校验结果此前只给人看——模型
// 对自己围栏写错全盲，同样的错下次照犯。这里把校验事实记成事件，各面的
// user-turn 装配（GUI chat.ts / CLI cliRepl.ts）读走注入 envFacts 区，模型
// 看到真话自己决定怎么改。pure 不判断「该怎么改」——裁决权归模型。
// 双面共用一个实例：GUI 挂点在 markdown.ts（错误卡/修复 badge），CLI 挂点
// 在 cliDiagram.ts（投影/线框失败回退源码）。
// 无门控 v1：历史重渲染（切会话/编辑重发/回放）也会记事件——块确实失败过，
// 信息仍真；靠聚合封顶兜噪音，真机观察噪音率后再决定要不要门控。

export interface FormValidationEvent {
  lang: string;
  outcome: 'repaired' | 'failed';
  detail: string;
}

let formValidationEvents: FormValidationEvent[] = [];

export function recordFormValidation(lang: string | null, outcome: 'repaired' | 'failed', detail = ''): void {
  formValidationEvents.push({ lang: lang || 'unknown', outcome, detail: detail.slice(0, 120) });
  // 上限防爆：一个异常会话的理论极限也就几百个块，够用。
  if (formValidationEvents.length > 200) formValidationEvents.splice(0, formValidationEvents.length - 200);
}

/** 读走全部事件（读即清）并聚合成一行 user-turn 真话；无事件返回空串。
 *  按 lang+outcome 合并计数（同一 slot 的重试连败天然归并），行数封顶 5。 */
export function takeFormValidationFeedback(): string {
  const events = formValidationEvents;
  formValidationEvents = [];
  if (events.length === 0) return '';
  const tally = new Map<string, { count: number; detail: string }>();
  for (const ev of events) {
    const key = `${ev.lang}\n${ev.outcome}`;
    const hit = tally.get(key);
    if (hit) {
      hit.count += 1;
      if (!hit.detail && ev.detail) hit.detail = ev.detail;
    } else {
      tally.set(key, { count: 1, detail: ev.detail });
    }
  }
  const rows = [...tally.entries()].map(([key, { count, detail }]) => {
    const [lang, outcome] = key.split('\n');
    const times = count > 1 ? ` ×${count}` : '';
    const suffix = detail ? ` (${detail})` : '';
    return outcome === 'repaired' ? `${lang} auto-repaired${times}${suffix}` : `${lang} FAILED${times}${suffix}`;
  });
  const shown = rows.slice(0, 5);
  const rest = rows.length - shown.length;
  return `Fenced-block validation feedback: ${shown.join('; ')}${rest > 0 ? `; and ${rest} more` : ''}. Future output of these forms must follow each form's DSL exactly (presentation_guide form:"<id>" for the syntax).`;
}
