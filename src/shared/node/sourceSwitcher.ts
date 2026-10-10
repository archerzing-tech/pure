// src/shared/sourceSwitcher.ts
// 换源逻辑：生态 → 候选源 → 并发测速选优 → 应用（S2 单请求改写 / S1 会话环境
// 变量 / file 级真写配置文件）。
//
// 可回退性分层（产品边界，不可越界）：
//   S2 单请求改写 —— 无痕自回退，进程退出即消失。本模块不做（它属于调用方
//      拼 CLI 参数的范畴），但返回值里会明确给出建议命令。
//   S1 会话环境变量 —— 只产出映射、不落盘、不 spawn 任何命令。**默认档**。
//   file 级真写 —— 必须显式传参 + 用户确认 + journal 记 undo，且回滚语义是
//      「删键」而不是「把上游 URL 写回去」（原值本来就没配过的话）。
//
// 绝对不自动写：OS 包管理器（apt/yum/pacman，要 root）、docker（要 root +
// 重启守护进程）、nix、以及 brew/nvm/rustup 这类写 shell profile 的版本管理
// 器、NuGet。chsrc 自己都没实现 NuGet，这不是能力缺失而是判断。
//
// 测速判据刻意不同于 chsrc：chsrc 只看下载速度、不看状态码（200 以外照样
// 参与比较），于是 403/429 的死源常常因为「回得快」而胜出。这里要求先拿到
// **有效响应**（排除 CONNECT 隧道应答），再比延迟。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AUTO_TRUST_TIERS,
  BENCHMARK_PATHS,
  MIRROR_SOURCES,
  benchmarkUrlFor,
  candidatesFor,
  fileScopeAllowed,
  isEffectiveResponse,
  type Ecosystem,
  type MirrorSource,
  type TrustTier,
} from '../mirrorSources';

// 测速判据与拼接规则住在 mirrorSources（纯函数，GUI 也能用）。这里转发出去，
// 免得调用方为了一个拼 URL 去记它住在哪个文件。
export { BENCHMARK_PATHS, benchmarkUrlFor, isEffectiveResponse };

export type SwitchScope = 'session' | 'file';

/** 单次测速的总预算。并发跑完所有候选，最坏也只花这一个数。 */
export const BENCHMARK_TIMEOUT_MS = 8_000;

export interface BenchmarkResult {
  url: string;
  trust: TrustTier;
  /** 是否拿到有效响应（2xx/3xx，含 401/403 —— 那说明链路通）。 */
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  /** 因未获授权信任分层而未参与测速。 */
  skipped?: string;
}

export interface SwitchRequest {
  ecosystem: string;
  /** auto = 测速选优（默认）；具体 URL 或生态默认首选。 */
  source?: string;
  scope?: SwitchScope;
  /** 默认 true：只产出计划，不写任何东西。 */
  dryRun?: boolean;
  /** file 级时用户是否已批准。 */
  confirm?: boolean;
  /** 显式启用的信任分层；缺省只含 t0/t1。 */
  enabledTiers?: readonly TrustTier[];
  /** 测速路径（每个生态一条真实请求）。 */
  benchmarkPaths?: Partial<Record<Ecosystem, string>>;
  /** HOME 覆盖，测试用。 */
  homeDir?: string;
}

export interface FileWritePlan {
  path: string;
  /** 写入前读出的旧内容全文（cargo 必须靠它避免整体覆写）。 */
  previousContent: string;
  /** 写入前读出的旧键值；null = 该键此前不存在。 */
  previousValue: string | null;
  /** 文件此前不存在（回滚应删除整个文件而非删键）。 */
  fileExisted: boolean;
  /** 应用后应写入的内容。 */
  nextContent: string;
  /** 应用后的新键值。 */
  newValue: string;
  /** 回滚语义：删键（而非写回上游 URL）。 */
  undo: { kind: 'delete-key' | 'delete-file'; key?: string };
  undoCommand: string;
}

export interface SwitchResult {
  ok: boolean;
  ecosystem?: Ecosystem;
  scope?: SwitchScope;
  dryRun?: boolean;
  /** 选定源。 */
  source?: { url: string; trust: TrustTier; operator?: string; notes?: string };
  /** 会话级注入的环境变量（不落盘）。 */
  sessionEnv?: Record<string, string>;
  /** file 级：涉及的文件与旧值。 */
  files?: FileWritePlan[];
  /** 是否可回滚。 */
  reversible: boolean;
  /** 人类可执行的回滚命令。 */
  undoCommand?: string;
  /** 测速明细。 */
  benchmark?: BenchmarkResult[];
  warnings: string[];
  error?: string;
  /** 执行摘要（人看）。 */
  summary?: string;
}

// ── 测速 ──

export interface BenchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 并发探测候选源，返回带有效响应标记的明细。 */
export async function benchmarkSources(
  ecosystem: Ecosystem,
  candidates: readonly MirrorSource[],
  opts: BenchOptions & { path?: string; enabledTiers?: readonly TrustTier[] } = {},
): Promise<BenchmarkResult[]> {
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  const path = opts.path ?? BENCHMARK_PATHS[ecosystem];
  const enabled = opts.enabledTiers ?? AUTO_TRUST_TIERS;
  const timeoutMs = opts.timeoutMs ?? BENCHMARK_TIMEOUT_MS;

  if (!fetchImpl) {
    return candidates.map((c) => ({
      url: c.url,
      trust: c.trust,
      ok: false,
      ms: 0,
      skipped: '本运行环境没有 fetch 原语，未测速',
    }));
  }

  // 并发而非串行：chsrc 串行 8s×N 意味着 5 个源要等 40s，用户在那 40s 里什么
  // 也做不了。并发把最坏情况压回单个 8s 预算。
  return Promise.all(candidates.map(async (c): Promise<BenchmarkResult> => {
    if (!enabled.includes(c.trust)) {
      return {
        url: c.url,
        trust: c.trust,
        ok: false,
        ms: 0,
        skipped: `${c.trust} 信任分层默认关闭，未测速；如需使用请在设置里显式开启`,
      };
    }
    // 拼接规则在 mirrorSources.buildBenchmarkUrl（CLI / GUI 共用）：自带路径尾
    // 的源会被合并重叠分段，而不是拼成 /npm/npm。
    const url = benchmarkUrlFor(ecosystem, c.url, path);
    const started = Date.now();
    try {
      const resp = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: '*/*', 'User-Agent': 'pure-source-bench/1' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      let prefix = '';
      try {
        const len = Number(resp.headers.get('content-length') ?? '0');
        if (!Number.isFinite(len) || len === 0 || len <= 4096) {
          prefix = (await resp.text()).slice(0, 64);
        } else {
          const reader = resp.body?.getReader();
          if (reader) {
            const first = await reader.read();
            prefix = new TextDecoder().decode(first.value ?? new Uint8Array()).slice(0, 64);
            reader.cancel().catch(() => { /* released */ });
          }
        }
      } catch { prefix = ''; }
      const ok = isEffectiveResponse(resp.status, prefix);
      return {
        url: c.url,
        trust: c.trust,
        ok,
        status: resp.status,
        ms: Date.now() - started,
        ...(ok ? {} : { error: ok ? undefined : `无效响应（状态 ${resp.status}）` }),
      };
    } catch (err) {
      return { url: c.url, trust: c.trust, ok: false, ms: Date.now() - started, error: (err as Error).message };
    }
  }));
}

/** 选优：有效响应优先，其次延迟。没有有效响应时退回首选（让上层如实报告失败）。 */
export function pickBest(results: readonly BenchmarkResult[], candidates: readonly MirrorSource[]): BenchmarkResult | undefined {
  const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  if (ok.length > 0) return ok[0];
  return results.length > 0 ? results[0] : undefined;
}

// ── 会话级（S1）：环境变量映射 ──

/**
 * 会话级换源 = 一张环境变量映射表。不落盘、不 spawn 命令，返回给调用方去注入
 * 子进程。进程退出即消失，这是它排在 file 级之前的全部理由。
 */
export function sessionEnvFor(ecosystem: Ecosystem, sourceUrl: string): Record<string, string> {
  switch (ecosystem) {
    case 'npm':
      return { npm_config_registry: sourceUrl };
    case 'pip':
      return { PIP_INDEX_URL: sourceUrl };
    case 'cargo':
      // PROTOCOL=sparse 是必需的：不给它 cargo 会退回 git 索引协议去 clone
      // 整个 crates.io 仓库（数 GB），换源反而更慢。
      return {
        CARGO_REGISTRIES_CRATES_IO_INDEX: sourceUrl.startsWith('sparse+') ? sourceUrl : `sparse+${sourceUrl}`,
        CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
      };
    case 'go':
      // GOPROXY 的 `,direct` 是回退链语义：所有代理都失败后回落 VCS 直连。
      // 去掉它会让「代理全挂」从「慢」变成「彻底失败」。
      return { GOPROXY: sourceUrl.includes(',') ? sourceUrl : `${sourceUrl},direct` };
    case 'docker':
      // Docker 没有「环境变量换源」，只有镜像名前缀。空映射 + 说明是诚实的做法。
      return {};
    case 'composer':
      return { COMPOSER_REPOSITORIES_PACKAGIST_URL: sourceUrl };
    case 'rubygems':
      // bundle 的 key 规则：URL 里的 :// 与 / 写成 __，大写。
      return { 'BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG': sourceUrl };
    case 'huggingface':
      return { HF_ENDPOINT: sourceUrl };
    case 'maven':
    case 'github':
      return {};
  }
}

/** docker 这类没有环境变量换法的生态：给出前缀/参数建议而不是假装能注入。 */
export function commandAdviceFor(ecosystem: Ecosystem, sourceUrl: string): string[] {
  switch (ecosystem) {
    case 'docker':
      return [`docker pull ${sourceUrl}/library/nginx`, `docker pull ${sourceUrl}/library/redis`];
    case 'maven':
      return [`在 ~/.m2/settings.xml 的 <mirrors> 中配置 <mirrorOf>central</mirrorOf> 指向 ${sourceUrl}`];
    case 'github':
      return [`gh release download 直接走官方域最稳；归档可用 ${sourceUrl}/<owner>/<repo>/archive/refs/tags/<tag>.tar.gz`];
    case 'npm':
      return [`npm install --registry=${sourceUrl}`, '删除 package-lock.json 后重新 npm install，让 resolved URL 指向新源'];
    case 'cargo':
      return [`cargo fetch`];
    default:
      return [];
  }
}

// ── file 级：读旧值 → journal → 写 ──

export interface JournalEntry {
  ts: number;
  kind: 'source_switch';
  ecosystem: Ecosystem;
  scope: 'file';
  /** 涉及的文件路径。 */
  path: string;
  /** 回滚语义：删键（不是写回上游 URL）。 */
  undo: { kind: 'delete-key' | 'delete-file'; key?: string };
  /** 人可执行的回滚命令。 */
  undoCommand: string;
  /** 旧值：null = 该键此前不存在（回滚即删键）。 */
  previousValue: string | null;
  newValue: string;
  /** cargo 场景需要原文件全文才能安全回滚/重写。 */
  previousContent?: string;
  fileExisted: boolean;
  dryRun: boolean;
}

export function journalPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), '.pure', 'source-switch-journal.jsonl');
}

/** 追加 journal。journal 写不进去时**不让换源失败**——降级为 console.warn。 */
export function appendJournal(entry: JournalEntry, homeDir?: string): { ok: boolean; path: string; error?: string } {
  const path = journalPath(homeDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return { ok: true, path };
  } catch (err) {
    console.warn('[source-switch] journal append failed:', (err as Error).message);
    return { ok: false, path, error: (err as Error).message };
  }
}

export function readJournal(homeDir?: string): JournalEntry[] {
  const path = journalPath(homeDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JournalEntry;
      if (parsed && parsed.kind === 'source_switch' && typeof parsed.path === 'string') out.push(parsed);
    } catch {
      // 坏行留档不读：journal 是账本，坏行不应拖垮回放。
    }
  }
  return out;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * cargo 的 config.toml 改写。
 *
 * 必须整体读入再改写（保留原文件全文），因为整体覆写会静默丢掉用户的
 * `[build] rustflags`、`[target.x86_64-unknown-linux-gnu] linker` 等配置——
 * 这是 chsrc 的真实缺陷级设计错误：用户换完源，交叉编译配置无声消失。
 */
export function buildCargoConfig(
  existing: string,
  indexUrl: string,
): { next: string; changed: boolean; preservedLines: number } {
  const registryIndex = indexUrl.startsWith('sparse+') ? indexUrl : `sparse+${indexUrl}`;
  const sourceBlock = [
    '[source.crates-io]',
    'replace-with = "mirror"',
    '',
    '[source.mirror]',
    `registry = "${registryIndex}"`,
  ].join('\n');

  const lines = existing.split('\n');
  const replaced: string[] = [];
  const rest: string[] = [];
  let inCratesIo = false;
  let skippingMirror = false;
  let changed = false;
  let preserved = 0;

  for (const line of lines) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      if (inCratesIo && skippingMirror) {
        // 跳过旧的 [source.mirror] 整段（它由 sourceBlock 重建）。
        skippingMirror = false;
        inCratesIo = false;
        replaced.push(line);
        preserved += 1;
        continue;
      }
      const name = sectionMatch[1];
      if (name === 'source.crates-io') {
        inCratesIo = true;
        replaced.push(line);
        preserved += 1;
        continue;
      }
      if (name === 'source.mirror') {
        // 紧接着的 registry 行会被替换；本段后续内容跳过。
        skippingMirror = true;
        changed = true;
        continue;
      }
      inCratesIo = false;
      skippingMirror = false;
      rest.push(line);
      continue;
    }
    if (skippingMirror && /^\s*registry\s*=/.test(line)) continue;
    if (skippingMirror && /^\s*(replace-with|replace_with)\s*=/.test(line)) continue;
    if (inCratesIo && /^\s*(replace-with|replace_with)\s*=/.test(line)) {
      changed = true;
      continue;
    }
    if (inCratesIo) { preserved += 1; }
    replaced.push(line);
  }

  const keptReplaced = replaced.filter((l) => l.trim() !== '').join('\n');
  const keptRest = rest.filter((l) => l.trim() !== '').join('\n');
  const parts = [keptReplaced, sourceBlock, keptRest].filter((p) => p.trim() !== '');
  return { next: `${parts.join('\n\n')}\n`, changed: changed || keptReplaced === '', preservedLines: preserved };
}

/** 各生态 file 级写入的目标文件与「删键」定义。 */
export function fileTargetFor(
  ecosystem: Ecosystem,
  sourceUrl: string,
  homeDir: string,
): { path: string; key: string; value: string } {
  switch (ecosystem) {
    case 'npm': return { path: join(homeDir, '.npmrc'), key: 'registry', value: sourceUrl };
    case 'pip': return { path: join(homeDir, '.config', 'pip', 'pip.conf'), key: 'index-url', value: sourceUrl };
    case 'cargo': return { path: join(homeDir, '.cargo', 'config.toml'), key: 'source.crates-io.replace-with', value: 'mirror' };
    case 'go': return { path: join(homeDir, '.config', 'go', 'env'), key: 'GOPROXY', value: sourceUrl };
    case 'composer': return { path: join(homeDir, '.config', 'composer', 'config.json'), key: 'repositories.packagist', value: sourceUrl };
    case 'rubygems': return { path: join(homeDir, '.gemrc'), key: 'sources', value: sourceUrl };
    case 'huggingface': return { path: join(homeDir, '.huggingface', 'mirror.env'), key: 'HF_ENDPOINT', value: sourceUrl };
    case 'docker':
    case 'maven':
    case 'github':
      throw new Error('unsupported');
  }
}

/** 从 ini / npmrc 风格配置里读出某键的旧值；不存在返回 null。 */
export function readConfigValue(content: string, key: string): string | null {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() === key) return line.slice(idx + 1).trim();
  }
  return null;
}

// ── 主入口 ──

export interface SwitchDeps {
  fetchImpl?: typeof fetch;
  homeDir?: string;
  /** 文件读写（测试打桩用；默认走 node:fs）。 */
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, content: string) => void;
  /** journal 写入（测试打桩用）。 */
  journal?: (entry: JournalEntry) => { ok: boolean; path: string; error?: string };
}

const DEFAULT_FS: Required<Pick<SwitchDeps, 'readFile' | 'writeFile'>> = {
  readFile: (path) => {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  },
  writeFile: (path, content) => { mkdirSync(dirname(path), { recursive: true }); Bun.write(path, content); },
};

/**
 * 换源。默认 dry-run + session scope —— 「默认只产出环境变量映射，写真实配置
 * 文件必须显式要求」是产品边界，这里的默认值就是它的实现。
 */
export async function switchPackageSource(
  request: SwitchRequest,
  deps: SwitchDeps = {},
): Promise<SwitchResult> {
  const warnings: string[] = [];
  const scope: SwitchScope = request.scope ?? 'session';
  const dryRun = request.dryRun !== false;
  const homeDir = deps.homeDir ?? request.homeDir ?? homedir();
  const fs = { readFile: deps.readFile ?? DEFAULT_FS.readFile, writeFile: deps.writeFile ?? DEFAULT_FS.writeFile };
  const journal = deps.journal ?? ((entry: JournalEntry) => appendJournal(entry, homeDir));

  const ecosystemRaw = String(request.ecosystem ?? '').trim();
  if (!(ecosystemRaw in MIRROR_SOURCES)) {
    return {
      ok: false,
      reversible: true,
      warnings,
      error: `未知生态：${ecosystemRaw}。可用：${Object.keys(MIRROR_SOURCES).join(', ')}`,
    };
  }
  const ecosystem = ecosystemRaw as Ecosystem;
  const mirrors = MIRROR_SOURCES[ecosystem];

  // ── 选源 ──
  const requested = (request.source ?? 'auto').trim();
  const enabledTiers = request.enabledTiers ?? AUTO_TRUST_TIERS;
  const candidates = candidatesFor(ecosystem, { enabledTiers });
  let selected: MirrorSource | undefined;
  let benchmark: BenchmarkResult[] | undefined;

  if (requested === 'auto') {
    benchmark = await benchmarkSources(ecosystem, candidates, {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(request.benchmarkPaths?.[ecosystem] ? { path: request.benchmarkPaths[ecosystem] as string } : {}),
      enabledTiers,
    });
    const best = pickBest(benchmark, candidates);
    if (best && best.ok) {
      selected = candidates.find((c) => c.url === best.url);
      // 防御性：bench 结果与候选集必须同源，否则「选中的源」可能根本不在
      // 受信任清单里（那正是 t2 静默混入的路径）。
      if (!selected) {
        warnings.push('测速结果与候选集不匹配，回落为生态默认首选');
        selected = undefined;
      }
    }
    if (!selected) {
      const first = candidates[0];
      if (first) {
        selected = first;
        warnings.push(`所有候选源测速均未拿到有效响应，回落为生态默认首选 ${first.url}——请用 diagnose_network 确认是本机网络问题还是源侧问题`);
      }
    }
  } else if (candidates.some((c) => c.url === requested)) {
    selected = candidates.find((c) => c.url === requested);
  } else if (candidates[0] && (requested === '' || requested === 'default')) {
    selected = candidates[0];
  } else {
    // 手工 URL 不在清单内：允许，但必须显式说明信任层级未知。
    const t0 = requested.replace(/^sparse\+/, '');
    let parsedOk = true;
    try { new URL(t0); } catch { parsedOk = false; }
    if (!parsedOk) {
      return { ok: false, reversible: true, warnings, error: `source 必须是合法 URL（收到：${requested}）` };
    }
    selected = { url: requested, trust: 't3', notes: '用户手工指定，不在受信任清单内；未做来源核验' };
    // 用户显式点名某个 URL **本身就是这一次的显式选择**，不是「系统偷偷选了
    // 一个来路不明的源」。所以 session 档放行（进程退出即消失，可回退性最高）；
    // 但 file 档要落盘、会长期影响该用户所有项目，因此仍需设置里开启 t3。
    if (scope !== 'session') {
      return {
        ok: false,
        ecosystem,
        scope,
        dryRun,
        reversible: true,
        warnings,
        error: 'file 级写入不接受清单外的自配源：请先在设置里显式开启 T3 信任分层，或改用 session 档（不落盘、进程退出即消失）。',
      };
    }
    warnings.push('该源不在受信任清单内，按 T3 用户自配处理：未核验运营方，内容可被任意替换');
  }

  if (!selected) {
    return { ok: false, ecosystem, scope, dryRun, reversible: true, warnings, error: '没有可用候选源' };
  }

  // 名单内的 t2 源（公益代理）仍需设置里显式开启：模型可能因为「它更快」就
  // 顺手挑了一个，而用户从没听说过 ghfast.top。清单外的用户手写 URL 已在上面
  // 按 scope 分别处理（session 放行 / file 拒绝），不在这里重复拦截。
  const fromInventory = MIRROR_SOURCES[ecosystem].sources.some((s) => s.url === selected?.url);
  if (fromInventory && (selected.trust === 't2' || selected.trust === 't3') && !enabledTiers.includes(selected.trust)) {
    return {
      ok: false,
      ecosystem,
      scope,
      dryRun,
      reversible: true,
      warnings,
      error: `该源属 ${selected.trust} 信任分层（第三方公益代理 / 用户自配），默认关闭。请在设置里显式开启后再试；开启后下载二进制仍必须校验 sha256。`,
    };
  }
  if (selected.trust === 't2' || selected.trust === 't3') {
    warnings.push(`${selected.trust} 源已由你显式指定：无 SLA、响应体可被任意替换。下载任何二进制后必须校验 sha256。`);
  }

  // warnings 用**活引用**而不是快照：后续各分支还会往 warnings 里 push，
// 快照会让那些警告在返回值里凭空消失（测试抓到过：docker 的 daemon.json
// 说明与 npm 的 lockfile 陷阱都没进返回值）。
const base: SwitchResult = {
    ok: true,
    ecosystem,
    scope,
    dryRun,
    source: { url: selected.url, trust: selected.trust, ...(selected.operator ? { operator: selected.operator } : {}), ...(selected.notes ? { notes: selected.notes } : {}) },
    reversible: true,
    ...(benchmark ? { benchmark } : {}),
    warnings,
  };

  // ── S1：会话级环境变量 ──
  if (scope === 'session') {
    const env = sessionEnvFor(ecosystem, selected.url);
    const advice = commandAdviceFor(ecosystem, selected.url);
    if (Object.keys(env).length === 0) {
      warnings.push(`${mirrors.displayName} 没有环境变量换法：已改为给出命令/配置建议，不做任何注入`);
    }
    if (ecosystem === 'npm') {
      warnings.push('npm lockfile 陷阱：package-lock.json 里每个包固化了 resolved 完整 URL。换源前生成的 lockfile 会让 npm ci 继续走老 URL——必须重新生成 lockfile，或用 npm install --registry=<url> 单次指定，否则「换源了但还是很慢」。');
    }
    if (ecosystem === 'pip') {
      warnings.push('影响该用户的所有 Python 项目（不只是当前目录）；绝不要改用 extra-index-url，pip 官方明确警告它会引入依赖混淆。');
    }
    if (ecosystem === 'go') {
      warnings.push('GOPROXY 已补 ,direct 回退：代理全挂时回落到 VCS 直连（慢但不会彻底失败）。');
    }
    if (ecosystem === 'docker') {
      warnings.push(mirrors.fileScopeBlockedReason ?? '');
    }
    const summaryLines = [
      `${dryRun ? '[dry-run] ' : ''}会话级换源：${mirrors.displayName} → ${selected.url}`,
      Object.keys(env).length > 0
        ? `注入以下环境变量（仅本进程及子进程，不落盘，进程退出即消失）：${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('  ')}`
        : '无可注入的环境变量。',
      advice.length > 0 ? `建议命令：${advice.join('  |  ')}` : '',
      '未写入任何文件；未 spawn 任何命令。',
    ].filter(Boolean);
    return { ...base, sessionEnv: env, summary: summaryLines.join('\n') };
  }

  // ── file 级 ──
  if (!fileScopeAllowed(ecosystem)) {
    return {
      ...base,
      ok: false,
      warnings,
      error: mirrors.fileScopeBlockedReason ?? '该生态不支持 file 级写入',
    };
  }
  if (!request.confirm) {
    return {
      ...base,
      ok: false,
      warnings,
      error: 'file 级写入需要用户显式批准（confirm:true）并去掉 dry_run。未做任何改动。',
    };
  }

  const target = fileTargetFor(ecosystem, selected.url, homeDir);
  const previousContent = fs.readFile(target.path);
  const fileExisted = previousContent !== null;
  const previousValue = fileExisted ? readConfigValue(previousContent, target.key) : null;
  const undo: FileWritePlan['undo'] = fileExisted
    ? { kind: 'delete-key', key: target.key }
    : { kind: 'delete-file' };
  const undoCommand = fileExisted
    ? `sed -i.bak '/^${target.key.replace(/[.[\]/\\]/g, '\\$&')}=/d' ${shellQuote(target.path)}`
    : `rm ${shellQuote(target.path)}`;

  const journalEntry: JournalEntry = {
    ts: Date.now(),
    kind: 'source_switch',
    ecosystem,
    scope: 'file',
    path: target.path,
    undo,
    undoCommand,
    previousValue,
    newValue: target.value,
    ...(fileExisted ? { previousContent } : {}),
    fileExisted,
    dryRun,
  };
  const journalResult = journal(journalEntry);

  if (dryRun) {
    // dry-run 也记 journal：回放「谁在什么时候打算改」与「真的改了」同样重要，
    // 且 dry_run:true 让回放端能区分二者。
    return {
      ...base,
      files: [{
        path: target.path,
        previousContent: previousContent ?? '',
        previousValue,
        fileExisted,
        newValue: target.value,
        nextContent: ecosystem === 'cargo' && previousContent !== null
          ? buildCargoConfig(previousContent, selected.url).next
          : `${target.key}=${target.value}\n`,
        undo,
        undoCommand,
      }],
      undoCommand,
      warnings: [
        ...base.warnings,
        `journal 已记录到 ${journalResult.path}${journalResult.ok ? '' : `（写入失败：${journalResult.error ?? '未知'}）——此时不要执行实际写入`}`,
      ],
      summary: [
        `[dry-run] file 级换源：${mirrors.displayName} → ${selected.url}`,
        `目标文件：${target.path}（${fileExisted ? '已存在' : '将新建'}）`,
        `旧值：${previousValue ?? '（此前未配置）'}`,
        `新值：${target.value}`,
        `回滚语义：${undo.kind === 'delete-key' ? `删除 ${target.key} 键` : '删除整个文件'}（不是把上游 URL 写回去——原值本来就没配过）`,
        `回滚命令：${undoCommand}`,
      ].join('\n'),
    };
  }

  // journal 必须先于写入落盘：写完再记，一旦进程死在中间就没有回滚依据。
  if (!journalResult.ok) {
    return {
      ...base,
      ok: false,
      warnings,
      error: `journal 写入失败（${journalResult.error ?? '未知'}），已放弃写入：没有回滚依据就不允许改动配置文件。`,
    };
  }

  let nextContent: string;
  let preservedLines = 0;
  if (ecosystem === 'cargo') {
    const built = buildCargoConfig(previousContent ?? '', selected.url);
    nextContent = built.next;
    preservedLines = built.preservedLines;
    warnings.push(`cargo：原文件其他配置已保留（${preservedLines} 行）——整体覆写会静默丢掉 [build] rustflags 之类的设置，这是必须绕开的缺陷。`);
  } else if (ecosystem === 'composer') {
    // composer 的配置是 JSON，不能用 ini 拼行：读出全文改 repositories.packagist。
    let parsed: Record<string, unknown> = {};
    if (previousContent) {
      try { parsed = JSON.parse(previousContent) as Record<string, unknown>; }
      catch { return { ...base, ok: false, warnings, error: `无法解析 ${target.path} 的 JSON，未做任何改动（请手工修复后再试）` }; }
    }
    parsed['repositories'] = { packagist: sourceUrlForComposer(selected.url) };
    nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  } else {
    nextContent = previousContent && previousContent.trim() !== ''
      ? `${previousContent.replace(/\n*$/, '\n')}${target.key}=${target.value}\n`
      : `${target.key}=${target.value}\n`;
  }

  fs.writeFile(target.path, nextContent);

  const advice = commandAdviceFor(ecosystem, selected.url);
  return {
    ...base,
    files: [{
      path: target.path,
      previousContent: previousContent ?? '',
      previousValue,
      fileExisted,
      nextContent,
      newValue: target.value,
      undo,
      undoCommand,
    }],
    undoCommand,
    warnings: [
      ...warnings,
      `已写入 ${target.path}；journal：${journalResult.path}`,
      ...(advice.length > 0 ? [`建议：${advice.join('  |  ')}`] : []),
    ],
    summary: [
      `file 级换源完成：${mirrors.displayName} → ${selected.url}`,
      `目标文件：${target.path}`,
      `旧值：${previousValue ?? '（此前未配置）'}`,
      `新值：${target.value}`,
      `可回滚：是。回滚命令：${undoCommand}`,
      `journal：${journalResult.path}`,
    ].join('\n'),
  };
}

function sourceUrlForComposer(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}