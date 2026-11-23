// src/cli_permission.ts
// v0.1 — Permission prompts for the CLI direct-harness path (P1-8).
// The GUI wires PermissionManager via a PermissionDialog; the terminal has no
// dialog, so this module renders a compact confirmation block (tool + risk +
// path + content preview) and reads y / a / n from stdin. Non-TTY runs
// (piped input, CI) auto-allow safe reads and deny writes — a write can never
// slip through without an explicit interactive confirmation.
// Kept out of src/cli.ts so tests can import these pure helpers without
// triggering the CLI's module-level `main()` side effect.

import * as readline from 'node:readline';
import type { PermissionDecision, PermissionRequestHandler, PermissionRequestInfo } from './coding-agent/types';
import { hookApprovalKey, type HookApprovalStore } from './shared/userHookApprovals';
import type { UserHookGate } from './shared/userHookRunner';
import type { UserHook, UserHookEvent } from './shared/userHooks';
import { bold, cyan, dim, green, magenta, red, yellow } from './termcolors';
import { isVerificationCommand } from './shared/delivery';

/**
 * Render the confirmation block shown before a permission-sensitive tool runs.
 * Pure (no I/O) so it can be unit-tested.
 */
export function formatPermissionRequest(info: PermissionRequestInfo): string {
  const lines: string[] = [];
  lines.push(`  ${magenta('🔐')} ${cyan(info.tool)} ${dim('—')} ${dim(info.description)}`);
  lines.push(`    ${dim('Risk:')} ${riskColor(info.dangerLevel)}`);
  if (info.command) lines.push(`    ${dim('Command:')} ${info.command}`);
  if (info.path) lines.push(`    ${dim('Path:')} ${info.path}`);
  if (info.contentPreview) {
    const rule = dim('─'.repeat(38));
    lines.push(`    ${rule}`);
    for (const raw of info.contentPreview.split('\n')) {
      lines.push(`    ${wrapLine(raw, 120)}`);
    }
    lines.push(`    ${rule}`);
  }
  return lines.join('\n') + '\n';
}

/** Cap a preview line so a 4000-char single-line write can't flood the terminal. */
function wrapLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Parse the user's answer to the permission prompt.
 * Returns null for unrecognized input (denied by default upstream).
 */
export function parsePermissionAnswer(raw: string): { allowed: boolean; remember: boolean } | null {
  const a = raw.trim().toLowerCase();
  if (a === 'y' || a === 'yes' || a === '是' || a === '允许') return { allowed: true, remember: false };
  if (a === 'a' || a === 'always' || a === '始终允许') return { allowed: true, remember: true };
  if (a === 'n' || a === 'no' || a === '否' || a === '拒绝') return { allowed: false, remember: false };
  return null;
}

/**
 * Non-interactive stdin (pipe/CI): safe reads auto-approve, everything that
 * would normally require a confirmation is denied. Exported for tests.
 */
export function nonTtyDecision(info: PermissionRequestInfo): PermissionDecision {
  if (info.dangerLevel === 'safe') {
    return { allowed: true, autoApproved: true, reason: 'non-interactive read (auto-approved)' };
  }
  // 措辞自解释（2026-10-10）：拒绝原因是「非交互环境无法确认」，不是「没有
  // 权限」——模型把上一版措辞转述成「没有权限了」，用户以为配置被改。
  return { allowed: false, reason: 'Non-interactive: this operation requires TTY confirmation (write/command; danger-level operations are never auto-approved).' };
}

/**
 * Create the CLI permission request handler. Interactive on a TTY, safe-denies
 * writes on piped stdin.
 *
 * `autoApprove`: `true` short-circuits every non-aborted call with
 * `{ allowed: true, autoApproved: true }` — **except** danger-level operations
 * (`dangerLevel === 'danger'`，不可逆/破坏性）：那一档永远落到交互门（TTY 确认
 * / 非 TTY 拒绝）。这是 2026-10-10 的立场修正：请求级风险评估不再关闭
 * autoApprove（那会把「做着做着突然没权限」暴露给用户），护栏换到操作分级
 * ——模型说这轮有风险只影响提示行，操作本身危不危险由 dangerLevel 说了算。
 *
 * The function-level default is `false` (interactive prompt / non-tty
 * safe-reads-only fallback) — deliberately the *safer* path, so a future
 * caller who forgets to pass the arg will be asked instead of silently
 * approving. The CLI passes `true` for ordinary requests when its default
 * auto-approve policy is active.
 */
/** 非交互授权里绝不放行的动作：写盘重定向之外，任何变更类命令都不算「项目自证」。 */
const DESTRUCTIVE_COMMAND_RE = /\b(?:rm|rmdir|mv|cp|dd|sudo|su|chmod|chown|kill|pkill|curl|wget|ssh|scp|nc|git\s+(?:push|reset|clean|checkout|restore|commit)|npm\s+(?:install|i|publish|ci)|bun\s+(?:add|install|remove)|pnpm\s+(?:add|install|remove)|yarn\s+(?:add|install)|pip3?\s+install|docker\s+)/i;
/** 管道后段只允许「读输出」的过滤器（tail/head/grep 一类的常规写法）。 */
const READ_ONLY_PIPE_RE = /^(?:\d+\s*)?(?:tail|head|grep|rg|cat|wc|sort|uniq|cut|tr|sed|awk|jq|column|nl|echo|true|false|date)\b/i;

/**
 * 这条命令是否属于「本次运行已授权的项目自证」（2026-11-23 一次性 CLI 判例）：
 * 非交互模式没有 TTY，命令一律拿不到确认，修复类任务因此只剩「手算」这一条
 * 路——模型的结论没被任何一次真实执行验证过，还会把「手算通过」当成交付证据。
 *
 * 授权边界与交付闸一致：第一段必须是 test / typecheck / build / lint 这类项目
 * 自己的验收入口；后续管道段只能是读输出的过滤器；出现写盘重定向，或 rm / mv /
 * git push / 安装类动作，一律不授权（那些不是自证，是变更）。
 */
export function isAuthorizableVerificationCommand(command: string): boolean {
  // 2>&1 / 2>/dev/null 是读输出的常规写法，先摘掉再判重定向。
  const cleaned = command.replace(/\d?>>?\s*(?:&\d|\/dev\/null)/g, ' ').trim();
  if (!cleaned) return false;
  if (/>>?/.test(cleaned)) return false;
  const segments = cleaned.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  if (!isVerificationCommand(segments[0])) return false;
  if (segments.some((s) => DESTRUCTIVE_COMMAND_RE.test(s))) return false;
  // 后段允许两类：项目自己的又一条验证命令（`build && test`）、或读输出的过滤器。
  return segments.slice(1).every((s) => isVerificationCommand(s) || READ_ONLY_PIPE_RE.test(s));
}

export interface CliPermissionOptions {
  /** 非 TTY 下把项目自己的验证命令视为本次运行的授权（见 isAuthorizableVerificationCommand）。 */
  authorizeVerificationCommands?: boolean;
}

export function createCliPermissionHandler(autoApprove = false, options: CliPermissionOptions = {}): PermissionRequestHandler {
  return async (info: PermissionRequestInfo): Promise<PermissionDecision> => {
    // Already-aborted signal: addEventListener on an aborted signal never
    // fires, so without this the prompt would hang forever. Honored *before*
    // the auto-approve shortcut so Ctrl+C still cancels an in-flight tool call.
    if (info.signal?.aborted) return { allowed: false, reason: 'aborted by user' };

    // Ordinary CLI requests may trust the operator's prompt and approve every
    // tool call. Danger-level operations are the carve-out: the interactive
    // gate below still applies to them. Use `--prompt-on-tool` (handled in
    // cli.ts parseArgs) to opt into interactive confirmation for EVERY call.
    if (autoApprove && info.dangerLevel !== 'danger') {
      return { allowed: true, autoApproved: true, reason: 'CLI auto-approve (operator reviewed the prompt)' };
    }

    if (!process.stdin.isTTY) {
      // 项目自证的确认路径：没有人在键盘前，但「跑一遍项目自己的测试」不需要
      // 人去批准什么新决定，它就是本次运行被要求做的事。模型发起的其他命令
      // 照旧落到 nonTtyDecision 的拒绝。
      if (options.authorizeVerificationCommands && info.command && isAuthorizableVerificationCommand(info.command)) {
        return { allowed: true, autoApproved: true, reason: 'non-interactive: project verification command (authorized for this run)' };
      }
      return nonTtyDecision(info);
    }

    // Leading newline separates the prompt from streamed token output (the
    // engine is blocked awaiting this decision, so nothing interleaves here).
    process.stdout.write('\n' + formatPermissionRequest(info));

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let aborted = false;
    const answer = await new Promise<string>(resolve => {
      const onAbort = () => {
        aborted = true;
        resolve('');
      };
      info.signal?.addEventListener('abort', onAbort, { once: true });
      rl.question(`  Allow? ${bold('y')}es / ${bold('n')}o / ${bold('a')}llow always (session): `, raw => {
        info.signal?.removeEventListener('abort', onAbort);
        resolve(raw);
      });
    });
    rl.close();

    process.stdout.write('\n');
    if (aborted) {
      // The run was cancelled (e.g. REPL Ctrl+C) while this prompt was pending.
      process.stdout.write(`  ${yellow('⏹')}  ${dim('Cancelled.')}\n`);
      return { allowed: false, reason: 'aborted by user' };
    }
    const parsed = parsePermissionAnswer(answer);
    if (!parsed) {
      process.stdout.write(`  ${yellow('⏹')}  ${dim('Invalid answer — denying.')}\n`);
      return { allowed: false, reason: 'invalid answer, denied' };
    }
    if (parsed.allowed) {
      process.stdout.write(`  ${green('✓')} ${parsed.remember ? dim('Allowed for this session.') : dim('Allowed once.')}\n`);
      return { allowed: true, remember: parsed.remember };
    }
    process.stdout.write(`  ${red('✗')} ${dim('Denied.')}\n`);
    return { allowed: false, reason: 'denied by user' };
  };
}

function riskColor(level: 'safe' | 'caution' | 'danger'): string {
  switch (level) {
    case 'safe': return green('safe');
    case 'caution': return yellow('caution');
    case 'danger': return red('danger');
  }
}

// ── User-hook approval gate (2.3) ──
// The same y/a/n flow as tool permissions, one layer earlier: before a hook
// from hooks.json runs for the first time, the user confirms it. `a` persists
// per command text in the approval store (~/.pure/hooks-approved.json); `y`
// lasts the session only. Editing a command changes its SHA-256 key and so
// re-prompts — an approval never transfers to different code.

export type HookApprovalAnswer = 'once' | 'always' | 'deny';

/** Same answer vocabulary as parsePermissionAnswer, mapped to hook outcomes. */
export function parseHookApprovalAnswer(raw: string): HookApprovalAnswer | null {
  const a = raw.trim().toLowerCase();
  if (a === 'y' || a === 'yes' || a === '是' || a === '允许') return 'once';
  if (a === 'a' || a === 'always' || a === '始终允许') return 'always';
  if (a === 'n' || a === 'no' || a === '否' || a === '拒绝') return 'deny';
  return null;
}

/** Render the first-enable confirmation block for a hook. Pure (no I/O). */
export function formatHookApprovalRequest(command: string, event: UserHookEvent): string {
  const lines: string[] = [];
  lines.push(`  ${magenta('🪝')} ${cyan(`hook:${event}`)} ${dim('—')} ${dim('first enable, approval required')}`);
  lines.push(`    ${dim('Command:')} ${wrapLine(command, 120)}`);
  return lines.join('\n') + '\n';
}

/**
 * CLI hook gate: approved ("always") or session-approved ("y") hooks run;
 * everything else prompts once per command. Non-TTY stdin cannot confirm a
 * first enable, so unapproved hooks are denied there (the run logs the skip).
 *
 * Checks are serialized behind one queue: parallel read-tool calls share a
 * stdin, and two concurrent readline interfaces would interleave their prompts.
 */
export function createCliHookGate(store: HookApprovalStore): UserHookGate {
  const sessionOnce = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  async function check(hook: UserHook, event: UserHookEvent): Promise<boolean> {
    const key = hookApprovalKey(hook.command);
    if (store.isApproved(hook.command) || sessionOnce.has(key)) return true;
    if (!process.stdin.isTTY) return false;

    process.stdout.write('\n' + formatHookApprovalRequest(hook.command, event));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(`  Allow this hook? ${bold('y')}es (this session) / ${bold('a')}lways / ${bold('n')}o: `, resolve);
    });
    rl.close();
    process.stdout.write('\n');

    const parsed = parseHookApprovalAnswer(answer);
    if (!parsed || parsed === 'deny') {
      process.stdout.write(`  ${red('✗')} ${dim('Hook denied — it will be skipped.')}\n`);
      return false;
    }
    if (parsed === 'always') {
      store.approve(hook.command);
      process.stdout.write(`  ${green('✓')} ${dim('Allowed always (cached per command).')}\n`);
    } else {
      sessionOnce.add(key);
      process.stdout.write(`  ${green('✓')} ${dim('Allowed for this session.')}\n`);
    }
    return true;
  }

  return {
    check(hook: UserHook, event: UserHookEvent): Promise<boolean> {
      const run = queue.then(() => check(hook, event));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
