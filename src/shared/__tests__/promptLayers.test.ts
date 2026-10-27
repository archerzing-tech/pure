// src/shared/__tests__/promptLayers.test.ts
// Covers the layered prompt architecture (L0 system core / L1 behavior
// contracts / L2 per-request user-turn composer).

import { describe, it, expect } from 'bun:test';
import {
  CHART_DSL_PROMPT,
  SYSTEM_CORE_PROMPT,
  WORKFLOW_PROMPT,
  COMPLETION_PROMPT,
  TYPO_TOLERANCE_PROMPT,
  LOGICAL_TRAPS_PROMPT,
  PLAUSIBILITY_REVIEW_PROMPT,
  SVG_OUTPUT_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  MAP_DSL_PROMPT,
  PAINT_DSL_PROMPT,
  detectVisualRequest,
  HUMAN_TONE_PROMPT,
  INSERTION_PROTOCOL_PROMPT,
  COMPLEX_TASK_PROTOCOL_PROMPT,
  FILE_TOOLS_CORE,
  CAPABILITY_GAP_PROMPT,
  CAPABILITY_GAP_CORE,
  CAPABILITY_GAP_LADDER,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_CORE,
  MULTI_AGENT_MECHANICS,
  PRE_COMMIT_REVIEW_CONTRACT,
  composeUserTurn,
  stripUserTurnContext,
  wantsCapabilityLadder,
  wantsDelegationMechanics,
  wantsHandsOnWorkflow,
} from '../promptLayers';
import { BUILT_IN_TOOL_DEFS } from '../toolDefs';
import { INCREMENTAL_BUILD_PROMPT, INFORMATION_VALUE_PRINCIPLE } from '../agentBehavior';
import { PromptAssembler, buildGuiCapabilities } from '../PromptAssembler';
import { estimatePromptTokens } from '../providers';

describe('SYSTEM_CORE_PROMPT (L0)', () => {
  it('carries the immutable identity + operating contract', () => {
    expect(SYSTEM_CORE_PROMPT).toContain('<agent_identity>');
    expect(SYSTEM_CORE_PROMPT).toContain('pure');
    expect(SYSTEM_CORE_PROMPT).toContain('<operating_principles>');
    // The reasoning phase plans the work — it is not a scratch draft of the
    // deliverable (drafting code in thinking doubled tokens and latency).
    expect(SYSTEM_CORE_PROMPT).toContain('Reason to plan, not to draft');
    expect(SYSTEM_CORE_PROMPT).toContain('never to write out the deliverable');
    expect(SYSTEM_CORE_PROMPT).toContain('<permission_modes>');
    expect(SYSTEM_CORE_PROMPT).toContain('<runtime>');
    expect(SYSTEM_CORE_PROMPT).toContain('<response_format>');
  });

  it('keeps the system core free of request-specific content', () => {
    expect(SYSTEM_CORE_PROMPT).not.toContain('web_search');
    expect(SYSTEM_CORE_PROMPT).not.toContain('read_file');
    expect(SYSTEM_CORE_PROMPT).not.toContain('## 阶段');
  });
});

describe('L1 behavior contracts', () => {
  it('carries the mid-run insertion protocol (v2 软暂停+九类消化，2026-10-27)', () => {
    // v2（docs/insertion-redesign-v2.md §八）：插话到达即被宿主软暂停押着
    // （hold on），宿主判完九类 relation 才放行——运行中的模型看到的是已判
    // 定、已放行的插话，按 relation 语义消化；旧版「自己先判影响面再选最小
    // 动作」的旁观框架随判定窗口一起作废。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('<insertion_protocol>');
    // 软暂停处境：押着时不许抢跑/预判，解除后按结论继续或转向。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('soft-pauses the run the moment one lands');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('already released and labeled by its relation');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('do not rush ahead or pre-empt the verdict');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('standing work keeps moving, the affected part turns or restarts');
    // 九类 relation 全部点名（对齐 inputDecision 九类契约），各带消化要点。
    for (const relation of ['supplement', 'emphasize', 'unrelated', 'question', 'meta', 'change', 'correction', 'mixed', 'misunderstanding']) {
      expect(INSERTION_PROTOCOL_PROMPT).toContain(`- ${relation} — `);
    }
    // 补充纳入不打断；无关绝不触碰主线且回告。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('Never restart anything for it');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('must not leak into the running work');
    // 改变：宿主已查状态定位影响（未开始拦截/进行中停清/已完成冻结+询问），
    // 模型只做最小重算；已取外部数据标记不用而非删除（§十.2 降级保留）。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('not-yet-started pieces are intercepted');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('frozen and the user asked');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('smallest rework');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('marked not-used-for-decisions');
    // 真暂停重入：带着用户上一句原话+纠偏输入重新开始，清掉的产出不是既成
    // 事实；旧方向实质产出同样触发（§七.1 双重触发）。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('TRUE pause');
    expect(INSERTION_PROTOCOL_PROMPT).toContain("restart from the user's original last message plus the corrective line");
    expect(INSERTION_PROTOCOL_PROMPT).toContain('not a fact you may build on');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('already substantively built the old way');
    // 方向变更保留未冲突条件；前提变更立即止损，不等跑完再补。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('does not contradict');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('instead of letting them finish and patching afterwards');
    // 无关插入进待办；多句/mixed 一批，不逐句抢跑。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('record it as a to-do');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('ONE batched decision');
    // 第 5 期「调度」批/分协议：跨回合攒下的同类小活并成一批，一次跑完一次
    // 汇报——不能一条小差事配一个小回合。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('several such unrelated pieces of the SAME kind pile up');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('one batch to run together once the turn ends');
    // 翻转只认最后明确意图，不执行中间态；不可逆旁先问，问不毁。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('LAST explicit statement');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('never execute a middle state');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('irreversible action');
    // 增强测试集（2026-09-24）补的两条：转向必须停掉在跑的执行资源并点名交代；
    // 两条互斥需求不得自行二选一——挂起等用户裁决，其余照常。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('stopping anything still running for it');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('cannot both hold');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('stopped, kept, or re-dispatched');
    // T22（2026-09-24）补的：用户说“错了算我的”也不能跳过不可逆确认——风险与被跳过的安全步骤（备份/演练）同行点名。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('takes the blame');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('safety step being skipped');
    // 回复样式：一句说清 变更项/保留项/影响面；无关的已完成工作绝不丢弃。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('what changed, what stays, what it affects');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('never thrown away');
    // 并行分支取消（2026-09-24 取消案例）：幸存分支照跑不中止，取消分支的
    // 部分产出不进合并，一句话交代取消与出结果的部分。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('named branch of parallel or delegated work cancelled mid-run');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('surviving branches keep running untouched');
    // 派出前取消（2026-09-26 用户反馈；§十.3 起飞闸判例保留）：计划当场缩，
    // 叙述只数会派的支并同一口气点名弃掉的方向——收执说"不派了"、计划书却
    // 照数三支是自相矛盾。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('cancelled before its delegation even exists');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('count what you will actually dispatch');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('never announce the dropped one as still on the list');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('stays out of the final merge');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('the merge covers the survivors only');
    // 指令词泄漏（2026-10-12 四问题③）：宿主注记（【】框架文/注入文）是执行
    // 指令不是措辞素材——模型照做，但面向用户的话用自己的话说，别把「产出
    // 并入最终汇总」这类调度腔复读成回复原文。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('orders to execute, not phrasing to reuse');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('never a sentence in your reply');
  });

  it('keeps the resident prompt within the slimming red line (2026-10-27: 9,978 × 105%)', () => {
    // 量入量出红线（v2 蓝图 §八）：协议改写不许让常驻段回涨。基线 = 纯常驻
    // （GUI 有工作区）9,978 tokens（cd26110 拍板值），本测试用与拍板时同款
    // 量法复现基线，锁住「改写后 ≤ 105%」。
    const assembler = new PromptAssembler();
    const prompt = assembler.buildSystemPrompt({
      surface: 'gui',
      capabilities: buildGuiCapabilities(true),
      hasSubagents: false,
    });
    expect(estimatePromptTokens(prompt)).toBeLessThanOrEqual(Math.ceil(9_978 * 1.05));
    // 协议在装配里恰好出现一次（防双份装配推高常驻量）。
    expect(prompt.split('<insertion_protocol>').length - 1).toBe(1);
  });

  it('carries the complex-task conduct protocol (2026-09-24 复杂任务案例集)', () => {
    // 10 例复杂任务案例集甄别后只固化四点真增量（其余点 tone/workflow/
    // delivery 契约已覆盖）：
    // ① 开场形状：一口气复述 + 2-4 条按假设推进（默认 + 错了坏哪），邀请纠正
    //    一次就开干，绝不问卷、绝不挂起等答案——值得问的问题也自带默认。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('<complex_task_protocol>');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('2–4 points you will proceed on BY ASSUMPTION');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('never send a questionnaire');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('never idle waiting for answers');
    // ② 承重假设加廉价护栏：失配要被检测、给清晰提示，绝不静默失败。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('fail loudly, never silently');
    // ② 之后·第 5 期「调度」批/分协议：能一块干的并成一批一次汇报，强依赖的
    //    拆 relay 链分步交接绝不硬凑；违背节奏地合/分要一句说清为什么。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('Batch what can be batched, split what must be split');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('never one announcement per little errand');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('relay chain');
    // ③ 失败表达全账：什么坏/为什么/修没修好/波及没有，且教训锁定防复发。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('whether anything else was touched');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('lock the lesson in');
    // ④ 不确定性不许包装成完成：mock/TODO/协议没给/必须用户亲手做的逐一点名留缝。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('named AS such in the hand-over');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('the seam you left for it');
    // ⑤ 收尾给裁决 + 效力边界（对哪成立、再扩要多少活）。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain("where the deliverable's validity ends");
    // ⑥ 期 3b·每步收尾一句实质：阶段真的落地时，模型自己的话要带两件事——
    // 现在多出来的是什么、拿什么验证的（真跑过的检查及其结果）；没验或验挂
    // 就当场直说，不得拿「努力过」当完成。事实账只是证据，不是可照抄的稿子。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('what now exists that did not before');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('the check you actually ran and what it reported');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('say that in the same breath');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('never as a script to recite');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).toContain('never repeat the phrasing you used for the previous stage');
    // 防八股：不得给模型一段可以原样复用的收尾句式（本期只规定实质，不新增模板）。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).not.toMatch(/say (exactly|verbatim)[: ]/i);
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).not.toMatch(/##\s*(完成总结|Completion Summary|完成报告)/);
    // 甄别否决项（负向锁）：固定产物名和结构化轨迹输出不得进协议——
    // 定死即八股，机器侧轨迹由运行时（活动卡/可重放日志）原生承担。
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).not.toContain('assumptions.md');
    expect(COMPLEX_TASK_PROTOCOL_PROMPT).not.toContain('UPGRADE.md');
  });

  it('gates the 7-step workflow behind hands-on requests (2026-10-27 闸门化)', () => {
    // 召回优先：动作词命中即带；纯问答特征且无动作词才免带；其余默认带。
    for (const hit of ['修一下这个 bug', '帮我实现一个导出功能', '装一下 ffmpeg', '把这个接口迁移到 v2', 'fix the failing test']) {
      expect(wantsHandsOnWorkflow(hit)).toBe(true);
    }
    for (const miss of ['这个函数是干什么的？', 'Promise 和 async/await 有什么区别？', '解释一下事件循环', '翻译这段报错']) {
      expect(wantsHandsOnWorkflow(miss)).toBe(false);
    }
    // build/plan 模式无条件带（复杂任务纪律不赌闸门）；未知措辞默认带。
    expect(wantsHandsOnWorkflow('随便聊聊', 'build')).toBe(true);
    expect(wantsHandsOnWorkflow('随便聊聊', 'plan')).toBe(true);
    expect(wantsHandsOnWorkflow('帮我看看这段代码有什么问题')).toBe(true);
    // 信息价值原则不随 workflow 闸门走：表达纪律在问答轮同样适用。
    expect(INFORMATION_VALUE_PRINCIPLE).toContain('信息价值优先原则');
    expect(WORKFLOW_PROMPT).not.toContain('信息价值优先原则');
  });

  it('re-exports the always-on workflow + completion contracts', () => {
    expect(WORKFLOW_PROMPT).toContain('Proactive problem-solving workflow');
    // Reuse-first: the model must check for an existing skill / MCP tool /
    // standard CLI before hand-rolling code (user feedback: it used to always
    // write bespoke code instead of reaching for a good skill or tool).
    expect(WORKFLOW_PROMPT).toContain('reusing or installing the right tool beats reimplementing it by hand');
    // Install-route ladder: a network failure is a route problem, not a dead
    // end (user feedback: npm blocked → declared "cannot install" and gave up
    // while the official docs offered several install methods).
    expect(WORKFLOW_PROMPT).toContain('ROUTE problem, not a dead end');
    // P2 — the model must consult session memory for procedures and error
    // lessons BEFORE starting work (self-evolution: recorded experience only
    // helps if the workflow contract tells the model to look at it up front).
    expect(WORKFLOW_PROMPT).toContain('check the <session_memory> block for a matching procedure');
    expect(COMPLETION_PROMPT).toContain('Completion report');
    expect(COMPLETION_PROMPT).toContain('依据');
    expect(COMPLETION_PROMPT).toContain('改动');
    expect(COMPLETION_PROMPT).toContain('验证');
    expect(COMPLETION_PROMPT).toContain('通过');
    expect(COMPLETION_PROMPT).toContain('不通过');
    expect(COMPLETION_PROMPT).toContain('实际运行的命令');
    // No fixed completion template: the report must read like a colleague,
    // not a labeled checklist. (The prompt may MENTION the banned heading in
    // its prohibition clause, but must not mandate the old heading+bullets
    // structure.)
    expect(COMPLETION_PROMPT).not.toContain('## 完成总结\n- ');
    expect(COMPLETION_PROMPT).not.toContain('**交付依据');
  });

  it('shares typo tolerance and logical-traps defense', () => {
    expect(TYPO_TOLERANCE_PROMPT).toContain('Smart typo tolerance');
    expect(LOGICAL_TRAPS_PROMPT).toContain('Logical traps & approach switching');
  });

  it('reviews answers against real-world geography/physics/chemistry/math/history', () => {
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Plausibility & real-world consistency review');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Geography');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Physics');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Chemistry');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('Math');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('History');
    // Route direction is a concrete case: waypoints must advance toward the goal.
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('西安→上海');
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('宝鸡/甘南');
    // Fiction / alternate-history requests opt out of the review.
    expect(PLAUSIBILITY_REVIEW_PROMPT).toContain('skip this review');
  });

  it('tells multi-image requests to emit one SVG per image (never a collage)', () => {
    expect(SVG_OUTPUT_PROMPT).toContain('MULTIPLE images');
    expect(SVG_OUTPUT_PROMPT).toContain('ONE separate fenced code block tagged svg PER image');
    expect(SVG_OUTPUT_PROMPT).toContain('NEVER combine several subjects into a single <svg>');
    expect(SVG_OUTPUT_PROMPT).toContain('NO prose between them');
  });

  it('bans saving picture files with write_file and non-svg code blocks', () => {
    // Root cause of the "画一只鸟 → 弹出一个 .svg 文件而不是聊天里渲染图片" bug:
    // the contract must cover SINGLE image requests too, and forbid the model
    // from writing the picture to disk (or emitting it as plain text / other
    // code-block languages) — the fenced svg block IS the deliverable.
    expect(SVG_OUTPUT_PROMPT).toContain('ANY image request');
    expect(SVG_OUTPUT_PROMPT).toContain('NEVER use write_file / edit_file to save the picture');
    expect(SVG_OUTPUT_PROMPT).toContain('must be tagged svg');
  });

  it('replaces the SVG contract with generate_image when the model supports text-to-image', () => {
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('generate_image(prompt, n?, size?)');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('创作一个小狗图标');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('NEVER emit fenced svg code blocks for image requests');
    // SVG stays as the automatic fallback when the tool fails / is unavailable.
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('fall back to svg code blocks');
  });

  it('never routes attached-image questions (what is this / describe it) to generate_image', () => {
    // Root cause of the "user pastes an image, asks what it is, and the agent
    // generates a NEW image" bug: every image contract stated only the positive
    // half ("image requests → generate_image"), so a question containing 图片
    // pattern-matched into generation. The negative half must be explicit.
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('only CREATES a new image from a text prompt');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('do NOT call generate_image');
    expect(IMAGE_GEN_OUTPUT_PROMPT).toContain('inspect the attachment and answer directly');
  });

  it('documents every chart family in the chart DSL and bans script-drawn charts', () => {
    expect(CHART_DSL_PROMPT).toContain('type:');
    expect(CHART_DSL_PROMPT).toContain('scatter');
    expect(CHART_DSL_PROMPT).toContain('kline');
    expect(CHART_DSL_PROMPT).toContain('radar');
    expect(CHART_DSL_PROMPT).toContain('treemap');
    expect(CHART_DSL_PROMPT).toContain('sunburst');
    expect(CHART_DSL_PROMPT).toContain('tree');
    // Charts/pictures are delivered as fenced blocks — never a script that draws them.
    expect(CHART_DSL_PROMPT).toContain('NEVER write a Python/matplotlib');
    expect(CHART_DSL_PROMPT).toContain('IS the deliverable');
  });

  it('keeps maps on the Leaflet JSON contract and never falls back to SVG', () => {
    // Root cause of the "map not rendering → model re-emits it as SVG" bug:
    // the SVG picture contract is prominent, so the model conflated maps with
    // SVG and "fixed" a broken map by switching formats. The map DSL must state
    // Leaflet explicitly and forbid SVG so the recovery path is a valid map block.
    expect(MAP_DSL_PROMPT).toContain('interactive Leaflet map');
    expect(MAP_DSL_PROMPT).toContain('A MAP IS NEVER SVG');
    expect(MAP_DSL_PROMPT).toContain('renders it with Leaflet, not SVG');
    expect(MAP_DSL_PROMPT).toContain('NEVER switch to SVG');
    expect(MAP_DSL_PROMPT).toContain('re-emitting a valid');
  });

  it('keeps paint on the declarative JSON contract and never on SVG or scripts', () => {
    // Static geometric illustration rides the same data-channel logic as
    // chart/map: pure's own canvas renderer draws the spec. The DSL must pin
    // the minimal JSON shape, forbid scripts/SVG (the two escape hatches the
    // model historically took), and route animation to the .html channel.
    expect(PAINT_DSL_PROMPT).toContain('"width"');
    expect(PAINT_DSL_PROMPT).toContain('"height"');
    expect(PAINT_DSL_PROMPT).toContain('"shapes"');
    expect(PAINT_DSL_PROMPT).toContain('A PAINT BLOCK IS NEVER SVG');
    expect(PAINT_DSL_PROMPT).toContain('IS the deliverable');
    expect(PAINT_DSL_PROMPT).toContain('complete standalone .html file');
  });

  it('routes geometric requests to paint without grabbing bare 画/图', () => {
    // Recall-first: these MUST arm the paint detail.
    for (const hit of ['画一张三层架构示意图', '来个几何插画', '画个登录图标', '画一个流程示意图', 'schematic of the layers']) {
      expect(detectVisualRequest(hit).paint).toBe(true);
    }
    // Bare 画/图 without a geometric keyword stays unrouted (看图/画一笔 等).
    for (const miss of ['帮我看看这张图', '画蛇添足是什么意思', '改一下标题', '总结这段话']) {
      expect(detectVisualRequest(miss).paint).toBe(false);
    }
  });

  it('arms the svg contract for picture requests with the 只 measure word (2026-10-27 判例)', () => {
    // 「画一只鸟」自 2026-10-14 起就 picture:false——量词表只有[张个幅副]，
    // 「只」缺位导致细则从未随请求装配（常驻指针兜底让测试伪绿）。量词表
    // 补「只」后锁死：动物量词是真实用户输入，漏了细则就缺席。
    for (const hit of ['画一只鸟', '画只小狗', '生成一张猫的图片', '生成一只卡通熊的图片']) {
      expect(detectVisualRequest(hit).picture).toBe(true);
    }
    // 「只」不吞几何让位词：示意图类仍由 paint 独占。
    expect(detectVisualRequest('画一只三层架构示意图').picture).toBe(false);
    expect(detectVisualRequest('画一只三层架构示意图').paint).toBe(true);
  });

  it('does NOT arm the svg contract for static-geometry requests (2026-10-17 case)', () => {
    // 「画一张三层架构示意图」armed both svg and paint details; the SVG
    // contract's wording is stronger and the model went SVG (real-machine
    // case). Geometric words are paint-exclusive now: the svg detail must
    // stay unarmed so paint is the only inline-drawing contract in context.
    for (const text of ['画一张三层架构示意图', '画个系统架构图，矩形加箭头', 'a schematic of the data flow', 'layered diagram of the stack']) {
      const wants = detectVisualRequest(text);
      expect(wants.paint, text).toBe(true);
      expect(wants.picture, text).toBe(false);
    }
    // Organic image requests keep the svg contract — 插画/图标 stay overlapped
    // on purpose (freehand shapes suit svg/generation better than paint).
    for (const text of ['画一张鸟的图', '生成一个图标', '画个头像插画']) {
      const wants = detectVisualRequest(text);
      expect(wants.picture, text).toBe(true);
    }
  });

  it('asks for a human, conversational tone without canned boilerplate', () => {
    expect(HUMAN_TONE_PROMPT).toContain('Communication tone');
    expect(HUMAN_TONE_PROMPT).toContain('senior engineer');
    expect(HUMAN_TONE_PROMPT).toContain('canned');
    expect(HUMAN_TONE_PROMPT).toContain('control lines');
  });

  it('reports finished work like a colleague, not a changelog', () => {
    expect(HUMAN_TONE_PROMPT).toContain('flowing sentences');
    expect(HUMAN_TONE_PROMPT).toContain('changelog-style list');
  });

  it('derives the resident cores and the on-demand details from one source', () => {
    // 大头①②（2026-10-14）：常驻核心与按需细则由同一个常量切片而来——改一处
    // 不可能只改半边，拼接回原文逐字相等就是这条不变式的锚。
    expect(CAPABILITY_GAP_CORE + CAPABILITY_GAP_LADDER).toBe(CAPABILITY_GAP_PROMPT);
    expect(CAPABILITY_GAP_CORE).toContain('never refuse, pretend to have it, or invent results');
    expect(CAPABILITY_GAP_CORE).toContain('~/.pure/skills/');
    expect(CAPABILITY_GAP_CORE).not.toContain('codeload.github.com');
    expect(CAPABILITY_GAP_LADDER).toContain('codeload.github.com');
    // 主动获取令（2026-10-16）在常驻核心：现成的都不合适 → 缺口是「去拿」的
    // 信号，不是交代局限的理由。中途缺口只能靠常驻令触达（回合中提示词冻结，
    // 闸门只看用户文本），所以工具名与「穷尽后才许说做不到」都必须在这一侧。
    expect(CAPABILITY_GAP_CORE).toContain('treat the missing capability as something to ACQUIRE');
    expect(CAPABILITY_GAP_CORE).toContain('whenever YOU discover the gap yourself');
    expect(CAPABILITY_GAP_CORE).toContain('install_agent_skill(source, name)');
    expect(CAPABILITY_GAP_CORE).toContain('only after the acquisition routes themselves have failed');
    expect(CAPABILITY_GAP_CORE).not.toContain('npx skills find');
    expect(CAPABILITY_GAP_LADDER).toContain('If nothing fits, INSTALL it yourself');
    const mechanicsStart = MULTI_AGENT_PROTOCOL.indexOf('Artifact fit: ');
    expect(mechanicsStart).toBeGreaterThan(0);
    expect(MULTI_AGENT_CORE.slice(0, mechanicsStart) + MULTI_AGENT_MECHANICS + MULTI_AGENT_CORE.slice(mechanicsStart))
      .toBe(MULTI_AGENT_PROTOCOL);
    expect(MULTI_AGENT_CORE).toContain('T3 · context isolation');
    expect(MULTI_AGENT_CORE).toContain('Exception (do NOT delegate)');
    expect(MULTI_AGENT_MECHANICS).toContain('Relay rule');
    // 闸门：普通请求不带细则，装东西/缺能力或多主题的请求带。
    expect(wantsCapabilityLadder('把 README 里的 typo 修一下')).toBe(false);
    expect(wantsCapabilityLadder('帮我装 ffmpeg')).toBe(true);
    expect(wantsDelegationMechanics('改一下标题', false)).toBe(false);
    expect(wantsDelegationMechanics('改一下标题', true)).toBe(true);
    expect(wantsDelegationMechanics('分别研究 A、B、C 三个方向', false)).toBe(true);
  });

  it('uses dynamic capability tools for skills and MCP services', () => {
    expect(CAPABILITY_GAP_PROMPT).toContain('search_agent_skills(query)');
    expect(CAPABILITY_GAP_PROMPT).toContain('install_agent_skill(source, name)');
    expect(CAPABILITY_GAP_PROMPT).toContain('search_mcp_servers(query)');
    expect(CAPABILITY_GAP_PROMPT).toContain('connect_mcp_server(candidateId)');
    expect(CAPABILITY_GAP_PROMPT).toContain('a specialist skill is one option');
    expect(CAPABILITY_GAP_PROMPT).toContain('official Registry recipe');
    // The transport-escalation ladder: a failed route is a diagnosis, and the
    // archive route must name the concrete codeload URL + placement target.
    expect(CAPABILITY_GAP_PROMPT).toContain('diagnosis, not a dead end');
    expect(CAPABILITY_GAP_PROMPT).toContain('codeload.github.com');
    expect(CAPABILITY_GAP_PROMPT).toContain('download_file');
    expect(CAPABILITY_GAP_PROMPT).toContain('~/.pure/skills/');
    // User-provided repos install without a search hit.
    expect(CAPABILITY_GAP_PROMPT).toContain('a GitHub repo the USER gave you');
    // Third-party software installs ride the same protocol: official docs
    // list several methods, and a blocked route falls down the mirror /
    // alternative-docs / direct-download ladder instead of ending in "无法安装".
    expect(CAPABILITY_GAP_PROMPT).toContain('INSTALL, set up, or upgrade a third-party tool');
    expect(CAPABILITY_GAP_PROMPT).toContain('registry.npmmirror.com');
    expect(CAPABILITY_GAP_PROMPT).toContain('GitHub releases');
  });

  // 3.4 pre-commit review: the quality gate that replaced the per-commit
  // permission prompt — the contract must name the trigger (git_commit), the
  // reviewer (code_reviewer), the verdict protocol, and the escape hatches.
  it('gates the first commit on a code_reviewer verdict with strict PASS/FAIL', () => {
    expect(PRE_COMMIT_REVIEW_CONTRACT.startsWith('<pre_commit_review>')).toBe(true);
    expect(PRE_COMMIT_REVIEW_CONTRACT.endsWith('</pre_commit_review>')).toBe(true);
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('git_commit');
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('code_reviewer');
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('VERDICT: PASS');
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('VERDICT: FAIL');
    // FAIL must actually gate; PASS/unavailable/trivial must not stall.
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('Never commit while a blocking finding stands');
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('trivial change');
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('reviewer unavailable');
    // One review per task — follow-up commits are not re-reviewed.
    expect(PRE_COMMIT_REVIEW_CONTRACT).toContain('once per task');
  });

  it('documents the git write tools via their schema descriptions (2026-10-27 下沉)', () => {
    // git 工具的散文清单已从 FILE_TOOLS_CORE 下沉到 schema description——
    // pre_commit_review 的跨引用锚现在住在 git_commit 的 description 里。
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'git_commit')?.description).toContain('pre-commit review contract');
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'git_branch')?.description).toBeTruthy();
  });
});

describe('composeUserTurn (L2)', () => {
  it('returns the text unchanged with no fragments', () => {
    expect(composeUserTurn('hello')).toBe('hello');
    expect(composeUserTurn('hello', {})).toBe('hello');
  });

  it('wraps each provided fragment in <task_context> before the request', () => {
    const out = composeUserTurn('build me a game', {
      traps: '<trap>contradiction</trap>',
      buildProtocol: '<build>protocol</build>',
    });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<trap>contradiction</trap>');
    expect(out).toContain('<build>protocol</build>');
    expect(out.endsWith('build me a game')).toBe(true);
    expect(out.indexOf('<trap>')).toBeLessThan(out.indexOf('<build>'));
    expect(out.indexOf('<build>')).toBeLessThan(out.indexOf('build me a game'));
    expect(out.indexOf('</task_context>')).toBeLessThan(out.indexOf('build me a game'));
  });

  it('includes the approved-plan fragment when present', () => {
    const out = composeUserTurn('proceed', { plan: '## Execution plan\n1. Do' });
    expect(out).toContain('## Execution plan\n1. Do');
    expect(out.endsWith('proceed')).toBe(true);
  });

  it('includes clarifying answers as hard constraints before the request', () => {
    const out = composeUserTurn('build it', { clarifications: '<user_clarifications>平台：Web</user_clarifications>' });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<user_clarifications>平台：Web</user_clarifications>');
    expect(out.endsWith('build it')).toBe(true);
  });

  it('includes the delivery contract beside the approved task context', () => {
    const out = composeUserTurn('build it', { contract: '<delivery_contract>tests are required</delivery_contract>' });
    expect(out).toContain('<delivery_contract>tests are required</delivery_contract>');
    expect(out.endsWith('build it')).toBe(true);
  });

  it('includes the proactive intent assessment beside the request', () => {
    const out = composeUserTurn('delete it', { assessment: '<intent_assessment>high risk</intent_assessment>' });
    expect(out).toContain('<intent_assessment>high risk</intent_assessment>');
    expect(out.endsWith('delete it')).toBe(true);
  });

  it('includes the plausibility-review override beside the request', () => {
    const out = composeUserTurn('写一个架空的故事', { plausibilityOverride: '<plausibility_review_override>skip</plausibility_review_override>' });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<plausibility_review_override>skip</plausibility_review_override>');
    expect(out.endsWith('写一个架空的故事')).toBe(true);
  });

  it('ignores empty fragments', () => {
    expect(composeUserTurn('x', { traps: '', buildProtocol: undefined, plan: '' })).toBe('x');
  });
});

describe('stripUserTurnContext (replay round-trip)', () => {
  it('strips the <task_context> block leaving the user text', () => {
    const composed = composeUserTurn('build me a game', { traps: '<trap>x</trap>' });
    expect(stripUserTurnContext(composed)).toBe('build me a game');
  });

  it('returns plain text unchanged', () => {
    expect(stripUserTurnContext('just a normal question')).toBe('just a normal question');
    expect(stripUserTurnContext('')).toBe('');
  });

  it('round-trips a multi-fragment turn exactly', () => {
    const text = '  带空格的请求  ';
    const composed = composeUserTurn(text, {
      traps: 'a',
      buildProtocol: 'b',
      plan: '## Execution plan',
    });
    expect(stripUserTurnContext(composed)).toBe(text);
  });

  it('does not strip when the closing tag is missing (malformed)', () => {
    expect(stripUserTurnContext('<task_context>broken')).toBe('<task_context>broken');
  });
});

describe('FILE_TOOLS_CORE (L1 shared tool list)', () => {
  it('lists the full file + shell/git tool set', () => {
    // 2026-10-27 瘦身：逐工具散文下沉 schema，FILE_TOOLS_CORE 只留跨工具策略。
    expect(FILE_TOOLS_CORE).toContain('File tool strategy');
    expect(FILE_TOOLS_CORE).toContain('find_files FIRST');
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'read_file')?.description).toContain('startLine');
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'replace_files')).toBeTruthy();
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'git_status')).toBeTruthy();
  });

  it('teaches the serve-and-preview decision: static file vs web server', () => {
    // The "启动服务打开页面" protocol: the model must pick the right vehicle
    // instead of faking a preview or letting a server time out. 现同时钉在
    // FILE_TOOLS_CORE（策略段）与 execute_command schema（下沉承接）两处。
    expect(FILE_TOOLS_CORE).toContain('a single self-contained .html');
    expect(FILE_TOOLS_CORE).toContain('MUST go through http://localhost');
    expect(FILE_TOOLS_CORE).toContain('never fake a preview with file://');
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'execute_command')?.description).toContain('background:true');
  });
});

describe('INCREMENTAL_BUILD_PROMPT (humanized build reporting)', () => {
  it('uses natural step headings and plain-language reports, not labeled What/How sections', () => {
    expect(INCREMENTAL_BUILD_PROMPT).toContain('## 第 n 步');
    // The old internal four-label report (做了什么/怎么做/结果/验证) is banned
    // — the model must write flowing sentences instead.
    expect(INCREMENTAL_BUILD_PROMPT).toContain('做了什么 / 怎么做 / 结果 / 验证');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('flowing sentences');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('**做了什么 / What**');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('**怎么做 / How**');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('live plan card can reflect optional progress markers');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('overall plan context separate from any optional progress list');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('For other complex work');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('choose and state a test strategy before implementation');
    // NEW TASK RULE: a fresh user request after a finished plan restarts
    // numbering instead of appending "计划6" to the old plan's stages.
    expect(INCREMENTAL_BUILD_PROMPT).toContain('NEW TASK RULE');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('restart heading numbers');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('create the project test entry');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('at least one focused smoke/unit/integration test');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('happy-dom');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('manual click-through is not an automated test');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('meaningful protection');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('dedicated test step');
    expect(INCREMENTAL_BUILD_PROMPT).not.toContain('at least three rounds');
    expect(INCREMENTAL_BUILD_PROMPT).toContain('concrete failing checks and evidence');
  });
});
