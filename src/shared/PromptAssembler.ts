import {
  estimatePromptTokens,
  estimateToolDefinitionTokens,
  resolvePromptBudget,
  type PromptBudgetConfig,
  type ResolvedPromptBudget,
} from './providers';
import type { ToolDefinition } from './types';
import { promptObservability, promptVersion, type PromptObservability } from './promptObservability';
import {
  CAPABILITY_GAP_PROMPT,
  CHART_DSL_PROMPT,
  COMPLETION_PROMPT,
  FILE_TOOLS_CORE,
  HUMAN_TONE_PROMPT,
  IMAGE_GEN_OUTPUT_PROMPT,
  LOGICAL_TRAPS_PROMPT,
  SVG_OUTPUT_PROMPT,
  SYSTEM_CORE_PROMPT,
  TYPO_TOLERANCE_PROMPT,
  WORKFLOW_PROMPT,
  composeUserTurn,
  type UserTurnContext,
} from './promptLayers';

export type PromptSurface = 'gui' | 'cli';
export type PromptTaskMode = 'yolo' | 'plan' | 'build';
export type { PromptBudgetConfig, ResolvedPromptBudget } from './providers';

export interface PromptSkill {
  name: string;
  body: string;
  enabled?: boolean;
}

export interface PromptAssemblyContext {
  surface: PromptSurface;
  capabilities: string;
  /** Definitions sent in the provider's separate tools payload. They are
   * counted by the compiler but are not duplicated into the system text. */
  toolDefinitions?: ToolDefinition[];
  /**
   * True when the connected provider exposes text-to-image (generate_image).
   * Swaps the SVG output contract for the image-generation contract: image
   * requests must call the tool instead of emitting ```svg blocks (SVG
   * remains the automatic fallback when the tool is unavailable or fails).
   */
  imageGeneration?: boolean;
  environment?: string;
  runtimes?: string;
  skills?: PromptSkill[];
  mode?: PromptTaskMode;
  budget?: PromptBudgetConfig;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
}

export interface PromptFragment {
  id: string;
  content: string;
  priority: number;
  required?: boolean;
}

export interface PromptBudgetReport extends ResolvedPromptBudget {
  estimatedInputTokens: number;
  estimatedToolTokens: number;
  includedFragmentIds: string[];
  omittedFragmentIds: string[];
  overBudget: boolean;
}

export interface PromptAssembly {
  systemPrompt: string;
  userPrompt?: string;
  budget: PromptBudgetReport;
  traceId: string;
}

/** Human-readable diagnostic for observability surfaces (CLI logs/UI telemetry). */
export function formatPromptBudgetDiagnostic(report: PromptBudgetReport): string | undefined {
  if (!report.overBudget && report.omittedFragmentIds.length === 0) return undefined;
  const omitted = report.omittedFragmentIds.length > 0
    ? ` omitted=${report.omittedFragmentIds.join(',')}`
    : '';
  return `[prompt-budget] estimated=${report.estimatedInputTokens} available=${report.availableInputTokens} toolSchemas=${report.estimatedToolTokens}${omitted}`;
}

export interface PromptMemoryContext {
  preferences: string[];
  errorPatterns: string[];
  /** v1.9.7 — verified successful patterns, injected with priority so proven approaches are preferred over unproven ones. */
  successes?: string[];
  procedures?: string[];
  project?: string;
  /** Runtime-selected strategy compiled from current environment and feedback. */
  adaptiveStrategy?: string;
}

const GUI_WEB_TOOLS_PROMPT = `Web tools:
- web_search(query, maxResults?) — web search. With a Serper or Tavily API key in Settings → Tools it uses the API backends first (Serper = real Google index, best for Chinese AND English); otherwise free backends are probed in parallel — cn.bing.com + DuckDuckGo + Bing for Chinese queries, DuckDuckGo + Bing otherwise (the first backend to return results wins). If a search returns no results or fails, do NOT repeat the same or a near-identical query — rephrase it (broader terms, simpler wording, or English), or use web_fetch on a URL you expect to be authoritative.
- web_fetch(url, maxChars?) — fetch and extract readable text from a text/HTML/JSON page. If web_fetch reports an unsupported content type, do NOT retry the same URL — use web_search instead or pick a different page.`;

const GUI_SYS_INFO_PROMPT = `System:
- sys_info() — timezone, language, current time, OS version, and the user's configured location. When the user asks for the current time, date, timezone, language, OS version, OR anything that depends on where the user is (trip planning "from my city", weather, delivery, local services, events), call sys_info() FIRST — never guess from your training data. The user can set/override their location in Settings → General → Environment.`;

const CLI_CAPABILITIES_PROMPT = `System:
- sys_info() — timezone, language, current time, OS version, installed runtimes (node/bun/python3/rustc/git versions), and the user's configured location. When the user asks for the current time, date, timezone, language, OS version, a runtime version, a git capability, OR anything that depends on where the user is (trip planning "from my city", weather, delivery, local services, events), call sys_info() FIRST — never guess from your training data.

Web tools:
- researcher_web(prompt, maxSources?, fetchContent?) — research a web question and return cited sources, extracted evidence, retrieval time, and partial failures. Do not repeat an unchanged query after a failure.
- researcher_docs(library, topic, version?, maxSources?, fetchContent?) — research version-aware official documentation and return cited evidence.
- web_public_api(query, category?, location?) — structured-data lookup through curated no-key public APIs (weather, geocode, news, wiki, IP, FX, stock, GitHub). Use it for concrete factual lookups like "北京天气", "100 usd to cny", or "苹果股价" — the web_search alias also auto-routes these, and when no structured source matches this tool auto-falls back to web search (searchOnMiss:false opts out). Not for general discovery or ambiguous questions — use researcher_web.
- web_scrape(url, selector?, maxChars?) — fetch a KNOWN URL and extract readable text (navigation stripped; optional #id/.class/tag selector; RSS feeds and JSON auto-formatted; Jina Reader fallback for blocked, JS-heavy, or binary pages). Use when you already have the URL; use researcher_web when you need to find one.

Diagram rendering:
- The CLI renders \`\`\`mermaid graph/flowchart and \`\`\`puml / \`\`\`plantuml blocks as a terminal WIREFRAME (boxes + connecting lines drawn with box-drawing characters) — no browser, no image. Prefer mermaid for process/flow diagrams, puml for activity/sequence. Emit them as normal fenced blocks; the client converts them.`;

const GUI_IMAGE_GEN_PROMPT = `\n\nImage generation:\n- generate_image(prompt, n?, size?) — text-to-image with the connected provider's image model. Use it for image/icon/illustration/photo/poster requests ("创作一个小狗图标", "生成一张 xxx 图片"); the result renders as a real picture in the chat. Pass n > 1 (up to 4) for multiple images or variations. NEVER emit fenced svg code blocks for image requests while this tool is available — SVG is only for hand-drawn diagrams, and the fallback when generate_image fails.`;

export function buildGuiCapabilities(hasWorkspace: boolean, temporaryWorkspace = false, options: { imageGeneration?: boolean } = {}): string {
  const workspaceNote = hasWorkspace
    ? temporaryWorkspace
      ? '\nWorkspace: no user workspace is selected, so file changes go to an isolated application temporary workspace for this session.'
      : ''
    : '\nWorkspace: none selected — no local filesystem or shell access. Open Settings → Tools to add a workspace.';
  const fileTools = `${FILE_TOOLS_CORE}\n\nPath rule: pass file and directory paths relative to the selected workspace root (for example src/app.ts, not the workspace absolute path). The backend also accepts an absolute path only when it is inside the selected workspace; never invent or prepend the workspace twice.`;
  const tools = hasWorkspace
    ? `${GUI_WEB_TOOLS_PROMPT}\n\n${fileTools}\n\n${GUI_SYS_INFO_PROMPT}`
    : `${GUI_WEB_TOOLS_PROMPT}\n\n${GUI_SYS_INFO_PROMPT}`;
  const imageGen = options.imageGeneration ? GUI_IMAGE_GEN_PROMPT : '';
  return `${workspaceNote}\n${tools}${imageGen}`;
}

export function buildCliCapabilities(): string {
  return `${FILE_TOOLS_CORE}\n\n${CLI_CAPABILITIES_PROMPT}`;
}

function buildOutputStyle(surface: PromptSurface, imageGeneration = false): string {
  const visualOutput = surface === 'gui'
    ? imageGeneration
      ? `- To SHOW a picture/icon/illustration/photo, call generate_image — the app renders the result as a real image. For hand-drawn diagrams (flowcharts, architecture, sequence), still emit fenced code blocks tagged svg / mermaid / puml.\n- ${CHART_DSL_PROMPT}`
      : `- To SHOW a picture/diagram, emit it as a fenced code block tagged svg containing complete standalone SVG — the app renders it inline as an image (diagrams render too: mermaid for flowchart/gantt/sequence, puml for PlantUML).\n- ${CHART_DSL_PROMPT}`
    : '- For diagrams (processes, flows, architecture, sequences), emit a fenced code block tagged mermaid (graph/flowchart: A --> B) or puml/plantuml (activity: :step; --> / sequence: Alice -> Bob: message) — the CLI renders these as a wireframe with boxes and connecting lines. Keep the response readable in a terminal.';
  return `Output style:
- Default to inline replies for questions, explanations, and SHORT code snippets: render them directly in your response (use fenced markdown code blocks for code). Call write_file / edit_file / replace_files ONLY when the user explicitly asks to save or persist to disk, names a target path, or the task requires on-disk artifacts (e.g. "scaffold a project at /tmp/foo", "create README.md", "fix this file").
- Structure longer replies into clear sections — use Markdown headings (##) for each category, short paragraphs for each point, and lists where items fit. Wrap the KEY phrase(s) of each section in ==double equals== (e.g. ==西安到重庆==, ==3 小时 40 分==) so they render HIGHLIGHTED; keep the surrounding prose plain so the highlighted-vs-plain contrast is visible.
${visualOutput}
- For a weather forecast or other time-sensitive data, call web_search FIRST and use the returned forecast data; never invent future weather. If the user did not provide a location, ask for it or state the location assumption clearly. Then include both a concise explanation and, when supported by the client, a fenced chart block so the result is useful.
- Information queries (weather, news, facts, prices, directions, lookup) are ANSWERED INLINE — never persist web_search / web_fetch results to disk as data files (no weather.js, no *_raw.js, no "saved response" files). write_file / edit_file are for artifacts the user asked to create or modify, not for stashing fetched data. If you think data are worth keeping, summarize them in your reply instead.
- A bare "generate X", "show me X", "give me X", "what does X look like", or any "write me code for…" without a path means inline output — never reach for write_file.
- COMPLETE runnable artifacts go to disk by default: when the user asks you to BUILD a full game, mini-game, web page/site, app, tool, script, or small project ("写一个小游戏", "做一个网页", "开发一个工具" — even without naming a path), WRITE it to a file instead of printing the whole source inline. Single-file artifact → a new file like index.html / game.html / app.py in the workspace; multi-file project → a new directory with the files. After writing, state the path(s) and how to run/open it.
- When you do write a file, briefly state where it landed and confirm the user actually wanted persistence; the EXISTENCE of a workspace does NOT imply "save everything to disk".`;
}

function buildToolCallingRules(surface: PromptSurface): string {
  const workspaceRule = surface === 'gui'
    ? '- If no user workspace is configured, use the isolated application temporary workspace provided for this session. Do not imply that those files were written into a user-selected project.'
    : '- The CLI defaults workspace to the current directory. Do not claim a file was written outside the workspace or invent a workspace path.';
  return `Tool-calling rules:
- NEVER emit tool calls as XML or text (no <tool_calls>, <invoke name="...">, or JSON inside your reply).
- Tool calls are made ONLY through the function-calling interface, never as visible text.
- Finish the sentence you are writing BEFORE emitting a tool call. Never leave a dangling, incomplete sentence of prose right before a tool call — that fragment is shown to the user as its own message and reads as a confusing cut-off. A tool call is an action, not a continuation of your narration; if your lead-in is incomplete, complete it first.
${workspaceRule}`;
}

function buildMode(mode?: PromptTaskMode): string {
  if (!mode || mode === 'yolo') return '';
  const label = mode === 'build' ? 'BUILD' : 'PLAN';
  const directive = mode === 'build'
    ? 'Work through the request in clear phases; when you complete each phase, briefly state what was done and what remains.'
    : 'Work through the request in ordered steps and verify after each change.';
  return `<task_mode>\nOperating mode: ${label} — auto-detected from the user's request as a complex multi-step task. ${directive}\n</task_mode>`;
}

function buildSkills(skills?: PromptSkill[]): string {
  const enabled = (skills ?? []).filter((skill) => skill.enabled !== false && skill.body);
  if (enabled.length === 0) return '';
  return `Installed skills (follow these when they apply):\n${enabled.map((skill) => `\n<skill name="${sanitizeSkillName(skill.name)}">\n${skill.body}\n</skill>`).join('')}`;
}

function sanitizeSkillName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.\-/]/g, '_');
}

function fragment(id: string, content: string, priority: number, required = false): PromptFragment | null {
  return content.trim() ? { id, content, priority, required } : null;
}

function selectFragments(fragments: PromptFragment[], maxTokens: number): { fragments: PromptFragment[]; omitted: string[] } {
  const required = fragments.filter((item) => item.required);
  const optional = fragments
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.required)
    .sort((a, b) => b.item.priority - a.item.priority || a.index - b.index);
  let used = required.reduce((sum, item) => sum + estimatePromptTokens(item.content), 0);
  const included = new Set(required);
  for (const { item } of optional) {
    const tokens = estimatePromptTokens(item.content);
    if (used + tokens <= maxTokens) {
      included.add(item);
      used += tokens;
    }
  }
  return {
    fragments: fragments.filter((item) => included.has(item)),
    omitted: fragments.filter((item) => !included.has(item)).map((item) => item.id),
  };
}

function joinFragments(fragments: PromptFragment[]): string {
  return fragments.map((item) => item.content).join('\n\n');
}

function buildTaskFragments(context: UserTurnContext): PromptFragment[] {
  const parts: Array<[string, string | undefined, number, boolean?]> = [
    ['traps', context.traps, 70],
    ['build_protocol', context.buildProtocol, 60],
    ['plan', context.plan, 85],
    ['clarifications', context.clarifications, 100, true],
    ['contract', context.contract, 80],
    ['assessment', context.assessment, 90],
  ];
  return parts
    .map(([id, content, priority, required]) => fragment(id, content ?? '', priority, required))
    .filter((item): item is PromptFragment => item !== null);
}

function composeSelectedUserPrompt(text: string, context: UserTurnContext, maxTokens: number): { prompt: string; fragments: PromptFragment[]; omitted: string[] } {
  const task = buildTaskFragments(context);
  const userText = fragment('user_request', text, 120, true)!;
  const selection = selectFragments([userText, ...task], maxTokens);
  const selectedTask = selection.fragments.filter((item) => item.id !== 'user_request');
  const prompt = selectedTask.length === 0
    ? text
    : `<task_context>\n${selectedTask.map((item) => item.content).join('\n\n')}\n</task_context>\n\n${text}`;
  return { prompt, fragments: selection.fragments, omitted: selection.omitted };
}

export class PromptAssembler {
  constructor(private readonly observability: PromptObservability = promptObservability) {}

  getObservability(): PromptObservability {
    return this.observability;
  }

  buildSystemFragments(context: PromptAssemblyContext): PromptFragment[] {
    const capabilities = context.capabilities.trim();
    return [
      fragment('system_core', SYSTEM_CORE_PROMPT, 120, true),
      fragment('capabilities', `<capabilities>${capabilities ? `\n${capabilities}` : ''}\n</capabilities>`, 75),
      fragment('work_invariant', 'Work step by step. Read before you write. Verify after you change. Be concise.', 110, true),
      fragment('workflow', WORKFLOW_PROMPT, 90),
      fragment('completion', COMPLETION_PROMPT, 80),
      fragment('output_style', buildOutputStyle(context.surface, context.imageGeneration === true), 65),
      // Image requests follow ONE contract: the generate_image tool when the
      // provider supports it, otherwise the multi-SVG grid contract. Never both.
      fragment(context.imageGeneration === true ? 'image_gen' : 'svg_output', context.imageGeneration === true ? IMAGE_GEN_OUTPUT_PROMPT : SVG_OUTPUT_PROMPT, 50),
      fragment('human_tone', HUMAN_TONE_PROMPT, 35),
      fragment('tool_calling', buildToolCallingRules(context.surface), 115, true),
      fragment('typo_tolerance', TYPO_TOLERANCE_PROMPT, 55),
      fragment('logical_traps', LOGICAL_TRAPS_PROMPT, 70),
      fragment('capability_gap', CAPABILITY_GAP_PROMPT, 75),
      fragment('environment', context.environment ?? '', 60),
      fragment('runtimes', context.runtimes ?? '', 45),
      fragment('skills', buildSkills(context.skills), 30),
      fragment('task_mode', buildMode(context.mode), 85),
    ].filter((item): item is PromptFragment => item !== null);
  }

  buildSystemPrompt(context: PromptAssemblyContext): string {
    const budget = resolvePromptBudget(context.budget);
    const toolTokens = estimateToolDefinitionTokens(context.toolDefinitions);
    const selection = selectFragments(
      this.buildSystemFragments(context),
      Math.max(1, budget.availableInputTokens - toolTokens),
    );
    return joinFragments(selection.fragments);
  }

  buildUserPrompt(
    text: string,
    context: UserTurnContext = {},
    budgetConfig?: PromptBudgetConfig,
    toolDefinitions: ToolDefinition[] = [],
  ): string {
    if (!budgetConfig) return composeUserTurn(text, context);
    const budget = resolvePromptBudget(budgetConfig);
    const toolTokens = estimateToolDefinitionTokens(toolDefinitions);
    return composeSelectedUserPrompt(
      text,
      context,
      Math.max(1, budget.availableInputTokens - toolTokens),
    ).prompt;
  }

  assemble(context: PromptAssemblyContext, userText?: string, userContext: UserTurnContext = {}): PromptAssembly {
    const budget = resolvePromptBudget(context.budget);
    const estimatedToolTokens = estimateToolDefinitionTokens(context.toolDefinitions);
    const messageBudget = Math.max(1, budget.availableInputTokens - estimatedToolTokens);
    const systemSelection = selectFragments(this.buildSystemFragments(context), messageBudget);
    const systemPrompt = joinFragments(systemSelection.fragments);
    const systemTokens = estimatePromptTokens(systemPrompt);
    const userSelection = userText === undefined
      ? { prompt: undefined, fragments: [] as PromptFragment[], omitted: [] as string[] }
      : composeSelectedUserPrompt(
          userText,
          userContext,
          Math.max(1, messageBudget - systemTokens),
        );
    const userTokens = userSelection.prompt ? estimatePromptTokens(userSelection.prompt) : 0;
    const fragments = [...systemSelection.fragments, ...userSelection.fragments];
    const omittedFragmentIds = [...systemSelection.omitted, ...userSelection.omitted];
    const report: PromptBudgetReport = {
      ...budget,
      estimatedInputTokens: systemTokens + userTokens + estimatedToolTokens,
      estimatedToolTokens,
      includedFragmentIds: [...fragments.map((item) => item.id), ...(estimatedToolTokens > 0 ? ['tool_schemas'] : [])],
      omittedFragmentIds,
      overBudget: systemTokens + userTokens + estimatedToolTokens > budget.availableInputTokens,
    };
    const traceId = this.observability.recordAssembly({
      traceId: context.traceId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      surface: context.surface,
      provider: budget.provider,
      model: budget.model,
      systemPrompt,
      userPrompt: userSelection.prompt,
      promptVersion: promptVersion(systemPrompt),
      budget: report,
    });
    return { systemPrompt, userPrompt: userSelection.prompt, budget: report, traceId };
  }

  composeMemoryPrompt(input: { template: string; memory?: PromptMemoryContext; budget?: PromptBudgetConfig; toolDefinitions?: ToolDefinition[] }): string {
    const memory = input.memory;
    const hasMemory = !!memory && (
      memory.preferences.length > 0
      || memory.errorPatterns.length > 0
      || (memory.successes?.length ?? 0) > 0
      || (memory.procedures?.length ?? 0) > 0
      || Boolean(memory.adaptiveStrategy?.trim())
    );
    if (!hasMemory) return input.template;

    const memoryFragments = [
      fragment('memory_project', memory?.project ? `Project: ${memory.project}` : '', 35),
      fragment('memory_preferences', memory?.preferences.length ? `User preferences:\n${memory.preferences.map((value) => `- ${value}`).join('\n')}` : '', 45),
      // v1.9.7 — proven successes rank ABOVE errors: when a verified approach
      // matches, the model should prefer it; error patterns are avoid-lists.
      fragment('memory_successes', memory?.successes?.length ? `Proven successful approaches (prefer these when the situation matches):\n${memory.successes.map((value) => `- ${value}`).join('\n')}` : '', 60),
      fragment('memory_procedures', memory?.procedures?.length ? `Proven procedures (apply when the situation matches):\n${memory.procedures.map((value) => `- ${value}`).join('\n')}` : '', 40),
      fragment('memory_errors', memory?.errorPatterns.length ? `Known error patterns (avoid repeating these calls):\n${memory.errorPatterns.map((value) => `- ${value}`).join('\n')}` : '', 55),
      fragment('adaptive_strategy', memory?.adaptiveStrategy ?? '', 95),
    ].filter((item): item is PromptFragment => item !== null);
    const open = input.template.indexOf('<session_memory>');
    const close = open >= 0 ? input.template.indexOf('</session_memory>', open) : -1;
    const templateBase = close >= 0
      ? input.template.slice(0, open) + input.template.slice(close + '</session_memory>'.length)
      : input.template;
    const budget = input.budget ? resolvePromptBudget(input.budget) : undefined;
    const toolTokens = estimateToolDefinitionTokens(input.toolDefinitions);
    const memoryLimit = budget
      ? Math.max(1, budget.availableInputTokens - estimatePromptTokens(templateBase) - toolTokens)
      : Number.MAX_SAFE_INTEGER;
    const selection = selectFragments(memoryFragments, memoryLimit);
    if (selection.fragments.length === 0) return input.template;
    const adaptive = selection.fragments.filter((item) => item.id === 'adaptive_strategy');
    const retainedMemory = selection.fragments.filter((item) => item.id !== 'adaptive_strategy');
    const sections = [
      retainedMemory.length > 0
        ? `<session_memory>\n${retainedMemory.map((item) => item.content).join('\n')}\n</session_memory>`
        : '',
      adaptive.length > 0
        ? `<adaptive_context>\n${adaptive.map((item) => item.content).join('\n')}\n</adaptive_context>`
        : '',
    ].filter(Boolean).join('\n\n');
    return close >= 0
      ? input.template.slice(0, open) + sections + input.template.slice(close + '</session_memory>'.length)
      : `${input.template}\n\n${sections}`;
  }

  assembleMemory(input: { template: string; memory?: PromptMemoryContext; budget?: PromptBudgetConfig }): string {
    return this.composeMemoryPrompt(input);
  }
}

export const promptAssembler = new PromptAssembler();

export { estimatePromptTokens, estimateToolDefinitionTokens, resolvePromptBudget };
