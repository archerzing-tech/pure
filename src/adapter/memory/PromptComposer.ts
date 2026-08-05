// src/adapter/memory/PromptComposer.ts
// v0.10 — per Adapter Layer 设计文档 §12.4: composes the system prompt template
// with memories retrieved from the IMemoryStore. Memories are injected into the
// <session_memory> section (system-prompt.md). When the template has no such
// section, the memory block is appended as-is so a base prompt still benefits.

export interface PromptComposeInput {
  template: string;
  memory?: {
    preferences: string[];
    errorPatterns: string[];
  };
  project?: string;
}

const SESSION_MEMORY_OPEN = '<session_memory>';
const SESSION_MEMORY_CLOSE = '</session_memory>';

export class PromptComposer {
  compose(input: PromptComposeInput): string {
    const { template, memory, project } = input;
    if (!memory || (memory.preferences.length === 0 && memory.errorPatterns.length === 0)) {
      return template;
    }

    const lines: string[] = [];
    if (project) lines.push(`Project: ${project}`);
    if (memory.preferences.length > 0) {
      lines.push('User preferences:');
      for (const p of memory.preferences) lines.push(`- ${p}`);
    }
    if (memory.errorPatterns.length > 0) {
      lines.push('Known error patterns:');
      for (const e of memory.errorPatterns) lines.push(`- ${e}`);
    }
    const block = lines.join('\n');
    const section = `${SESSION_MEMORY_OPEN}\n${block}\n${SESSION_MEMORY_CLOSE}`;

    const openIdx = template.indexOf(SESSION_MEMORY_OPEN);
    if (openIdx >= 0) {
      const closeIdx = template.indexOf(SESSION_MEMORY_CLOSE, openIdx);
      if (closeIdx >= 0) {
        return (
          template.slice(0, openIdx)
          + section
          + template.slice(closeIdx + SESSION_MEMORY_CLOSE.length)
        );
      }
    }
    return `${template}\n\n${section}`;
  }
}
