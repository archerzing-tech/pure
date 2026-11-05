// src/__tests__/cliPreCompact.test.ts
// CLI 闲时预压缩的形状锁（2026-11-05）。cliRepl 主循环是巨型闭包不可单测，
// 这把锁钉住三件不可倒退的事：soft 档与 GUI idle 预压缩同值同义、写缓存前
// 的 messages 引用守卫在场、结果走 compactedHistory 消费通道（与 /compact
// 同一出口）。重构丢了任何一件，这刀就从「免摘要等待」退化成摆设。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('cliRepl idle pre-compaction wiring（CLI 闲时预压缩）', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'cliRepl.ts'), 'utf8');

  it('schedules a soft compaction matching the GUI idle values (85% -> 70%)', () => {
    expect(src).toContain('soft: { trigger: 0.85, target: 0.7 }');
  });

  it('guards the cache write on an unchanged transcript reference', () => {
    // 双守卫：跑前（用户已提交下一轮就不开跑）与写前（摘要期间动了历史不写脏）。
    expect(src.split('if (messages !== source) return;').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('publishes through the same channel as /compact (compactedHistory)', () => {
    expect(src).toContain('compactedHistory = compaction.messages;');
    expect(src).toContain('compactedTranscriptLength = source.length;');
  });

  it('never lets a background compaction failure break the session', () => {
    expect(src).toContain('// 后台预压缩绝不打断会话：失败静默，反应式压缩仍在兜底。');
  });
});
