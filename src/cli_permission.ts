// src/cli_permission.ts
// v0.1 — Permission prompts for the CLI direct-harness path (P1-8).
// The GUI wires PermissionManager via a PermissionDialog; the terminal has no
// dialog, so this module renders a compact confirmation block (tool + risk +
// path + content preview) and reads y / a / n from stdin. Non-TTY runs
// (piped input, CI) auto-allow safe reads and deny writes — a write can never
// slip through without an explicit interactive confirmation.
//
// Kept out of src/cli.ts so tests can import these pure helpers without
// triggering the CLI's module-level `main()` side effect.

import * as readline from 'node:readline';
import type { PermissionDecision, PermissionRequestHandler, PermissionRequestInfo } from './coding-agent/types';
import { bold, cyan, dim, green, magenta, red, yellow } from './termcolors';

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
  return { allowed: false, reason: 'Non-interactive: write/command requires a TTY confirmation' };
}

/**
 * Create the CLI permission request handler. Interactive on a TTY, safe-denies
 * writes on piped stdin.
 */
export function createCliPermissionHandler(): PermissionRequestHandler {
  return async (info: PermissionRequestInfo): Promise<PermissionDecision> => {
    if (!process.stdin.isTTY) return nonTtyDecision(info);

    // Already-aborted signal: addEventListener on an aborted signal never
    // fires, so without this the prompt would hang forever.
    if (info.signal?.aborted) return { allowed: false, reason: 'aborted by user' };

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
