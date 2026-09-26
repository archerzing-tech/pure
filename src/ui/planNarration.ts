// src/ui/planNarration.ts
// 计划必须是当着用户想出来的（2026-09-26 用户定调，彻底替换「本地规则出卡」）：
// 出计划卡之前，模型先流式地把思考讲给用户听——思考的形状完全由模型自己定，
// 不给模板、不给提纲——讲完从同一条回复末尾解析出它自己愿意承诺的步骤清单。
// 这里只放纯函数：提示词拼装、思考/计划分流、流式展示裁剪、无卡时的执行指引。
// 编排（流式、超时、中止、气泡）在 chat.ts 的 planByThinking()。

import type { Plan } from '../coding-agent/types';

const PLAN_JSON_SHAPE = `{"reasoning": "why this plan, one short paragraph", "steps": [{"action": "imperative, short", "description": "what this step concretely does for THIS task", "expectedOutcome": "what exists or is verified when the step is done", "substeps": [{"action": "...", "description": "...", "expectedOutcome": "..."}], "todosRequired": false}]}`;

/**
 * 规划思考的提示词。刻意的克制：不规定思考的提纲、顺序、段数——一旦规定，
 * 就又回到「固定模式」。只规定实质约束：用用户的语言、以自己的口吻想清楚、
 * 假设要明说并直接往下走（不许停下来等答案）、不许复述请求、不许套话、
 * 思考结束以 ```json 围栏交出自己承诺的步骤、步骤必须被上面的思考挣出来。
 */
export function buildPlanThinkingPrompt(
  userText: string,
  opts: { projectBuild?: boolean; hasImages?: boolean } = {},
): { system: string; user: string } {
  const system = [
    'You are taking on this task yourself. Before doing anything, think it through in front of the user — in the user\'s language, as yourself.',
    'There is no required outline. Think the way a sharp colleague thinks out loud before committing to an approach, and let THIS task decide what needs saying: what the request hinges on, which constraints shape the work, what you assume about anything left unsaid (state the assumption and proceed — never stall on questions here), how you intend to approach it and why, and anything the user would want to veto before you start. Skip whatever does not deserve the words.',
    'Never pad, never repeat the request back verbatim, never open with ritual phrases, never end with "let me know if this looks good" — the plan below is the handoff.',
    'When the thinking is done, commit to the plan: a ```json fenced block, and nothing after it.',
    PLAN_JSON_SHAPE,
    'Give 2-6 steps. Every step must be earned by your thinking above — concrete to this task, never generic filler like "explore the workspace" or "gather requirements". Use "todosRequired": false only for a step that genuinely needs no Todo list.',
    opts.projectBuild
      ? 'This is a project-level build: the LAST step must be the delivery verification pipeline (code review, then typecheck, then unit tests, then e2e/build checks — fix failures and re-run until ALL pass).'
      : '',
  ].filter(Boolean).join('\n');
  const user = opts.hasImages
    ? `${userText}\n\n(Images are attached; take them into account.)`
    : userText;
  return { system, user };
}

/**
 * 把一条完整回复拆成「思考叙述」与「计划 JSON 原文」。计划围栏按约定在回复
 * 末尾，所以认最后一次出现的 ``` 开栏：叙述里 legitimately 出现过代码示例时
 * 不会被它截断。没有围栏 → planText 为空；只有开栏没闭合 → 取开栏之后全部
 * （交 parsePlanJsonWithMeta 的修复通道碰运气）。
 */
export function splitNarrationAndPlan(full: string): { narration: string; planText: string } {
  // 围栏按出现次序开合交替（0 基偶位=开栏）：最后一个开栏才是计划围栏——
  // 叙述里 legitimately 出现过代码示例时不会被它的闭合栏带偏。
  const markers: number[] = [];
  const re = /```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(full)) !== null) markers.push(m.index);
  let open = -1;
  for (let i = markers.length - 1; i >= 0; i--) {
    if (i % 2 === 0) { open = markers[i]; break; }
  }
  if (open < 0) return { narration: full, planText: '' };
  const narration = full.slice(0, open);
  const rest = full.slice(open + 3);
  // 跳过语言标记行（```json / ``` JSON …），取围栏体。
  const nl = rest.indexOf('\n');
  const body = nl >= 0 ? rest.slice(nl + 1) : rest;
  const close = body.lastIndexOf('```');
  const planText = (close >= 0 ? body.slice(0, close) : body).trim();
  return { narration, planText };
}

/**
 * 流式展示用：只显示第一个 ``` 之前的部分——计划 JSON 绝不当着用户闪现，
 * 叙述里即便先出现了代码示例，流式期先隐去后半段，收尾时由完整叙述接上。
 */
export function liveNarrationPortion(full: string): string {
  const open = full.indexOf('```');
  return open < 0 ? full : full.slice(0, open);
}

/**
 * 把模型自己刚讲出来的思考打包成交给引擎的执行语境。新会话首回合
 * hasHistory=false，引擎输入里没有这段思考（mergeTranscriptWithTurn 只在回合
 * 结束时才把它并回转录），所以必须原文嵌入 userPlan——「按上面那段思考开工」
 * 这种指路式写法在首回合是指向空气的。用户已看到思考，明确禁止复述。
 */
export function planThinkingContext(
  narration: string,
  opts: { projectBuild?: boolean; hasPlanCard?: boolean } = {},
): string {
  return [
    '<plan_thinking>',
    '你规划时当着用户把这个任务想清楚了，思考原文如下——用户已经看到，绝不要再复述一遍：',
    '<narration>',
    narration,
    '</narration>',
    '就按这份思考开工：它是你自己的判断，执行与汇报都要对得上它，不要另起炉灶重新规划。遇到与思考里假设不符的情况，直说假设哪里站不住了、你改怎么走。',
    opts.hasPlanCard
      ? ''
      : '没有结构化计划卡这回事，不要输出「## 计划 n：…」这类阶段标记——界面上没有卡片在等它们。',
    opts.projectBuild
      ? '这是项目级交付：完成必须给出真实验证证据（代码评审、类型检查、单测、构建任一适用的组合，失败要修到过）。'
      : '',
    '</plan_thinking>',
  ].filter(Boolean).join('\n');
}

/** 判定解析出的计划可用：有至少一步、每步有可读的动作或描述。 */
export function isUsablePlan(plan: Plan | null | undefined): plan is Plan {
  return Boolean(plan && Array.isArray(plan.steps) && plan.steps.length > 0
    && plan.steps.every((s) => (s.action ?? '').trim() || (s.description ?? '').trim()));
}
