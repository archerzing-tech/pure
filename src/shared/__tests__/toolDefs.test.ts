// src/shared/__tests__/toolDefs.test.ts
// Tool-table consistency. The `satisfies`/`Record` guards already make a
// missing TOOL_TAGS or TOOL_METADATA_TABLE entry a compile error; this file
// locks the tables typecheck cannot see: PUBLIC_TOOL_NAMES is a plain runtime
// Set (a missing name would silently hide the tool from every model), and the
// git write classification is the behavior the pre-commit confirmation and
// command guard build on.

import { describe, expect, it } from 'bun:test';
import { BUILT_IN_TOOL_DEFS, PUBLIC_TOOL_NAMES, TOOL_METADATA } from '../toolDefs';
import { BUILT_IN_TOOLS } from '../../coding-agent/ToolRegistry';

describe('tool table consistency', () => {
  // Deliberately hidden legacy tools, curated when PUBLIC_TOOL_NAMES was
  // introduced (v1.9.2-beta7): web_search/web_fetch are compatibility aliases
  // kept for old transcripts, and search_files was superseded by
  // code_searcher + find_files. Anything else missing from the Set is a bug —
  // the model would see the schema nowhere and calls would die as unknown.
  const DELIBERATELY_HIDDEN = new Set(['web_search', 'web_fetch', 'search_files']);

  it('every built-in def is public — otherwise the model never sees it', () => {
    for (const def of BUILT_IN_TOOL_DEFS) {
      if (DELIBERATELY_HIDDEN.has(def.name)) continue;
      expect(PUBLIC_TOOL_NAMES.has(def.name)).toBe(true);
    }
  });

  it('every built-in def has side-effect metadata', () => {
    for (const def of BUILT_IN_TOOL_DEFS) {
      expect(TOOL_METADATA[def.name]).toBeDefined();
    }
  });

  it('BUILT_IN_TOOLS fuses every schema with its permission tags 1:1', () => {
    expect(BUILT_IN_TOOLS.length).toBe(BUILT_IN_TOOL_DEFS.length);
    // Runtime net under the compiler guard: a fused tool without tags/riskLevel
    // would silently skip the permission gate's write classification.
    for (const tool of BUILT_IN_TOOLS) {
      expect(tool.tags.length).toBeGreaterThan(0);
      expect(tool.riskLevel).toBeDefined();
    }
  });

  it('git write tools are classified as confirmed writes, not silent reads', () => {
    for (const name of ['git_commit', 'git_branch']) {
      expect(TOOL_METADATA[name]?.isWrite).toBe(true);
      expect(TOOL_METADATA[name]?.sideEffects).toBe(true);
      const tagged = BUILT_IN_TOOLS.find((t) => t.name === name);
      expect(tagged?.riskLevel).toBe('medium');
      expect(tagged?.tags).toContain('write');
    }
  });
});
