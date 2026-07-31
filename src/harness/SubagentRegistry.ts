// src/harness/SubagentRegistry.ts
// v0.1 — Registry for subagent definitions. Exposes subagents as ToolDefinition[]
// so the parent LLM can dispatch them as tool calls.

import type { ToolDefinition } from '../shared/types';
import type { SubagentDefinition, SubagentRegistry } from '../coding-agent/types';

export class DefaultSubagentRegistry implements SubagentRegistry {
  private defs = new Map<string, SubagentDefinition>();

  register(def: SubagentDefinition): void {
    this.defs.set(def.name, def);
  }

  get(name: string): SubagentDefinition | undefined {
    return this.defs.get(name);
  }

  getAsTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const def of this.defs.values()) {
      tools.push({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
      });
    }
    return tools;
  }
}
