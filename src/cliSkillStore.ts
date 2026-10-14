// src/cliSkillStore.ts
// E2.2 — CLI 侧的沉淀技能落盘：把 distill 产物写进 ~/.pure/skills/auto-<name>/
// SKILL.md（PURE_SKILLS_DIR 可覆盖，和 cliRepl 的 loadAppSkills 同一解析）。
// GUI 不用这里——桌面端走 Rust write_app_skill 命令，浏览器模式写不了盘。
// 目录名安全规则与 write_app_skill 对齐：单段安全字符，防路径逃逸。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PURE_DIR } from './cliConfig';
import type { DistilledSkill } from './shared/skillDistill';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;

export function skillsRootDir(): string {
  // 家目录口径收口（审计批 5⑤）：`HOME || ''` 在 Windows（USERPROFILE 而
  // 非 HOME）或无 HOME 的环境落到 `/.pure/skills`——写「成功」却永远没人
  // 读（cliRepl 的读取面用 os.homedir()）。cliConfig 的 HOME/PURE_DIR 已经
  // 是 `HOME || os.homedir()` 的正解口径，直接复用，写读同源不再分叉。
  const base = process.env.PURE_SKILLS_DIR?.trim() || PURE_DIR;
  return join(base, 'skills');
}

/** Write the skill file, returning the directory it landed in. Overwrites an
 *  existing auto-<name> — re-distilling the same procedure updates it. */
export function writeAutoSkillDir(skill: DistilledSkill, rootDir = skillsRootDir()): string {
  if (!NAME_RE.test(skill.name)) {
    throw new Error(`unsafe skill name: ${skill.name}`);
  }
  const dir = join(rootDir, skill.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skill.markdown, 'utf8');
  return dir;
}

// ── Install sidecar (.pure-skill.json) ──
// 版本戳的最小闭环：装技能时在技能目录里落一份 {source, hash, installedAt}，
// 重装同一名字时据此区分「同版本，不动」和「内容变了，覆盖并报旧→新」。
// 与 Rust write_app_skill 写的 sidecar 同名同形（GUI 工具路）。技能装载器
// （cliRepl/chat/Rust list_app_skills）只认目录里的 SKILL.md，这份旁挂文件
// 对它们不可见。

/** Sidecar file name — shared with Rust write_app_skill, keep in sync. */
export const SKILL_SIDECAR_NAME = '.pure-skill.json';

export interface SkillSidecar {
  /** Hub repo the skill came from (null when unknown, e.g. hand-installed). */
  source: string | null;
  /** skillContentHash of the instruction body (12 hex chars). */
  hash: string;
  /** Install time, ISO 8601 (Rust side writes RFC 3339 UTC — same shape). */
  installedAt: string;
}

/** Read a skill directory's install sidecar, null when absent or unreadable —
 *  a missing/corrupt record just means "no known previous version". */
export function readSkillSidecar(dir: string): SkillSidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SKILL_SIDECAR_NAME), 'utf8')) as Partial<SkillSidecar>;
    if (typeof parsed?.hash !== 'string' || !parsed.hash) return null;
    return {
      source: typeof parsed.source === 'string' && parsed.source ? parsed.source : null,
      hash: parsed.hash,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    };
  } catch {
    return null;
  }
}

/** Write (or overwrite) a skill directory's install sidecar. */
export function writeSkillSidecar(dir: string, sidecar: SkillSidecar): void {
  writeFileSync(join(dir, SKILL_SIDECAR_NAME), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
}
