import { promptAssembler, type PromptBudgetConfig } from '../../shared/PromptAssembler';
import type { ToolDefinition } from '../../shared/types';

export interface PromptComposeInput {
  template: string;
  memory?: {
    preferences: string[];
    errorPatterns: string[];
    procedures?: string[];
  };
  project?: string;
  budget?: PromptBudgetConfig;
  toolDefinitions?: ToolDefinition[];
}

export class PromptComposer {
  compose(input: PromptComposeInput): string {
    return promptAssembler.composeMemoryPrompt({
      template: input.template,
      memory: input.memory
        ? { ...input.memory, project: input.project }
        : undefined,
      budget: input.budget,
      toolDefinitions: input.toolDefinitions,
    });
  }
}
