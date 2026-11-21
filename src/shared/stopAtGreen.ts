// src/shared/stopAtGreen.ts
// 验收即停（2026-11-21 用户判例：做项目「盲目又啰嗦，常常绕弯路，很长时间
// 完成不了」；docs/evals 的同批实测也是同一形状——验收已绿后继续补测试、
// 继续绕，直到接近预算上限）。
//
// 为什么是机械层而不是又一段 prompt：停止时机不能靠模型自述「我做完了」。
// 项目级验证命令真跑过并且 exit 0 是确定性证据；模型在拿到这份证据后仍然
// 开新探索，靠教学挽回不了（教学只会让它把「再检查一遍」也当成工作）。
// 引擎在工具结果配平点看一眼这份证据，本回合首次变绿时注入一条一次性
// internal 提醒，把「已经绿了」摆到下一轮眼前。模型仍然拥有裁决权：真缺
// 用户要的交付物就补完，其余情况收尾。
//
// 与 opencode 的对照：它的循环里也没有「验收后继续」的入口——模型不再发
// 工具调用就收尾；步数到顶时注入一条收束提醒而不是杀循环。这里做的是
// 同一类机制：机制只提供事实与收束信号，不替模型决定任务是否完成。
//
// 只认项目级验证：`bun test`（全量）/`bun run typecheck`/`tsc --noEmit`/
// `pytest`/`go test ./...` 这类。带测试路径的局部跑（`bun test src/a.test.ts`）
// 不算绿——那时验收面还没覆盖完，提前收尾比多跑两轮更伤。

/** 项目级验证的脚本名（`npm run <name>` / `bun run <name>`）。 */
const VERIFY_SCRIPT_NAMES = /^(?:typecheck|type-check|check|test|tests|build|lint|verify|ci)$/i;

/** 直接调用的验证器：命令名 → 该命令是否属于项目级验证。 */
const DIRECT_VERIFIERS = new Set([
  'vitest', 'jest', 'mocha', 'playwright', 'cypress', 'pytest', 'phpunit', 'rspec',
  'cargo', 'go', 'make', 'mvn', 'gradle', 'dotnet', 'swift', 'flutter', 'mix',
  'tsc', 'biome', 'oxlint', 'eslint',
]);

/** 包管理器前缀：真正的命令在 `run` 之后（或裸脚本名）。 */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx']);

/** 直接跑脚本文件的运行时（`node scripts/verify.mjs`）。 */
const SCRIPT_RUNNERS = new Set(['node', 'deno', 'tsx', 'ts-node']);

/**
 * 自建验收脚本的文件名形态：verify / e2e / smoke / check / acceptance。
 * 必须是带扩展名的路径（`scripts/verify.mjs`、`./e2e/smoke.ts`），裸词
 * `verify` 交给包管理器脚本名规则，不在这里认。
 */
const VERIFICATION_SCRIPT = /(?:^|\/)(?:verify|e2e|smoke|acceptance|check)[\w.-]*\.(?:mjs|cjs|js|mts|cts|ts)$/i;

/** 与验证无关、但可以合法出现在命令前面的包装词。 */
const WRAPPERS = new Set(['time', 'nohup', 'sudo', 'env', 'command']);

export interface GreenWatch {
  /**
   * 记账一次工具结果。返回非空 = 本回合首次看到项目级验证通过，调用方应把
   * 这段文本作为 internal user 消息插进转录（每条提醒只值一次 token）。
   */
  observe(toolName: string, rawArgs: string | undefined, success: boolean): string;
}

/** 一条命令是不是「项目级验证」（全量测试 / 类型检查 / 构建 / lint）。 */
export function isProjectVerificationCommand(command: string): boolean {
  if (!command.trim()) return false;
  for (const segment of commandSegments(command)) {
    const tokens = commandTokens(segment);
    if (tokens.length === 0) continue;
    if (isVerificationTokens(tokens)) return true;
  }
  return false;
}

/**
 * 建一份回合级观察器。状态实例化而不是模块级单例：引擎一次 run 一份，
 * 回合之间、父子 agent 之间不会串账（教训同 parallelNudge 的 flaky 判例）。
 */
/**
 * A/B 与回退开关：`PURE_STOP_AT_GREEN=0` 关掉提醒。放在产物里而不是脚本里，
 * 是因为真机对照必须用同一份代码跑两个臂（两个构建的差异说不清是谁的功劳）。
 * 默认开；WebView 里没有 process，落到默认分支。
 */
export function stopAtGreenEnabled(): boolean {
  return typeof process === 'undefined' || process.env?.PURE_STOP_AT_GREEN !== '0';
}

export function createGreenWatch(): GreenWatch {
  let announced = false;
  return {
    observe(toolName: string, rawArgs: string | undefined, success: boolean): string {
      if (announced || !success) return '';
      // MCP 工具的命名形如 mcp__server__tool；内建 execute_command 不前缀，
      // 但归一化一次让以后换命名方式也不会静默失效（同 isWebResearchTool 口径）。
      const base = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
      if (base !== 'execute_command') return '';
      const command = commandFromArgs(rawArgs);
      if (!command || !isProjectVerificationCommand(command)) return '';
      announced = true;
      return renderStopAtGreen(command);
    },
  };
}

function renderStopAtGreen(command: string): string {
  const shown = command.length > 160 ? `${command.slice(0, 157)}…` : command;
  return `<stop_at_green>
\`${shown}\` just passed with exit 0 — the project-level check is green.
Do not start new work after this point: no extra tests, no extra refactors, no broader exploration, no "while I'm here" cleanups, and no re-running the same check for reassurance. If a deliverable the user actually asked for is still missing, write only that; otherwise stop calling tools and hand the work over now — what changed, the check that passed, and anything left unverified. More polish after green is not progress; it is time the user pays for.
</stop_at_green>`;
}

/** 命令原文可能在 JSON 参数里（execute_command 的 schema）。解析失败按空处理。 */
function commandFromArgs(rawArgs: string | undefined): string {
  if (!rawArgs) return '';
  try {
    const parsed = JSON.parse(rawArgs) as { command?: unknown };
    return typeof parsed.command === 'string' ? parsed.command : '';
  } catch {
    return '';
  }
}

/**
 * 拆出可独立判定的命令段：`cd app && bun test 2>&1 | tail -5` 的验证语义只
 * 在后半段，前置的 `cd` 与后置的管道不该影响判定。
 */
function commandSegments(command: string): string[] {
  return stripHeredocBodies(command)
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||;|\r?\n/)
    .map((segment) => segment.split('|')[0] ?? '')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * 去掉 heredoc 正文（2026-11-21 真机误报判例）。`cat > /tmp/smoke.mjs <<'EOF' … EOF`
 * 的正文里可能有任意代码行——按换行切段会把正文当成命令，其中带
 * `smoke.mjs` 的一行就冒充了项目级验收，绿信号在 acceptance 还没跑通时
 * 就发了出去。heredoc 正文不是命令，切段前先整段剥掉。
 */
function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const terminator = pending.indexOf(line.trim());
      if (terminator >= 0) pending.splice(terminator, 1);
      continue;
    }
    out.push(line);
    for (const match of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
      pending.push(match[2]!);
    }
  }
  return out.join('\n');
}

/** 去掉环境变量赋值与包装词，返回真正可执行命令的词元。 */
function commandTokens(segment: string): string[] {
  const raw = segment
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^['"]+|['"]+$/g, ''))
    .filter((token) => token.length > 0);
  let start = 0;
  while (start < raw.length) {
    const token = raw[start]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || WRAPPERS.has(basename(token))) {
      start += 1;
      continue;
    }
    break;
  }
  return raw.slice(start);
}

function isVerificationTokens(tokens: string[]): boolean {
  const command = basename(tokens[0]!);
  const rest = tokens.slice(1);

  if (command === 'python' || command === 'python3' || command === 'py') {
    // `python -m pytest` 与裸 `pytest` 等价；其余 python 调用不是验证。
    const moduleIndex = rest.indexOf('-m');
    if (moduleIndex < 0) return false;
    const module = rest[moduleIndex + 1];
    return module === 'pytest' || module === 'unittest' ? broadRun(rest.slice(moduleIndex + 2)) : false;
  }

  // 自建验收脚本（2026-11-21 大屏真机判例）：模型为演示项目写了
  // `scripts/verify.mjs`，跑出 25/25 全绿，再往下就开始换底图、打生产包。
  // 只认包管理器脚本名时这份绿完全不可见——可它跑的正是整页验收面（登录、
  // 总览、转场、详情、圈选），比 `bun test` 对原型更接近项目级证据。
  if (SCRIPT_RUNNERS.has(command)) return isScriptVerification(rest);
  if (RUNNERS.has(command)) return isRunnerVerification(command, rest);

  if (!DIRECT_VERIFIERS.has(command)) return false;

  // tsc 只有在声明了项目级语义时才算：`tsc --noEmit` / `tsc -p tsconfig.json`。
  // 裸 `tsc file.ts` 是编译单文件，不代表整个项目类型通过。
  if (command === 'tsc') {
    const projectWide = rest.some((arg) => arg === '--noEmit' || arg === '-p' || arg === '--project');
    return projectWide && broadRun(rest.filter((arg) => arg !== '--noEmit'));
  }
  // go 的构建/测试默认只作用于当前包：要显式 `./...` 才是整个模块。
  if (command === 'go') {
    const sub = rest[0];
    if (sub !== 'test' && sub !== 'build' && sub !== 'vet') return false;
    return rest.includes('./...') && broadRun(rest.slice(1).filter((arg) => arg !== './...'));
  }
  return broadRun(rest);
}

/**
 * `node scripts/verify.mjs` / `node --test` / `tsx e2e/smoke.ts`。
 * 脚本路径本身是验收面才算；脚本之后再带位置参数视为收窄验收面。
 */
function isScriptVerification(args: string[]): boolean {
  if (args.includes('--test')) return true;
  const scriptIndex = args.findIndex((arg) => !arg.startsWith('-'));
  if (scriptIndex < 0) return false;
  const script = args[scriptIndex]!.replace(/\\/g, '/');
  if (!VERIFICATION_SCRIPT.test(script)) return false;
  // 临时目录里的一次性 smoke 不是项目验收（2026-11-21 误报同案：
  // /tmp/smoke.mjs 冒充了 scripts/verify.mjs）。只认项目内的脚本。
  if (/^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/var\/tmp\/)/.test(script)) return false;
  return broadRun(args.slice(scriptIndex + 1));
}

function isRunnerVerification(runner: string, rest: string[]): boolean {
  const isRunner = runner === 'npx' || runner === 'bunx';
  if (isRunner) {
    const target = rest[0];
    if (!target) return false;
    // `npx tsx scripts/verify.ts`：脚本运行时本身就是透明的 runner。
    if (SCRIPT_RUNNERS.has(basename(target))) return isScriptVerification(rest.slice(1));
    if (!DIRECT_VERIFIERS.has(basename(target))) return false;
    return isVerificationTokens([target, ...rest.slice(1)]);
  }
  // `bun scripts/verify.ts` 与 `bun run scripts/verify.ts`：包管理器的 `run`
  // 省略后脚本名可能带路径，VERIFY_SCRIPT_NAMES 只认裸词。
  if (isScriptVerification(rest)) return true;

  // bun 自带的 `build` 是打包入口（`bun build src/index.ts`），不是项目脚本。
  const runIndex = rest.findIndex((arg) => arg === 'run' || arg === 'run-script');
  if (runIndex >= 0) {
    const script = rest[runIndex + 1];
    if (!script) return false;
    if (VERIFICATION_SCRIPT.test(script.replace(/\\/g, '/'))) return broadRun(rest.slice(runIndex + 2));
    if (!VERIFY_SCRIPT_NAMES.test(script)) return false;
    return broadRun(rest.slice(runIndex + 2));
  }
  let headIndex = 0;
  while (headIndex < rest.length && rest[headIndex]!.startsWith('-')) headIndex += 1;
  const head = rest[headIndex];
  if (!head) return false;
  if (runner === 'bun' && head === 'x') return rest[headIndex + 1] === 'tsc' && isVerificationTokens(rest.slice(headIndex + 1));
  if (runner === 'bun' && head === 'build') return false;
  if (!VERIFY_SCRIPT_NAMES.test(head)) return false;
  return broadRun(rest.slice(headIndex + 1));
}

/**
 * 只接受「跑全量」的调用：带路径/测试文件位置的参数说明验收面被缩小了，
 * 不能当作项目已绿。flag 的值（`--project unit`）没有路径形态，会放过。
 */
function broadRun(args: string[]): boolean {
  return !args.some((arg) => {
    if (arg.startsWith('-')) return false;
    if (arg === './...' || arg === '...') return false;
    return arg.includes('/') || arg.includes('\\') || /\.(?:[cm]?[jt]sx?|py|rs|go|java|rb|php|cs|kt|swift|dart|vue|svelte)$/i.test(arg);
  });
}

function basename(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.replace(/\.(?:exe|cmd|bat)$/i, '');
}
