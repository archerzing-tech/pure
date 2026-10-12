// src/ui/planNarration.ts
// 计划必须是当着用户想出来的（2026-09-26 用户定调，彻底替换「本地规则出卡」）：
// 出计划卡之前，模型先流式地把思考讲给用户听——思考的形状完全由模型自己定，
// 不给模板、不给提纲——讲完从同一条回复末尾解析出它自己愿意承诺的步骤清单。
// 这里只放纯函数：提示词拼装、思考/计划分流、流式展示裁剪、无卡时的执行指引。
// 编排（流式、超时、中止、气泡）在 chat.ts 的 planByThinking()。

import type { Plan, PlanVerificationSpec } from '../coding-agent/types';
import type { WorkOrderRegister } from '../character';

const PLAN_JSON_SHAPE = `{"reasoning": "why this plan, one short paragraph", "steps": [{"action": "imperative, short", "description": "what this step concretely does for THIS task", "expectedOutcome": "what exists or is verified when the step is done", "substeps": [{"action": "...", "description": "...", "expectedOutcome": "..."}], "todosRequired": false}], "verification": [{"command": "the exact command", "reason": "why running this proves the changes", "final": false}]}`;

/**
 * 规划思考的提示词。刻意的克制：不规定思考的提纲、顺序、段数——一旦规定，
 * 就又回到「固定模式」。只规定实质约束：用用户的语言、以自己的口吻想清楚、
 * 假设要明说并直接往下走（不许停下来等答案）、不许复述请求、不许套话、
 * 思考结束以 ```json 围栏交出自己承诺的步骤、步骤必须被上面的思考挣出来。
 *
 * 刀 6 分量判读：`register` 是宿主从用户措辞判出的分量档位。production 不带
 * 任何档位句（现行为原样）；draft/spike 换步数词、换交付标准——判轻了给快，
 * 判重了照旧，误差方向安全。
 */
export function buildPlanThinkingPrompt(
  userText: string,
  opts: { projectBuild?: boolean; hasImages?: boolean; register?: WorkOrderRegister } = {},
): { system: string; user: string } {
  const register = opts.register ?? 'production';
  const stepAsk = register === 'draft'
    ? 'Give 1-3 steps — the user asked for something quick to react to (a draft, a few versions to choose from): speed of iteration beats completeness.'
    : register === 'spike'
      ? 'Give 2-5 steps — this is a throwaway prototype/spike: walking the main path end to end IS the deliverable.'
      : 'Give 2-6 steps.';
  const registerBrief = register === 'draft'
    ? 'Register: DRAFT. Treat the output as a decision aid the user will react to, not a finished deliverable. Skip long verification loops and exhaustive polish; say what you skipped.'
    : register === 'spike'
      ? 'Register: SPIKE. Prove the approach works end to end on the main path; skip production polish, edge-case hardening and full verification. Say what you skipped.'
      : '';
  const system = [
    'You are taking on this task yourself. Before doing anything, think it through in front of the user — in the user\'s language, as yourself.',
    'There is no required outline. Think the way a sharp colleague thinks out loud before committing to an approach, and let THIS task decide what needs saying: what the request hinges on, which constraints shape the work, what you assume about anything left unsaid (state the assumption and proceed — never stall on questions here), how you intend to approach it and why, and anything the user would want to veto before you start. Skip whatever does not deserve the words.',
    'Never pad, never repeat the request back verbatim, never open with ritual phrases, never end with "let me know if this looks good" — the plan below is the handoff.',
    'When the thinking is done, commit to the plan: a ```json fenced block, and nothing after it.',
    'The thinking itself must be plain spoken prose in the user\'s language — never raw JSON, never a bare JSON object; the only JSON allowed in the entire reply is that final ```json fence.',
    PLAN_JSON_SHAPE,
    `${stepAsk} Every step must be earned by your thinking above — concrete to this task, never generic filler like "explore the workspace" or "gather requirements". Use "todosRequired": false only for a step that genuinely needs no Todo list.`,
    registerBrief,
    opts.projectBuild
      ? (register === 'production'
        ? 'This is a project-level build: the LAST step must be the delivery verification pipeline (run the checks, fix failures, re-run until ALL pass). Alongside "steps", declare a "verification" list tailored to THIS round\'s changes — the exact commands that prove the work (typecheck / lint / tests / build as applicable), each with a one-line reason why running it is enough. Mark "final": true on the entries that must form the end-of-turn mechanical gate; keep the rest lean so they can re-run on every change during the loop. Don\'t just list the project\'s full pipeline because it exists — declare what this round needs.'
        : 'This is a project-level build at light register: declare a small "verification" list that proves the MAIN PATH runs (one or two commands at most). Do NOT run the full delivery pipeline; do not mark anything "final": true — there is no end-of-turn gate at this register. Name in your thinking what the light pass leaves unverified.')
      : '',
  ].filter(Boolean).join('\n');
  const user = opts.hasImages
    ? `${userText}\n\n(Images are attached; take them into account.)`
    : userText;
  return { system, user };
}

/**
 * 裸 JSON 兜底识别：整条回复没有围栏、直接以计划 JSON 开场——弱模型的常见
 * 姿势（2026-10-11 真机：nemotron 把整段思考写成 {"reasoning":…,"steps":…}
 * 裸吐上屏）。认两条硬记号：以 { 开头 + 同时含 "reasoning" 与 "steps" 两个
 * schema 键；正常散文叙述不可能同时踩中，误伤面收得非常窄。
 */
export function isBarePlanJson(text: string): boolean {
  const t = text.trimStart();
  if (!t.startsWith('{')) return false;
  return t.includes('"reasoning"') && t.includes('"steps"');
}

/**
 * 把一条完整回复拆成「思考叙述」与「计划 JSON 原文」。计划围栏按约定在回复
 * 末尾，所以认最后一次出现的 ``` 开栏：叙述里 legitimately 出现过代码示例时
 * 不会被它截断。没有围栏 → planText 为空；只有开栏没闭合 → 取开栏之后全部
 * （交 parsePlanJsonWithMeta 的修复通道碰运气）。无围栏但整条回复是裸计划
 * JSON 的退化形态 → 整段转交解析通道、叙述留空（气泡不落屏，计划卡照出），
 * 不让 JSON 以「叙述」的名义原样上屏。
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
  if (open < 0) {
    if (isBarePlanJson(full)) return { narration: '', planText: full.trim() };
    return { narration: full, planText: '' };
  }
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
  opts: { projectBuild?: boolean; hasPlanCard?: boolean; verification?: PlanVerificationSpec[]; register?: WorkOrderRegister } = {},
): string {
  // 刀 1.1：清单在执行语境里的两种身份——整份是迭代环的最小验证集（改动后
  // 就地重跑适用的，别攒到最后）；final 子集是收尾宿主机械重跑的闸门清单
  // （不过闸不许交付）。没有声明清单时退回通用表述。
  const declared = (opts.verification ?? []).filter((item) => item.command);
  const finalSet = declared.some((item) => item.final === true)
    ? declared.filter((item) => item.final === true)
    : declared;
  // 刀 6：分量档位执行段。production 一字不加（现行为原样）；draft/spike 带两
  // 句——诚实义务（轻做≠装完，跳过什么要明说）与交付标记教学（产物卡靠模型
  // 报路径，工具收集面之外的产物也照卡送达）。教学只进轻档：正式档有完整的
  // 交付管线与闸门，不需要模型自报家门。
  const register = opts.register ?? 'production';
  const registerSection = register === 'production' ? '' : [
    register === 'draft'
      ? '分量档位：草稿。这份活要么是给用户快速决策用的，要么产物本身就是轻东西（演示文稿、设计稿这类做完就能看的东西）——轻做不等于装完：没验的、跳过的、粗糙的地方，收尾说明里一样样明说，不许把草稿当成品交。'
      : '分量档位：原型穿刺。这份活是验证可行性的——主路径端到端走通即为达标，边缘加固与生产级打磨明确跳过；同样，跳过了什么在收尾说明里明说。',
    '每份产物完成后，在回复末尾单独输出一行「## 产物已就绪：<路径>」（相对路径，一份一行）——界面据此直接把产物卡送到用户面前，不需要用户自己翻目录找。',
  ].join('\n');
  // projectBuild 段按档位分叉：production 有宿主机械重跑的收尾闸（照旧）；
  // 轻档的闸已在宿主侧关闭（needsDeliveryGate=false），语境里不能再宣称有闸
  // ——声明的最小清单就是全部验证，说有闸就是说谎。
  const projectBuildSection = !opts.projectBuild
    ? ''
    : register !== 'production'
      ? (declared.length > 0
        ? `轻档项目交付：跑你声明的最小验证（${declared.map((item) => item.command).join('、')}）证明主路径能跑，跳过全量管线；宿主不设收尾闸，这份清单就是全部验证。`
        : '轻档项目交付：证明主路径能跑（启动、构建或演示任一适用的组合），跳过全量管线；宿主不设收尾闸。')
      : (declared.length > 0
        ? `这是项目级交付：完成必须给出真实验证证据（失败要修到过）。你声明的验证清单：${declared.map((item) => item.command).join('、')}——迭代中每次改动后就地重跑适用的命令，别攒到最后才发现坏了；收尾时宿主会机械重跑最终验证（${finalSet.map((item) => item.command).join('、')}），那道闸不解析你的任何声称，过不了就不交付。`
        : '这是项目级交付：完成必须给出真实验证证据（代码评审、类型检查、单测、构建任一适用的组合，失败要修到过）。');
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
    projectBuildSection,
    registerSection,
    '</plan_thinking>',
  ].filter(Boolean).join('\n');
}

/** 判定解析出的计划可用：有至少一步、每步有可读的动作或描述。 */
export function isUsablePlan(plan: Plan | null | undefined): plan is Plan {
  return Boolean(plan && Array.isArray(plan.steps) && plan.steps.length > 0
    && plan.steps.every((s) => (s.action ?? '').trim() || (s.description ?? '').trim()));
}
