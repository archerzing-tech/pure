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
  /** 何时该用（判据正面）。 */
  whenToUse: string;
  /** 何时别用 / 用什么替代（判据负面 + 互斥判例）。为空是设计错误：
   * 只说好处的卡会催生过度可视化。 */
  whenNotToUse: string;
  /** 交付纪律与失败行为：渲染失败时用户看到什么、该怎么修正。 */
  delivery: string;
  /** 详情全文（DSL 细则）。仅允许引用既有常量，不复制文本。 */
  detail?: string;
  /** 各宿主面的呈现与降级（声明式，MVP 不做机器路由）。 */
  surfaces: string;
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
  },
  {
    id: 'puml',
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
  },
  {
    id: 'chart',
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
    surfaces: 'gui: inline echarts chart | cli & channel: source text',
  },
  {
    id: 'map',
    family: 'geo',
    title: 'Interactive map (Leaflet)',
    trigger: 'Fenced block tagged map containing ONE JSON payload',
    whenToUse: 'Real-world geography: routes, route planning, directions, places, itineraries.',
    whenNotToUse:
      'Never for abstract/imaginary geography or network topologies (mermaid/paint job). A MAP IS NEVER SVG - never render a map/route/place as an svg block or an image.',
    delivery:
      'Renders inline as an interactive Leaflet map (markers + route polyline). Malformed JSON shows the only error card WITHOUT a retry button - re-emit the whole block with valid JSON; wrong coordinates show an on-map warning bar. Use REAL coordinates; look them up (web_search) when unsure.',
    detail: MAP_DSL_PROMPT,
    surfaces: 'gui: interactive Leaflet map | cli & channel: source JSON',
  },
  {
    id: 'svg',
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
    surfaces: 'gui: inline canvas drawing | cli & channel: source JSON',
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

/** form 参数 → 卡片：精确 id → 别名 → 族名 → 单 token 子串容错。空数组 = 未命中。 */
export function matchPresentationCards(form: string): PresentationCard[] {
  const q = (form ?? '').trim().toLowerCase();
  if (!q) return [];
  const byId = PRESENTATION_CARDS.filter((card) => card.id === q);
  if (byId.length > 0) return byId;
  const byAlias = PRESENTATION_CARDS.filter((card) => card.aliases?.includes(q));
  if (byAlias.length > 0) return byAlias;
  const byFamily = PRESENTATION_CARDS.filter((card) => card.family === q);
  if (byFamily.length > 0) return byFamily;
  if (/\s/.test(q)) return [];
  return PRESENTATION_CARDS.filter(
    (card) => card.id.includes(q) || q.includes(card.id),
  );
}

/** 目录索引文本（form 省略 / 零命中时返回——目录只在被搜索时进对话）。 */
export function renderPresentationCatalog(): string {
  const lines = PRESENTATION_CARDS.map(
    (card) => `- ${card.id} (${card.family}) — ${card.trigger}`,
  );
  return [
    'Presentation forms you can deliver INSIDE the reply (id - family - trigger):',
    ...lines,
    'Call again with form:"<id>" (or a family name) for the full card: when to use it, when NOT to, failure behavior, and the exact DSL rules.',
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
