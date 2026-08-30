// src/coding-agent/defaultHarnessConfig.ts
// Both entrypoints assemble the same "default Harness plumbing": a ContextEngine
// (20-message window, maxTokens sized from the prompt budget), the rule-based
// default verifier, an empty default hook router, and the escalating default
// failure policy. The CLI builds Harness directly (cliHarness.ts) and the GUI
// goes through CodingAgent — without a shared factory these four pieces lived
// in two places and could drift apart. This is the single source for the
// defaults.
import { ContextEngine } from '../harness/ContextEngine';
import { DefaultHookRouter } from '../engine/HookRouter';
import { DefaultFailurePolicy } from '../engine/FailurePolicy';
import { Verifier, createDefaultVerifier } from './Verifier';
import { resolvePromptBudget } from '../shared/PromptAssembler';
import type { PromptBudgetConfig } from '../shared/providers';
import type { LLMAdapter, ToolDefinition, FailurePolicy, HookRouter } from '../shared/types';

export interface DefaultHarnessPlumbing {
  contextEngine: ContextEngine;
  verifier: Verifier;
  hooks: HookRouter;
  failurePolicy: FailurePolicy;
}

export interface DefaultHarnessConfigOptions {
  llm: LLMAdapter;
  /** Optional — resolvePromptBudget falls back to the built-in defaults. */
  promptBudget?: PromptBudgetConfig;
  /** Resolves the model-visible tool list lazily (after MCP/subagents register). */
  toolsProvider: () => ToolDefinition[];
}

export function createDefaultHarnessConfig(options: DefaultHarnessConfigOptions): DefaultHarnessPlumbing {
  return {
    contextEngine: new ContextEngine({
      maxMessages: 20,
      maxTokens: resolvePromptBudget(options.promptBudget).availableInputTokens,
      toolsProvider: options.toolsProvider,
      llm: options.llm,
    }),
    verifier: createDefaultVerifier(),
    hooks: new DefaultHookRouter(),
    failurePolicy: new DefaultFailurePolicy(),
  };
}
