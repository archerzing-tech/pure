// src/shared/__tests__/promptLayers.test.ts
// Covers the layered prompt architecture (L0 system core / L1 behavior
// contracts / L2 per-request user-turn composer).

import { describe, it, expect } from 'bun:test';
import {
  CHART_DSL_PROMPT,
  SYSTEM_CORE_PROMPT,
  WORKFLOW_PROMPT,
  COMPLETION_PROMPT,
  SVG_OUTPUT_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  MAP_DSL_PROMPT,
  PAINT_DSL_PROMPT,
  ROUTING_ESSENTIALS,
  VISUAL_BLOCK_POINTER,
  detectVisualRequest,
  HUMAN_TONE_PROMPT,
  INSERTION_PROTOCOL_PROMPT,
  CAPABILITY_GAP_PROMPT,
  CAPABILITY_GAP_LADDER,
  MULTI_AGENT_MECHANICS_PROMPT,
  composeUserTurn,
  stripUserTurnContext,
  wantsCapabilityLadder,
  wantsDelegationMechanics,
  wantsHandsOnWorkflow,
} from '../promptLayers';
import { BUILT_IN_TOOL_DEFS } from '../toolDefs';
import { DYNAMIC_CAPABILITY_TOOL_DEFS } from '../dynamicCapabilityTools';
import { PRESENTATION_CARDS } from '../presentationLibrary';
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
  it('carries the mid-run insertion protocol as a thin pointer (2026-10-28 刀 3)', () => {
    // 框架改革刀 3（docs/framework-reform-2026-10.md）：6.5k 的逐场景长协议
    // 瘦成 632 字符薄指针——逐场景教导下放进四个标注块（随插话现场到达），
    // 常驻层只留四条纪律内核：认块按块内指令配合、点名具体的事禁模板句、
    // 停支归宿主、幸存者合并照常。推倒重来块随真暂停链退役（D 刀），块名
    // 同步摘除。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('<insertion_protocol>');
    // 四类标注块名一一在场（模型靠它们认块，标注块文本在 insertionMessaging
    // 与宿主投递侧，一致性测试各锁各的）。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【用户插话·顺路带上】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【排队中的用户消息·现在轮到它】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【中途取消，不是追加】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('【中途追加的任务】');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('follow the instructions inside each block');
    // 点名具体的事禁模板句：能在任何会话里成立的回复按构就是错的。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('name the concrete thing it touches in THIS conversation');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('wrong by construction');
    // 停支归宿主：宿主停或暂停，模型永不动手停。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('the host stops or pauses that branch');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('stopping it is never your move');
    // 幸存者合并：幸存照常，被收方向不进结果。
    expect(INSERTION_PROTOCOL_PROMPT).toContain('the merge covers the survivors only');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('The cancelled direction stays out of the final result');
    expect(INSERTION_PROTOCOL_PROMPT).toContain('surviving work carries on');
    // 薄指针不再背逐场景长文：旧的九类清单、调度批/分、收尾样式等教导已
    // 下放（现仍在的移去了复杂任务协议/标注块/裁决器提示词），不得回流——
    // 回流即常驻段回涨，违背瘦身红线。
    expect(INSERTION_PROTOCOL_PROMPT).not.toContain('supplement —');
    expect(INSERTION_PROTOCOL_PROMPT).not.toContain('one batch to run together');
    expect(INSERTION_PROTOCOL_PROMPT).not.toContain('what changed, what stays, what it affects');
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

  it('phase-2 retirements: typo/traps/plausibility blocks are gone, the core sentence rides with workflow', () => {
    // 框架改革二期（docs/framework-reform-2026-11.md）：typo 容错 / 逻辑陷阱
    // / 可信度审查三段常驻块退役——现代模型已内化这些行为，唯一可机械校验的
    // 一句（交付前对现实约束做健全性检查）并入 workflow 第 6 条（同为 verify
    // 主题），其余不许回流常驻段。
    const prompt = new PromptAssembler().buildSystemPrompt({
      surface: 'gui',
      capabilities: buildGuiCapabilities(true),
      hasSubagents: false,
    });
    expect(prompt).not.toContain('Smart typo tolerance');
    expect(prompt).not.toContain('Logical traps & approach switching');
    expect(prompt).not.toContain('Plausibility & real-world consistency review');
    expect(WORKFLOW_PROMPT).toContain('sanity-check it against basic real-world constraints');
    expect(WORKFLOW_PROMPT).toContain('a route must advance toward its destination');
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
    // 直观目标（2026-10-29 用户定调）：能图表呈现的一定落成对应图表，
    // 是交付形态的硬要求，不是省文字的风格偏好。
    expect(INFORMATION_VALUE_PRINCIPLE).toContain('一定要落成对应的图表');
    expect(INFORMATION_VALUE_PRINCIPLE).toContain('硬要求');
    expect(INFORMATION_VALUE_PRINCIPLE).toContain('```chart');
    expect(INFORMATION_VALUE_PRINCIPLE).toContain('mermaid');
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
    // Charts render inline as fenced blocks — the direct path; a script also
    // works if its output file is referenced inline (2026-11-03 裁禁令：
    // asset:// 通道本就能内联脚本产图，交付判据取代 NEVER 禁令).
    expect(CHART_DSL_PROMPT).toContain('the direct path');
    expect(CHART_DSL_PROMPT).toContain('referenced inline as ![desc](/absolute/path.png)');
    expect(CHART_DSL_PROMPT).not.toContain('NEVER write a Python');
    // 人类读图判据（2026-11-03 真机判例：7 天天气趋势被画成柱状图——随附层
    // DSL 只有 type 枚举+default bar，判据不在场时模型盲选）：选型判据必须
    // 随 DSL 在场，趋势→折线是铁锚。
    expect(CHART_DSL_PROMPT).toContain('change over time / forecast / trend -> line');
    expect(CHART_DSL_PROMPT).toContain('not across bars');
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

  it('arms the destination gate only for real destination semantics (2026-11-02 真机判例)', () => {
    // 归宿词 = 动词+归宿地组合或演进语义；裸「文档」不单独命中——「帮我看看
    // 文档」是阅读请求不是图归宿。误判代价 ~750 字符精要，漏判代价是判据
    // 缺席（两轮真机判例：自信模型不拉卡，改卡是空转）。
    for (const hit of [
      '我需要一张架构图，放进 docs/ 里',
      '画一张流程图存到项目文档目录',
      '把这张图放进 README 里',
      '生成部署图归档到仓库',
      '画一张流程图，要跟随代码演进经常更新',
      '架构图长期维护',
      'a layered diagram to keep in the repo',
      'diagram for the docs, evolving with the code',
    ]) {
      expect(detectVisualRequest(hit).destination, hit).toBe(true);
    }
    for (const miss of ['帮我看看文档', '总结这段文档内容', '画一张三层架构示意图', '把这些数据做成柱状图']) {
      expect(detectVisualRequest(miss).destination, miss).toBe(false);
    }
  });

  it('pins the routing essentials contract (mechanical injection, 2026-11-02 第三刀)', () => {
    // 劝导对没拉卡的模型是空转：归宿词命中时精要机械注入（装配断言在
    // PromptAssembler.test.ts），这里锁文本契约——双交付纪律 + 判轴 + 发现
    // 指针，全 ASCII（sidecar 锚纪律），铁律锚与 routing 卡共享（同锚断言
    // 在 presentationLibrary.test.ts）。
    expect(ROUTING_ESSENTIALS).toContain('DOUBLE DELIVERY');
    expect(ROUTING_ESSENTIALS).toContain('never file-over-fence');
    expect(ROUTING_ESSENTIALS).toContain('who-calls-whom topology');
    expect(ROUTING_ESSENTIALS).toContain('presentation_guide form:"routing"');
    expect(/^[\x20-\x7E\n]*$/.test(ROUTING_ESSENTIALS)).toBe(true);
  });

  it('points the resident visual pointer at presentation_guide (2026-11-02 表现形式库)', () => {
    // 刀 5 瘦身（2026-11-03）：常驻指针只剩 tag 枚举 + 交付判据 + 发现指针，
    // 五段最小语法斩掉（完整 DSL 与卡 detail 同源、闸门随附三面通用、beta
    // 清单搬卡）。同日差距分析①：落盘/脚本 NEVER 禁令裁掉——asset:// 通道
    // 本就能内联脚本产图，改交付判据（可见性底线 + 内联引用机制）。
    // 保留性锚 + 负锚（语法段/禁令复活即红）+ 长度上限。
    expect(VISUAL_BLOCK_POINTER).toContain('VISIBLE inside the reply');
    expect(VISUAL_BLOCK_POINTER).toContain('A fenced block IS the picture');
    expect(VISUAL_BLOCK_POINTER).toContain('![desc](/absolute/path.png)');
    expect(VISUAL_BLOCK_POINTER).not.toContain('NEVER save');
    expect(VISUAL_BLOCK_POINTER).not.toContain('NEVER draw');
    expect(VISUAL_BLOCK_POINTER).toContain('presentation_guide');
    expect(VISUAL_BLOCK_POINTER).toContain('unsure which form fits');
    // tag 枚举仍在（模型必须知道存在哪些形式）。
    expect(VISUAL_BLOCK_POINTER).toContain('Fence tags: svg');
    // 私有 DSL 的发现指针升格：语法不在场先拉卡。
    expect(VISUAL_BLOCK_POINTER).toContain('before emitting chart/map/paint blocks');
    // 负锚：五段语法段不得复活（每段曾是独立一行最小语法）。
    expect(VISUAL_BLOCK_POINTER).not.toContain('label value');
    expect(VISUAL_BLOCK_POINTER).not.toContain('{title, center');
    expect(VISUAL_BLOCK_POINTER).not.toContain('shapes:[rect');
    expect(VISUAL_BLOCK_POINTER).not.toContain('standalone <svg> document');
    expect(VISUAL_BLOCK_POINTER).not.toContain('usecase-beta');
    // 瘦身目标 ≈600 字符；上限锚防语法段悄悄长回来。
    expect(VISUAL_BLOCK_POINTER.length).toBeLessThan(900);
  });

  it('moves the mermaid beta catalog onto the card (刀 5 前置搬卡)', () => {
    // *-beta 启用清单是常驻段曾有、卡上原本没有的信息——斩常驻前先搬家，
    // 否则是纯信息丢失。锚在 mermaid 卡 detail。
    const card = PRESENTATION_CARDS.find((c) => c.id === 'mermaid');
    expect(card?.detail).toContain('Enabled experimental *-beta types: architecture, radar, kanban, sankey, xychart, quadrantChart');
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

  it('keeps the capability ladder as an on-demand slice and the delegation mechanics on their gate', () => {
    // 大头①切片派生不变式（2026-10-14）：梯子仍是 CAPABILITY_GAP_PROMPT 的
    // 尾段切片——改一处不可能只改半边。
    expect(CAPABILITY_GAP_PROMPT.includes(CAPABILITY_GAP_LADDER)).toBe(true);
    expect(CAPABILITY_GAP_LADDER.startsWith('\n- If nothing fits, INSTALL it yourself')).toBe(true);
    // 主动获取令（2026-10-16 → 二期改载体）：从常驻核心搬进 search_agent_skills
    // 的工具描述——缺口出现在模型考虑找工具的那一刻，描述恰在眼前，比常驻段
    // 更近的触发位；常驻协议本体只留「把缺口当获取信号」一句托底。
    const skillsSearch = DYNAMIC_CAPABILITY_TOOL_DEFS.find((t) => t.name === 'search_agent_skills')?.description ?? '';
    expect(skillsSearch).toContain('a capability gap is a signal to ACQUIRE');
    expect(skillsSearch).toContain('only after the acquisition routes themselves have failed');
    expect(CAPABILITY_GAP_PROMPT).toContain('treat the missing capability as something to ACQUIRE');
    // 大头②（二期重构）：委派触发测试（何时拆）随 task_planner 的工具描述走
    // （锁在其定义文件旁），机制段只教「怎么委派」，不再背触发测试与例外条。
    expect(MULTI_AGENT_MECHANICS_PROMPT).toContain('Artifact fit');
    expect(MULTI_AGENT_MECHANICS_PROMPT).toContain('Fan-out rule');
    expect(MULTI_AGENT_MECHANICS_PROMPT).toContain('Relay rule');
    expect(MULTI_AGENT_MECHANICS_PROMPT).toContain('Orchestrator conduct');
    expect(MULTI_AGENT_MECHANICS_PROMPT).not.toContain('T1');
    expect(MULTI_AGENT_MECHANICS_PROMPT).not.toContain('Exception (do NOT delegate)');
    // 闸门：普通请求不带细则，装东西/缺能力或多主题的请求带。
    expect(wantsCapabilityLadder('把 README 里的 typo 修一下')).toBe(false);
    expect(wantsCapabilityLadder('帮我装 ffmpeg')).toBe(true);
    expect(wantsDelegationMechanics('改一下标题', false)).toBe(false);
    expect(wantsDelegationMechanics('改一下标题', true)).toBe(true);
    expect(wantsDelegationMechanics('分别研究 A、B、C 三个方向', false)).toBe(true);
    // 2026-11-02 体量拆路增补：素材量大/盘点类请求也开闸（fan-out 规则同步补体量触发，
    // 对齐 Claude Code「量检测→拆路并行→只收结论」编排形态）。
    expect(MULTI_AGENT_MECHANICS_PROMPT).toContain('flood the main session');
    expect(wantsDelegationMechanics('把这批历史文档盘点一遍', false)).toBe(true);
    expect(wantsDelegationMechanics('通读所有文档写一份摘要', false)).toBe(true);
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
  // permission prompt — phase 2 moved the contract into git_commit's own
  // description: the rule is about THAT one tool call, so it lives where the
  // model looks when making it, not in an always-on block.
  it('gates the first commit on a code_reviewer verdict via the git_commit description', () => {
    const gitCommit = BUILT_IN_TOOL_DEFS.find((t) => t.name === 'git_commit')?.description ?? '';
    expect(gitCommit).toContain('code_reviewer');
    expect(gitCommit).toContain('VERDICT: PASS / FAIL');
    // FAIL must actually gate; PASS/unavailable/trivial must not stall.
    expect(gitCommit).toContain('fix every blocking finding before committing');
    expect(gitCommit).toContain('trivial change');
    expect(gitCommit).toContain('reviewer unavailable');
    // One review per task — follow-up commits are not re-reviewed.
    expect(gitCommit).toContain('Review once per task');
  });

  it('documents the git write tools via their schema descriptions (2026-10-27 下沉)', () => {
    // git 工具的散文清单已下沉 schema description——pre-commit review 的
    // 跨引用锚现住在 git_commit 的 description 里（二期后它是唯一载体）。
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'git_commit')?.description).toContain('Pre-commit review (automatic');
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
      envFacts: '<env>facts</env>',
      buildProtocol: '<build>protocol</build>',
    });
    expect(out.startsWith('<task_context>')).toBe(true);
    expect(out).toContain('<env>facts</env>');
    expect(out).toContain('<build>protocol</build>');
    expect(out.endsWith('build me a game')).toBe(true);
    expect(out.indexOf('<env>')).toBeLessThan(out.indexOf('<build>'));
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

  it('ignores empty fragments', () => {
    expect(composeUserTurn('x', { envFacts: '', buildProtocol: undefined, plan: '' })).toBe('x');
  });
});

describe('stripUserTurnContext (replay round-trip)', () => {
  it('strips the <task_context> block leaving the user text', () => {
    const composed = composeUserTurn('build me a game', { envFacts: '<env>x</env>' });
    expect(stripUserTurnContext(composed)).toBe('build me a game');
  });

  it('returns plain text unchanged', () => {
    expect(stripUserTurnContext('just a normal question')).toBe('just a normal question');
    expect(stripUserTurnContext('')).toBe('');
  });

  it('round-trips a multi-fragment turn exactly', () => {
    const text = '  带空格的请求  ';
    const composed = composeUserTurn(text, {
      envFacts: 'a',
      buildProtocol: 'b',
      plan: '## Execution plan',
    });
    expect(stripUserTurnContext(composed)).toBe(text);
  });

  it('does not strip when the closing tag is missing (malformed)', () => {
    expect(stripUserTurnContext('<task_context>broken')).toBe('<task_context>broken');
  });
});

describe('file & shell tool descriptions (framework-reform phase 2 carrier)', () => {
  // FILE_TOOLS_CORE 常驻段随二期退役：跨工具策略改住各工具自己的描述——
  // 教学跟着工具走，模型调工具前必读，两个 surface 不再重复维护一份散文。
  const desc = (name: string) => BUILT_IN_TOOL_DEFS.find((t) => t.name === name)?.description ?? '';

  it('carries the read/find discipline: locate first, read ranges, never paste whole files', () => {
    expect(desc('read_file')).toContain('Never paste a whole file into the conversation');
    expect(desc('read_file')).toContain('startLine');
    expect(desc('find_files')).toContain('Use this FIRST');
    expect(desc('find_files')).toContain('follow those suggestions instead of guessing');
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'replace_files')).toBeTruthy();
    expect(BUILT_IN_TOOL_DEFS.find((t) => t.name === 'git_status')).toBeTruthy();
  });

  it('carries the write + shell discipline: split big output, quiet flags, no re-read verification', () => {
    expect(desc('write_file')).toContain('split it by concern');
    expect(desc('execute_command')).toContain('Token discipline');
    expect(desc('execute_command')).toContain('do NOT re-read the whole file to verify');
  });

  it('teaches the serve-and-preview decision: static file vs web server', () => {
    // The "启动服务打开页面" protocol: the model must pick the right vehicle
    // instead of faking a preview or letting a server time out.
    expect(desc('execute_command')).toContain('a single self-contained .html');
    expect(desc('execute_command')).toContain('MUST go through http://localhost');
    expect(desc('execute_command')).toContain('never fake a preview with file://');
    expect(desc('execute_command')).toContain('background:true');
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
