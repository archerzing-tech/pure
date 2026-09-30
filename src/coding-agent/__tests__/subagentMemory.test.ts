// P0-3（两柱焊点）— 子代理记忆注入纯核的覆盖：分组定容、防幻觉过滤、
// 检索降级、归因对齐。编排器层的装配（开关门、prompt 拼接）在
// SubagentOrchestrator.test.ts。
import { describe, expect, it } from 'bun:test';
import {
  formatDelegationMemoryBlock,
  retrieveDelegationMemory,
  SUBAGENT_MEMORY_K,
  SUBAGENT_MEMORY_MAX_CHARS,
} from '../subagentMemory';
import type { IMemoryStore, MemoryEntry, MemoryType } from '../../shared/types';

function entry(id: string, type: MemoryType, content: string, confidence?: 'low' | 'high'): MemoryEntry {
  return {
    id,
    type,
    content,
    confidence,
    timestamp: Date.now(),
    sessionId: 's',
    projectPath: '/ws',
  };
}

/** 只实现被测路径需要的 search；其余方法抛错以防误用（本测试不写库）。 */
function fakeStore(results: MemoryEntry[], seen?: { query?: string; k?: number; projectPath?: string }): IMemoryStore {
  return {
    add: async () => { throw new Error('not under test'); },
    search: async (query, opts) => {
      seen!.query = query;
      seen!.k = opts?.k;
      seen!.projectPath = opts?.projectPath;
      return results;
    },
    list: () => { throw new Error('not under test'); },
    forget: async () => { throw new Error('not under test'); },
    removeById: async () => { throw new Error('not under test'); },
    decay: async () => { throw new Error('not under test'); },
    recordHits: async () => { throw new Error('not under test'); },
  };
}

describe('formatDelegationMemoryBlock (P0-3)', () => {
  it('groups worker-relevant entries with per-group caps', () => {
    const block = formatDelegationMemoryBlock([
      entry('p1', 'procedure', 'playbook one'),
      entry('p2', 'procedure', 'playbook two'),
      entry('p3', 'procedure', 'playbook three'), // 超 2 条上限
      entry('e1', 'error_pattern', 'trap one'),
      entry('s1', 'successful_pattern', 'proven approach'),
      entry('t1', 'tool_preference', 'use node 22 here'),
    ]);
    expect(block).toContain('<delegated_task_memory>');
    expect(block).toContain('playbook one');
    expect(block).toContain('playbook two');
    expect(block).not.toContain('playbook three'); // procedure 组封顶 2
    expect(block).toContain('trap one');
    expect(block).toContain('proven approach');
    expect(block).toContain('use node 22 here');
  });

  it('drops low-confidence lessons and parent-identity types; dedupes identical content', () => {
    const block = formatDelegationMemoryBlock([
      entry('l1', 'procedure', 'hallucinated lesson', 'low'), // E1.1：无证据不注入
      entry('u1', 'user_preference', 'wants concise replies'), // 父会话身份层
      entry('c1', 'project_convention', 'use pnpm'), // 同上
      entry('p1', 'procedure', 'same playbook'),
      entry('p2', 'procedure', 'same playbook'), // 内容去重
    ]);
    expect(block).not.toContain('hallucinated lesson');
    expect(block).not.toContain('concise replies');
    expect(block).not.toContain('use pnpm');
    expect(block.match(/same playbook/g)?.length).toBe(1);
  });

  it('returns empty string when nothing qualifies (caller appends nothing)', () => {
    expect(formatDelegationMemoryBlock([])).toBe('');
    expect(formatDelegationMemoryBlock([entry('l1', 'procedure', 'x', 'low')])).toBe('');
  });

  it('enforces the hard char cap by dropping whole lines', () => {
    const long = 'x'.repeat(600);
    const block = formatDelegationMemoryBlock([
      entry('p1', 'procedure', long),
      entry('p2', 'procedure', `${long}-2`),
      entry('p3', 'procedure', `${long}-3`),
      entry('e1', 'error_pattern', `${long}-4`),
    ]);
    expect(block.length).toBeLessThanOrEqual(SUBAGENT_MEMORY_MAX_CHARS + 200 /* 包裹行开销 */);
    expect(block).not.toContain(`${long}-4`); // 超限即整条让位，不做半行截断
  });
});

describe('retrieveDelegationMemory (P0-3)', () => {
  it('searches with the delegation scope and reports only ids that made the block', async () => {
    const seen: { query?: string; k?: number; projectPath?: string } = {};
    const store = fakeStore([
      entry('p1', 'procedure', 'playbook'),
      entry('u1', 'user_preference', 'identity-layer'),
    ], seen);
    const out = await retrieveDelegationMemory({ store, query: 'researcher: look into X', projectPath: '/ws' });
    expect(seen.query).toBe('researcher: look into X');
    expect(seen.k).toBe(SUBAGENT_MEMORY_K);
    expect(seen.projectPath).toBe('/ws');
    expect(out.block).toContain('playbook');
    expect(out.entryIds).toEqual(['p1']); // 归因与模型实际看到的对齐
  });

  it('degrades to no injection when the search is slow (timeout wins the race)', async () => {
    const slow: IMemoryStore = {
      ...fakeStore([]),
      search: () => new Promise<MemoryEntry[]>(() => { /* never resolves */ }),
    };
    const out = await retrieveDelegationMemory({ store: slow, query: 'q', timeoutMs: 5 });
    expect(out).toEqual({ block: '', entryIds: [] });
  });

  it('degrades to no injection when the search throws', async () => {
    const broken: IMemoryStore = {
      ...fakeStore([]),
      search: async () => { throw new Error('store down'); },
    };
    const out = await retrieveDelegationMemory({ store: broken, query: 'q' });
    expect(out).toEqual({ block: '', entryIds: [] });
  });
});
