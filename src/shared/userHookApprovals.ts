// src/shared/userHookApprovals.ts
// Per-hook approval store for user hooks — the "always allow" cache behind the
// permission gate. Lives beside hooks.json as <dir>/hooks-approved.json, keyed
// by SHA-256 of the command text: editing a command invalidates its old
// approval instead of riding on it. Node-only I/O (the CLI is the only v1
// consumer); saves are best-effort and a corrupt file degrades to empty.

import { createHash } from 'node:crypto';

export interface UserHookApprovalRecord {
  command: string;
  approvedAt: number;
}

interface UserHookApprovalFile {
  version: 1;
  approvals: Record<string, UserHookApprovalRecord>;
}

export interface HookApprovalStore {
  isApproved(command: string): boolean;
  /** Persist "always allow" (best-effort; never throws). */
  approve(command: string): void;
}

/** SHA-256 of the exact command text — the approval granularity. */
export function hookApprovalKey(command: string): string {
  return createHash('sha256').update(command, 'utf8').digest('hex');
}

function emptyFile(): UserHookApprovalFile {
  return { version: 1, approvals: {} };
}

async function readFile(dir: string | null | undefined): Promise<UserHookApprovalFile> {
  if (!dir) return emptyFile();
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = path.join(dir, 'hooks-approved.json');
    if (!fs.existsSync(p)) return emptyFile();
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<UserHookApprovalFile>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.approvals !== 'object' || parsed.approvals === null) {
      return emptyFile();
    }
    const approvals: Record<string, UserHookApprovalRecord> = {};
    for (const [key, record] of Object.entries(parsed.approvals)) {
      if (typeof key !== 'string' || typeof record !== 'object' || record === null) continue;
      if (typeof record.command !== 'string' || typeof record.approvedAt !== 'number') continue;
      approvals[key] = { command: record.command, approvedAt: record.approvedAt };
    }
    return { version: 1, approvals };
  } catch {
    return emptyFile();
  }
}

export async function loadHookApprovals(dir: string | null | undefined): Promise<HookApprovalStore> {
  const file = await readFile(dir);
  return {
    isApproved(command: string): boolean {
      return Boolean(file.approvals[hookApprovalKey(command)]);
    },
    approve(command: string): void {
      const key = hookApprovalKey(command);
      if (file.approvals[key]) return;
      file.approvals[key] = { command, approvedAt: Date.now() };
      // Best-effort persist; an unwritable store must not break the hook flow.
      void (async () => {
        try {
          const fs = await import('node:fs');
          const path = await import('node:path');
          if (dir) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const p = path.join(dir, 'hooks-approved.json');
            const temporaryPath = `${p}.tmp-${process.pid}`;
            fs.writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
            fs.renameSync(temporaryPath, p);
          }
        } catch {
          /* persistence is best-effort; the session keeps the in-memory approval */
        }
      })();
    },
  };
}
