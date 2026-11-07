// src/shared/__tests__/schemaQuarantineHeal.test.ts
// Schema 隔离摘除披露的处方器单测。模块级状态是进程全局（flaky-quartet
// 判例）：每用例读即清场，防跨文件顺序地雷。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  recordSchemaQuarantineEvent,
  resetSchemaQuarantineForTests,
  schemaQuarantineDetail,
  takeSchemaQuarantineFacts,
} from '../schemaQuarantineHeal';

beforeEach(() => resetSchemaQuarantineForTests());
afterEach(() => resetSchemaQuarantineForTests());

describe('schemaQuarantineHeal facts', () => {
  it('returns an empty string when nothing was recorded', () => {
    expect(takeSchemaQuarantineFacts()).toBe('');
  });

  it('takes the recorded drop as a fact row, then clears (read-is-consume)', () => {
    recordSchemaQuarantineEvent({ tool: 'rea__query', detail: "Invalid schema for tool 'rea__query': pattern \\0 rejected" });
    const facts = takeSchemaQuarantineFacts();
    expect(facts).toContain('"rea__query" was dropped from your tool list');
    expect(facts).toContain('rejected its schema twice');
    expect(facts).toContain('pattern \\0 rejected');
    expect(facts).toContain('what to do next is your call');
    expect(takeSchemaQuarantineFacts()).toBe('');
  });

  it('dedupes repeated drops of the same tool into one row', () => {
    recordSchemaQuarantineEvent({ tool: 'rea__query', detail: 'first' });
    recordSchemaQuarantineEvent({ tool: 'rea__query', detail: 'second' });
    const facts = takeSchemaQuarantineFacts();
    expect(facts).toContain('second'); // latest evidence wins
    expect(facts).not.toContain('first');
    expect(facts.match(/rea__query/g)).toHaveLength(1);
  });

  it('keeps distinct tools as separate rows and caps the ledger at 8', () => {
    for (let i = 0; i < 10; i++) recordSchemaQuarantineEvent({ tool: `tool_${i}`, detail: 'x' });
    const facts = takeSchemaQuarantineFacts();
    expect(facts).toContain('tool_9');
    expect(facts).not.toContain('tool_0'); // oldest evicted
  });

  it('schemaQuarantineDetail strips fences and newlines, then truncates', () => {
    // 真实形状：错误正文里围栏包的是 schema JSON 段，剥段不剥正文。
    const messy = `Invalid schema for tool 'x': \`\`\`{"pattern":"\\0"}\`\`\` rejected\n  by the strict validator  `;
    expect(schemaQuarantineDetail(messy)).toBe("Invalid schema for tool 'x': rejected by the strict validator");
    expect(schemaQuarantineDetail('a'.repeat(200))).toBe(`${'a'.repeat(160)}…`);
  });
});
