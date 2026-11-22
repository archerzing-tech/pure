// src/shared/verificationEntry.ts
// 项目验证入口探测（2026-11-22 编码回路刀 4）。
//
// 为什么是机械事实而不是又一段教学：模型每次都要自己猜「这个项目怎么跑测试」
// （npm test → 没有该脚本 → 换 bun test），猜错的那条红命令还进了转录。验证入口
// 在一个会话里几乎不变，读一次清单就是确定事实；把它摆到 envFacts 里，第一条
// 验证命令就能跑对。
//
// 只做「读出项目自己声明的入口」，不做判断：脚本名、命令体都原样来自清单文件，
// 不推断、不拼装项目没有的东西。没有可识别入口时返回 null，调用方零注入。

export interface VerificationManifestInput {
  /** 根目录清单文件的原始内容（未读到的留空）。 */
  packageJson?: string;
  pyproject?: string;
  cargoToml?: string;
  goMod?: string;
  makefile?: string;
  /** 根目录一级条目名，用于判断包管理器与 uv。 */
  rootEntries?: string[];
}

export interface VerificationEntry {
  /** 探测来源，进提示词让模型知道这条事实从哪来。 */
  source: string;
  /** 有序命令：类型检查在前，测试在后。 */
  commands: string[];
}

/** package.json scripts 里算「项目级验证」的脚本名，顺序即优先级。 */
const SCRIPT_ORDER = ['typecheck', 'type-check', 'check', 'test', 'tests', 'lint', 'build', 'verify', 'ci'] as const;

const TEST_SCRIPT = /^(?:test|tests)$/i;

function detectPackageManager(entries: string[]): string {
  const names = new Set(entries);
  if (names.has('bun.lock') || names.has('bun.lockb')) return 'bun';
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('yarn.lock')) return 'yarn';
  return 'npm';
}

function fromPackageJson(text: string, entries: string[]): VerificationEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const scripts = (parsed as { scripts?: unknown })?.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  const table = scripts as Record<string, unknown>;
  const pm = detectPackageManager(entries);
  const commands: string[] = [];
  for (const name of SCRIPT_ORDER) {
    if (typeof table[name] !== 'string' || !table[name]) continue;
    commands.push(`${pm} run ${name}`);
    if (commands.length >= 3) break;
  }
  return commands.length > 0 ? { source: 'package.json', commands } : null;
}

function fromPyProject(text: string, entries: string[]): VerificationEntry | null {
  const prefix = new Set(entries).has('uv.lock') ? 'uv run ' : '';
  const commands: string[] = [];
  // 只看配置块名，不解析 TOML——这些工具的配置节就是一个稳定信号。
  if (/^\s*\[tool\.mypy\]/m.test(text)) commands.push(`${prefix}mypy .`);
  if (/^\s*\[tool\.ruff\]/m.test(text)) commands.push(`${prefix}ruff check .`);
  if (/^\s*\[tool\.pytest/m.test(text) || /\bpytest\b/.test(text)) commands.push(`${prefix}pytest`);
  return commands.length > 0 ? { source: 'pyproject.toml', commands: commands.slice(0, 3) } : null;
}

function fromCargo(text: string): VerificationEntry | null {
  if (!/^\s*\[package\]/m.test(text) && !/^\s*\[workspace\]/m.test(text)) return null;
  return { source: 'Cargo.toml', commands: ['cargo test', 'cargo check'] };
}

function fromGoMod(text: string): VerificationEntry | null {
  if (!/^module\s+/m.test(text)) return null;
  return { source: 'go.mod', commands: ['go test ./...', 'go vet ./...'] };
}

function fromMakefile(text: string): VerificationEntry | null {
  const targets = ['test', 'check', 'lint'].filter((target) => new RegExp(`^${target}:`, 'm').test(text));
  return targets.length > 0
    ? { source: 'Makefile', commands: targets.map((target) => `make ${target}`) }
    : null;
}

/** 从已读到的清单内容里挑出验证入口；都没有就返回 null。 */
export function detectVerificationEntry(input: VerificationManifestInput): VerificationEntry | null {
  const entries = input.rootEntries ?? [];
  if (input.packageJson) {
    const found = fromPackageJson(input.packageJson, entries);
    if (found) return found;
  }
  if (input.pyproject) {
    const found = fromPyProject(input.pyproject, entries);
    if (found) return found;
  }
  if (input.cargoToml) {
    const found = fromCargo(input.cargoToml);
    if (found) return found;
  }
  if (input.goMod) {
    const found = fromGoMod(input.goMod);
    if (found) return found;
  }
  if (input.makefile) {
    const found = fromMakefile(input.makefile);
    if (found) return found;
  }
  return null;
}

/**
 * envFacts 里的一段事实。措辞只做两件事：说明命令来自哪个清单、点出「猜一条
 * 不在表里的命令」是白跑。绿色判据与 shared/stopAtGreen.ts 同口径（整项目
 * 跑完 exit 0），不在这里重复解释全量/局部的区别。
 */
export function formatVerificationEntry(entry: VerificationEntry): string {
  const shown = entry.commands.map((command) => `\`${command}\``).join(', ');
  const hasTest = entry.commands.some((command) => /(?:^|\s)(?:test|pytest)\b/i.test(command));
  return `<project_verification>
Detected from ${entry.source}: ${shown}.
Run these as-is instead of guessing a command this project does not declare${hasTest ? '; green means the whole-project test run exits 0' : ''}.
</project_verification>`;
}
