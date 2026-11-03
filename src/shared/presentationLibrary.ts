/**
 * 表现形式库（presentation capability library）— 语义描述层。
 *
 * 设计定调（2026-11-02，docs/presentation-capability-library.md）：把「模型能用
 * 哪些视觉形式交付、各适合什么、失败长什么样」收编成结构化卡片，模型经
 * presentation_guide 工具按需拉取；常驻只留 VISUAL_BLOCK_POINTER 的最小语法
 * 兜底 + 一句发现指针。展现是 push 型输出语法（模型写进回复、前端识别渲染），
 * 不是工具调用——所以发现机制复制 discover_tools 的「目录只在被搜索时进对话」
 * 模式，而不是把它做成 deferred 工具。
 *
 * 两层分界：本文件 = 语义描述层（给模型的判据与契约）；能力支撑层 = markdown
 * 渲染管线（src/ui/markdown.ts 围栏分流）+ parseRepair 校验修复 +
 * transcriptProjection 回放 + cliDiagram 降级。卡片的 detail 字段直接引用
 * promptLayers 的既有 DSL 常量（单源，禁止复制——契约测试有同引用断言防分叉）。
 */

import {
  CHART_DSL_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  MAP_DSL_PROMPT,
  PAINT_DSL_PROMPT,
  SVG_OUTPUT_PROMPT,
} from './promptLayers';

/** 一张表现形式卡：模型可见的完整契约（判据 + 语法 + 失败行为）。 */
export interface PresentationCard {
  /** 唯一 id，同触发语法主名（'mermaid' | 'chart' | …）。 */
  id: string;
  /** 族名；模型可用族名一次拉全族。 */
  family: string;
  /** 一行标题。 */
  title: string;
  /** 接受的别名（'plantuml' → puml 卡等）。 */
  aliases?: readonly string[];
  /** 触发语法（围栏名 / 行内标记）——模型产出侧的契约。 */
  trigger: string;
  /** 该卡对应的围栏 tag 全集（小写、含别名；非围栏形式如 image_gen/table
   *  无此字段）。与 src/ui/markdown.ts 的 FENCE_ROUTES 双向同源（测试锁死）
   *  ——加新围栏形式一处注册：卡 + 路由条目，漏任何一侧测试即红。 */
  fence?: readonly string[];
  /** 何时该用（判据正面）。 */
  whenToUse: string;
  /** 何时别用 / 用什么替代（判据负面 + 互斥判例）。为空是设计错误：
   * 只说好处的卡会催生过度可视化。 */
  whenNotToUse: string;
  /** 交付纪律与失败行为：渲染失败时用户看到什么、该怎么修正。 */
  delivery: string;
  /** 详情全文（DSL 细则）。仅允许引用既有常量，不复制文本。 */
  detail?: string;
  /** 各宿主面的呈现与降级（声明式，给人读）。 */
  surfaces: string;
  /** 刀 4 机器可读降级接口：无图形表面（CLI/渠道 text 模式）时这个形式
   *  降级成什么。'wireframe' = ASCII 线框（cliDiagram）；'projection' = 文本
   *  投影（formProjections）；缺省 = 'text'（源码/原文直出）。与 surfaces
   *  文本、FORM_PROJECTIONS 注册表三方同源（测试锁死）；自定义卡继承 base。 */
  textFallback?: 'wireframe' | 'projection' | 'text';
}

/** 首批卡片：全部来自既有实现（零新渲染器）。detail 引用 promptLayers 单源。
 * 2026-11-02 增补：routing 决策卡（形式跟着用途走——版面 vs 拓扑、一次性
 * vs 长期演进、读者与规模；2026-11-02 三层架构图会话的用户问答定调），放
 * 目录首位——先决策，再拉胜出形式的卡。
 * 2026-11-02 真机二修（session_1793600755798_1）：「图进 docs」请求没拉卡、
 * 把形式选择降维成「SVG 文件 vs PNG」并用 write_file 落盘，破了围栏铁律。
 * 修法：①文件从选项空间里显式除名（第 0 步）——「进 repo」判据选的是
 * mermaid 围栏这个源码式形式，不是文件；②拉卡触发词从主观 unsure（自信时
 * 不触发）换成客观场景（请求提到图的归宿/读者时，正是形式竞争时）。 */
export const PRESENTATION_CARDS: readonly PresentationCard[] = [
  {
    id: 'routing',
    family: 'meta',
    title: 'How to choose between forms',
    aliases: ['choose', 'decision'],
    trigger: 'A decision card - no fence of its own; it routes between the other cards',
    whenToUse:
      'Before producing any visual when two or more forms could fit - pull this first, decide, then pull the winning form\'s card for its exact syntax. Pull it whenever the request mentions WHERE the visual will live (docs, slides, README, chat) or WHO will read it - that is exactly when forms compete, whether or not you feel unsure.',
    whenNotToUse:
      'Never emit anything FROM this card itself - it routes, it does not render. When the form is obvious from the content (numbers -> chart, places -> map, formulas -> math), skip it and go straight to that card.',
    delivery:
      'Nothing renders from this card - it ends in a choice. Go read the chosen form\'s card next; if a previous block failed to render, the last step below applies.',
    detail:
      'Decision path, in order - stop at the first match:\n' +
      '0. Fence first, file second. The in-chat delivery is ALWAYS a fenced block (mermaid/paint/svg) - a file alone shows up as raw code or an artifact card, never as the picture, and it cannot be fixed by re-emitting. When the request names a destination (docs/README/slides/repo), deliver BOTH in the same turn: emit the fenced block first (it renders in the chat and is the authoritative version), then save the block\'s SOURCE to the named destination - the request naming a destination IS the authorization to save there (pick a sensible filename, no need to ask). Mermaid text preferred for repo evolution. "Docs/slides/README" picks WHICH fenced form (step 3) - never file-over-fence.\n' +
      '1. Content check: numbers/comparison -> chart. Real-world places/routes -> map. Math -> math. Exact multi-column figures -> table. Photo-like artwork -> image_gen (or svg as fallback). Structure/diagram -> continue below.\n' +
      '2. For structure, what is the diagram\'s center of gravity?\n' +
      '   - TOPOLOGY (who calls whom, message order, state transitions - the edges carry the meaning) -> mermaid: automatic layout, adding or editing a node is one line of source.\n' +
      '   - LAYOUT (layer boundaries, side-by-side grouping inside a tier, spatial metaphor, poster-like one-glance flow - the arrangement itself carries the meaning) -> paint (precise geometry) or svg (organic shapes): explicit coordinates, the layout IS the semantic.\n' +
      '3. What is this diagram\'s life?\n' +
      '   - One-shot, for humans in THIS conversation -> layout control wins (paint/svg): the 3-second read is designed on purpose, not delegated to a layout engine.\n' +
      '   - Living in the repo, evolving with the code, reviewed and diffed -> source-form wins (mermaid): editing is a line change, not re-laying-out a pile of x/y coordinates - and still a fenced block in the chat first, never a file (step 0).\n' +
      '4. Who reads it? Non-technical audience, explained once -> minimal layout (big tier names + one-line duty per tier, few components). Engineers / formal documents -> full component anatomy; either form works, pick by steps 2-3.\n' +
      '5. Size check: over ~30 nodes or deep nesting -> let automatic layout take over (mermaid); hand-laying that many coordinates tires out and drifts.\n' +
      '6. Failure rule unchanged: if a block failed to render, fix it in the SAME form (a map is never re-emitted as SVG, and so on) - switching forms mid-retry hides the real error.',
    surfaces: 'meta: no rendering anywhere - this card only routes',
  },
  {
    id: 'mermaid',
    fence: ['mermaid'],
    family: 'diagram',
    title: 'Mermaid structural diagram',
    trigger: 'Fenced block tagged mermaid',
    whenToUse:
      'Structural relationships: flows with decisions (flowchart), message exchanges over time (sequence), class hierarchies / state machines / entity relations, schedules (gantt), composition shares (pie), idea hierarchies (mindmap), event lines (timeline), actors & use cases (usecase-beta). Default structural form unless the content clearly fits another card below. If the diagram will live in the repo and evolve with the code, mermaid also wins over hand-laid coordinates - source-diffable, layout-free edits.',
    whenNotToUse:
      'Not for numeric comparisons (use a chart card), not for real-world routes or places (use the map card), not for precise geometric layouts (the paint card controls rectangles/arrows/groups better), not for photo-like artwork (svg / generate_image).',
    delivery:
      'Renders inline as an SVG diagram. On a parse failure a repair pass retries once, then an error card with a retry button appears - fix by re-emitting the block with corrected syntax (quote node labels containing special characters; ASCII node ids only for usecase-beta).',
    detail:
      'Choosing the mermaid type: process with branches -> flowchart; who-says-what-to-whom over time -> sequence; code structure -> class / state / ER; time-planned work -> gantt; share-of-total -> pie (use a chart card when exact values matter); ideas radiating from a center -> mindmap; milestones over time -> timeline; actors and use cases -> usecase-beta (ASCII node ids only). Keep diagrams under ~30 nodes - deeper structures read better as a paint layout or a table.',
    surfaces: 'gui: inline SVG diagram | cli: ASCII wireframe | channel: source text',
    textFallback: 'wireframe',
  },
  {
    id: 'puml',
    fence: ['puml', 'plantuml'],
    family: 'diagram',
    title: 'PlantUML diagram',
    aliases: ['plantuml'],
    trigger: 'Fenced block tagged puml (or plantuml)',
    whenToUse: 'PlantUML strengths only: component, deployment, and activity diagrams.',
    whenNotToUse:
      'Everything else has a mermaid equivalent - mermaid is the default structural form; reach for puml only when its notation genuinely fits better.',
    delivery:
      'Renders via the local PlantUML engine (offline, 30s timeout); failure shows an error card with retry.',
    surfaces: 'gui: inline diagram | cli: ASCII wireframe | channel: source text',
    textFallback: 'wireframe',
  },
  {
    id: 'chart',
    fence: ['chart', 'charts'],
    family: 'data-viz',
    title: 'Data chart (echarts)',
    aliases: ['charts', 'echarts'],
    trigger: 'Fenced block tagged chart: a type: line, optional title:/unit:, then label value rows',
    whenToUse:
      'Numeric data as a visual: comparisons (bar/hbar), trends (line), composition (pie), correlations (scatter), price action (kline), multi-axis profiles (radar), hierarchies with values (tree/treemap/sunburst).',
    whenNotToUse:
      'When the reader needs the exact numbers, prefer a GFM table (or give both: chart for shape, table for figures). Not for geography (map card), not for non-numeric structure (mermaid).',
    delivery:
      'Renders inline as an interactive echarts chart. Parse failures / empty data show an error card with retry. The type: line DSL is the primary contract; a JSON payload is also accepted for every type.',
    detail: CHART_DSL_PROMPT,
    surfaces: 'gui: inline echarts chart | cli & channel: text projection (ASCII bars for bar/hbar/pie; other types keep the readable rows)',
    textFallback: 'projection',
  },
  {
    id: 'map',
    fence: ['map', 'leaflet'],
    family: 'geo',
    title: 'Interactive map (Leaflet)',
    trigger: 'Fenced block tagged map containing ONE JSON payload',
    whenToUse: 'Real-world geography: routes, route planning, directions, places, itineraries.',
    whenNotToUse:
      'Never for abstract/imaginary geography or network topologies (mermaid/paint job). A MAP IS NEVER SVG - never render a map/route/place as an svg block or an image.',
    delivery:
      'Renders inline as an interactive Leaflet map (markers + route polyline). Malformed JSON shows the only error card WITHOUT a retry button - re-emit the whole block with valid JSON; wrong coordinates show an on-map warning bar. Use REAL coordinates; look them up (web_search) when unsure.',
    detail: MAP_DSL_PROMPT,
    surfaces: 'gui: interactive Leaflet map | cli & channel: text projection (marker/route list)',
    textFallback: 'projection',
  },
  {
    id: 'svg',
    fence: ['svg'],
    family: 'illustration',
    title: 'Hand-drawn SVG picture',
    trigger: 'Fenced block tagged svg (one standalone <svg> document per block)',
    whenToUse:
      'Hand-drawn organic artwork, icons, logos, illustrations, multiple variations or A/B options - anything where you want to control every path yourself.',
    whenNotToUse:
      'Geometric architecture/flow schematics fit the paint card better (layout primitives, arrows, groups); photo-real images fit generate_image when available; NEVER a map/route (a map is never SVG).',
    delivery:
      'Renders inline full-width; consecutive blocks group into a side-by-side grid (no prose between blocks). Broken SVG gets one repair pass, then an error card with retry.',
    detail: SVG_OUTPUT_PROMPT,
    surfaces: 'gui: inline picture / grid | cli & channel: source text',
  },
  {
    id: 'paint',
    fence: ['paint'],
    family: 'illustration',
    title: 'Static geometric illustration (paint JSON)',
    trigger: 'Fenced block tagged paint containing ONE JSON object (shapes/defs)',
    whenToUse:
      'Static geometric illustration: architecture sketches, flow schematics, layered diagrams, geometry, icons - when you want precise layout control (rect/circle/line/arrow/path/polygon/text/group, gradients).',
    whenNotToUse:
      'Organic artwork / photo-like images -> svg or generate_image; animation, generative art, interactive drawings -> a standalone .html file with <canvas>; data charts -> chart card. A diagram destined for the repo (docs that evolve with code) reads better as mermaid - hand-laid coordinates are expensive to maintain.',
    delivery:
      'Renders inline as a static canvas drawing (deterministic - no random values). Parse failures (e.g. empty shapes) show an error card with retry - re-emit valid paint JSON, NEVER switch to SVG.',
    detail: PAINT_DSL_PROMPT,
    surfaces: 'gui: inline canvas drawing | cli & channel: text projection (shape list)',
    textFallback: 'projection',
  },
  {
    id: 'image_gen',
    family: 'media',
    title: 'Generated image (generate_image tool)',
    aliases: ['generate_image', 'imagegen'],
    trigger: 'The generate_image(prompt, n?, size?) tool call - only when the connected provider supports text-to-image',
    whenToUse:
      'Creating NEW photo-like images, icons, posters, illustrations; n > 1 for variations instead of repeated calls.',
    whenNotToUse:
      'Never for describing/analyzing an attached image (answer from the attachment directly); while the tool is unavailable or just failed, fall back to svg blocks instead.',
    delivery:
      'Renders as real picture cards. On provider failure fall back to svg blocks so the user still gets a picture.',
    detail: IMAGE_GEN_OUTPUT_PROMPT,
    surfaces: 'gui: picture cards | cli & channel: saved file card',
  },
  {
    id: 'math',
    fence: ['math', 'latex', 'tex'],
    family: 'formula',
    title: 'Math notation (KaTeX)',
    aliases: ['latex', 'tex', 'formula', 'katex'],
    trigger: 'Inline $...$ ; display block $$...$$ or \\[...\\] ; or a fenced block tagged math/latex/tex',
    whenToUse: 'Mathematical notation, formulas, equations - inline symbols inside prose or display equations.',
    whenNotToUse:
      "Don't wrap plain numbers/prices in $...$ (a $ immediately followed by a digit stays literal - the price guard keeps money readable); \\(...\\) inline parentheses are NOT supported; formulas containing CJK characters render as literal text.",
    delivery:
      'Renders via KaTeX with throwOnError disabled - a malformed formula falls back to the original escaped text (never an error card). A fenced math/latex/tex block renders the whole block as display math.',
    surfaces: 'gui: KaTeX | cli & channel: literal text',
  },
  {
    id: 'table',
    family: 'document',
    title: 'Markdown table (GFM)',
    trigger: 'Standard GFM table: pipe header row, --- separator row, then data rows',
    whenToUse:
      'Exact multi-column figures and comparisons: metrics per item, inventories, side-by-side options, anything the reader may copy or scan cell by cell.',
    whenNotToUse:
      'Deep nesting or workflows (lists / mermaid read better); trend or shape-over-time questions (a chart card shows it better); when a single sentence suffices, no table.',
    delivery:
      'Renders as a styled table - pure markdown, cannot fail; broken pipe syntax just shows as plain text.',
    surfaces: 'gui: styled table | cli & channel: text',
  },
  {
    id: 'image',
    family: 'media',
    title: 'Embedded image file',
    aliases: ['img'],
    trigger: 'Markdown image syntax ![alt](path-or-url) - local absolute paths are served via asset:// automatically',
    whenToUse:
      'Embedding an existing image file from disk or the web into the reply - screenshots, downloaded figures, files just produced by save_file_binary.',
    whenNotToUse:
      'Never as a substitute for an inline visual form: a chart/map/picture you can express as a fenced block MUST be the fenced block - writing it as a file shows raw code, not the picture.',
    delivery:
      'Renders inline with double-click zoom; dangerous schemes (javascript:/file:) are stripped down to the alt text.',
    surfaces: 'gui: inline image | cli & channel: path/link',
  },
  {
    id: 'fold',
    family: 'document',
    title: 'Collapsible detail card',
    aliases: ['details', 'collapse'],
    trigger: '<details><summary>...</summary> ... </details> block in the reply',
    whenToUse: 'Long appendices, full logs, secondary detail that would bury the main answer.',
    whenNotToUse:
      'Never hide the conclusion, the verdict, or anything the user explicitly asked for - folds are for optional depth only.',
    delivery: 'Renders as a collapsible card; the content inside is regular markdown.',
    surfaces: 'gui: collapsible card | cli & channel: text',
  },
];

/** 族清单（目录索引用）：id + family + 一行触发语法。 */
export const PRESENTATION_FAMILIES: readonly string[] = [
  ...new Set(PRESENTATION_CARDS.map((card) => card.family)),
];

// ── 刀 3 组合式自定义（docs/presentation-capability-library.md）──
// 自定义卡 = 现有原语 + 参数封装：基础形式（base）提供渲染通道与缺省判据，
// 用户/agent 只写想改的字段。零新渲染器——fence 走 base 的围栏路由（前端
// registerCustomFenceRoutes 把新 tag 挂到 base kind 的通道上）。注册表真实
// 源在盘上 config.json 的 presentationCards 键（设置 agent 化铁律：agent 可
// 语义操作、用户可直接改文件），这里只是运行时视图。

/** 自定义卡的输入形态（config.json presentationCards 数组的元素）。除 id/base
 *  外全部可选——缺省字段继承 base 卡（组合式封装的本意：只写想改的）。 */
export interface CustomCardInput {
  /** 唯一 id，`[a-z][a-z0-9-]*`，不得撞内置卡 id 或别名。 */
  id: string;
  /** 基础形式 id（必须是内置围栏卡之一）：渲染通道与缺省判据的来源。 */
  base: string;
  title?: string;
  aliases?: string[];
  trigger?: string;
  whenToUse?: string;
  whenNotToUse?: string;
  delivery?: string;
  detail?: string;
  surfaces?: string;
  /** 自定义围栏 tag（小写 ASCII，不得撞内置 tag）。缺省 = 直接复用 base 的
   *  围栏语法——卡只定制判据，产出语法与 base 完全一致。 */
  fence?: string[];
}

export interface CustomCardRejection {
  id: string;
  reason: string;
}

/** 运行时自定义卡（注册顺序即目录序，排在内置卡之后）。 */
let customCards: PresentationCard[] = [];

/** 内置 + 自定义的合并视图（自定义在后）。全库检索/目录/匹配都走这里。 */
export function allPresentationCards(): PresentationCard[] {
  return [...PRESENTATION_CARDS, ...customCards];
}

/** 注册自定义卡（幂等：同 id 重复注册 = 更新）。返回被拒清单及原因——
 *  拒绝是逐卡的：坏一张不影响其余注册成功。 */
export function registerCustomCards(inputs: readonly CustomCardInput[]): {
  registered: string[];
  rejected: CustomCardRejection[];
} {
  const registered: string[] = [];
  const rejected: CustomCardRejection[] = [];
  const takenTags = new Set(FENCE_IDS);
  const takenNames = new Set<string>([
    ...PRESENTATION_CARDS.flatMap((card) => [card.id, ...(card.aliases ?? [])]),
    ...customCards.flatMap((card) => [card.id, ...(card.aliases ?? [])]),
  ]);
  for (const input of inputs ?? []) {
    const reason = validateCustomCard(input, takenNames, takenTags);
    if (reason) {
      rejected.push({ id: input?.id ?? '(missing id)', reason });
      continue;
    }
    const baseCard = PRESENTATION_CARDS.find((card) => card.id === input.base)!;
    // 组合式封装：缺省字段继承 base；新 fence tag 时 trigger 改写成自定义语法。
    const card: PresentationCard = {
      id: input.id,
      fence: input.fence ?? baseCard.fence,
      family: baseCard.family,
      title: input.title ?? `${baseCard.title} (custom)`,
      aliases: input.aliases,
      trigger:
        input.trigger ??
        (input.fence
          ? `Fenced block tagged ${input.fence.join(' / ')} (rendered on the ${input.base} pipeline)`
          : baseCard.trigger),
      whenToUse: input.whenToUse ?? baseCard.whenToUse,
      whenNotToUse: input.whenNotToUse ?? baseCard.whenNotToUse,
      delivery: input.delivery ?? baseCard.delivery,
      detail: input.detail ?? baseCard.detail,
      surfaces: input.surfaces ?? baseCard.surfaces,
      textFallback: baseCard.textFallback, // 机器可读降级跟 base 管线走，不随 surfaces 文案变
    };
    // 同 id 更新：先摘旧卡再放新卡，别名/tag 占位同步刷新。
    customCards = customCards.filter((existing) => existing.id !== input.id);
    customCards.push(card);
    takenNames.add(input.id);
    for (const alias of input.aliases ?? []) takenNames.add(alias);
    for (const tag of input.fence ?? []) takenTags.add(tag);
    registered.push(input.id);
  }
  return { registered, rejected };
}

/** 测试/重置用：清空运行时自定义卡。 */
export function resetCustomCards(): void {
  customCards = [];
}

function validateCustomCard(
  input: CustomCardInput | undefined,
  takenNames: Set<string>,
  takenTags: Set<string>,
): string | null {
  if (!input || typeof input !== 'object') return 'entry is not an object';
  if (!/^[a-z][a-z0-9-]*$/.test(input.id ?? '')) {
    return `id "${input.id}" must match [a-z][a-z0-9-]*`;
  }
  if (!input.base || !FENCE_IDS.includes(input.base)) {
    return `base "${input.base}" is not a built-in fence form (${FENCE_IDS.join(', ')})`;
  }
  if (takenNames.has(input.id) && !customCards.some((card) => card.id === input.id)) {
    return `id "${input.id}" collides with a built-in card id or alias`;
  }
  for (const alias of input.aliases ?? []) {
    if (takenNames.has(alias)) {
      return `alias "${alias}" collides with an existing card id or alias`;
    }
  }
  for (const tag of input.fence ?? []) {
    if (!/^[a-z]+$/.test(tag)) return `fence tag "${tag}" must be lowercase ASCII letters`;
    if (takenTags.has(tag)) return `fence tag "${tag}" is already a built-in or registered tag`;
  }
  return null;
}

/** 内置围栏卡 id（校验与 markdown 注册共用）。 */
const FENCE_IDS = ['mermaid', 'puml', 'chart', 'map', 'svg', 'paint', 'math'];

/** form 参数 → 卡片：精确 id → 别名 → 族名 → 单 token 子串容错。空数组 = 未命中。 */
export function matchPresentationCards(form: string): PresentationCard[] {
  const q = (form ?? '').trim().toLowerCase();
  if (!q) return [];
  const cards = allPresentationCards();
  const byId = cards.filter((card) => card.id === q);
  if (byId.length > 0) return byId;
  const byAlias = cards.filter((card) => card.aliases?.includes(q));
  if (byAlias.length > 0) return byAlias;
  const byFamily = cards.filter((card) => card.family === q);
  if (byFamily.length > 0) return byFamily;
  if (/\s/.test(q)) return [];
  return cards.filter(
    (card) => card.id.includes(q) || q.includes(card.id),
  );
}

/** 目录索引文本（form 省略 / 零命中时返回——目录只在被搜索时进对话）。 */
export function renderPresentationCatalog(): string {
  const lines = allPresentationCards().map(
    (card) => `- ${card.id} (${card.family}) — ${card.trigger}`,
  );
  return [
    'Presentation forms you can deliver INSIDE the reply (id - family - trigger):',
    ...lines,
    'Call again with form:"<id>" (or a family name) for the full card: when to use it, when NOT to, failure behavior, and the exact DSL rules.',
    'Custom forms live in ~/.pure/config.json under "presentationCards" ({ id, base, ...fields you want to override }) - register one by writing that key: desktop sessions hot-reload it every turn (the NEXT message can already pull it and use its fence), fresh CLI sessions pick it up on start.',
  ].join('\n');
}

/** 单卡全文文本（工具返回体的渲染形态）。 */
export function renderPresentationCard(card: PresentationCard): string {
  const parts = [
    `── ${card.id} (${card.family}) — ${card.title} ──`,
    `Trigger: ${card.trigger}`,
    `Use when: ${card.whenToUse}`,
    `Avoid when: ${card.whenNotToUse}`,
    `Delivery & failure: ${card.delivery}`,
  ];
  if (card.detail) parts.push(card.detail);
  parts.push(`Surfaces: ${card.surfaces}`);
  return parts.join('\n');
}
