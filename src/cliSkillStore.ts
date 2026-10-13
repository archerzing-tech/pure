// src/cliSkillStore.ts
// E2.2 — CLI 侧的沉淀技能落盘：把 distill 产物写进 ~/.pure/skills/auto-<name>/
// SKILL.md（PURE_SKILLS_DIR 可覆盖，和 cliRepl 的 loadAppSkills 同一解析）。
// GUI 不用这里——桌面端走 Rust write_app_skill 命令，浏览器模式写不了盘。
// 目录名安全规则与 write_app_skill 对齐：单段安全字符，防路径逃逸。

import { mkdirSync, writeFileSync } from 'node:fs';
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
