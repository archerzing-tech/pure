// src/shared/skillFiles.ts
// Parsing helpers for the app skills directory (~/.pure/skills/<name>/SKILL.md
// and the project's .agents/skills/<name>/SKILL.md). Skills installed there
// (manually, or by the agent following the capability-gap protocol) are
// injected into the system prompt like Skill Hub skills. Parsing is pure and
// shared: the CLI scans with node:fs, the desktop GUI scans via the Rust
// `list_app_skills` command (mirror of this logic in src-tauri/src/lib.rs).

export interface AppSkillFile {
  /** Skill id — the SKILL.md `name:` frontmatter field. */
  name: string;
  /** Short description from frontmatter (may be empty). */
  description: string;
  /** Full SKILL.md body (frontmatter stripped). */
  body: string;
}

/** Parse a SKILL.md file: YAML-ish frontmatter (`---\nname: …\ndescription:
 * …\n---`) followed by the instructions body. Returns null when the file has
 * no frontmatter or no usable name/body — such files are simply not skills. */
export function parseSkillMarkdown(text: string): AppSkillFile | null {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return null;
  const frontmatter = m[1];
  const body = m[2].trim();
  const name = frontmatter.match(/^name\s*:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = frontmatter.match(/^description\s*:\s*(.+)$/m)?.[1]?.trim() ?? '';
  if (!name || !body) return null;
  return { name, description, body };
}
