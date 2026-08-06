// src/harness/__tests__/StreamManager.test.ts
// The CLI's final answer streams through StreamManager; each TokenDelta is
// sanitized on entry so leaked ANSI/control bytes can never reach the terminal.

import { describe, expect, test } from 'bun:test';
import { StreamManager } from '../StreamManager';

function makeEvent(content: string, isToolCall = false) {
  return {
    type: 'TokenDelta' as const,
    timestamp: Date.now(),
    payload: { content, isToolCall, stateId: 'test' },
  };
}

test('sanitizes ANSI escape sequences out of streamed answer content', () => {
  const chunks: string[] = [];
  const mgr = new StreamManager((c) => chunks.push(c), { maxBufferSize: 1 });
  mgr.start();
  mgr.feed(makeEvent('answer \x1b[31mred\x1b[0m text'));
  mgr.stop();
  expect(chunks.join('')).toBe('answer red text');
});

test('strips control characters and carriage returns from answers', () => {
  const chunks: string[] = [];
  const mgr = new StreamManager((c) => chunks.push(c), { maxBufferSize: 1 });
  mgr.start();
  mgr.feed(makeEvent('over\x08\x08write\ra\rb'));
  mgr.stop();
  // backspaces + CRs stripped; the visible letters stay in order
  expect(chunks.join('')).toBe('overwriteab');
});

test('keeps newlines and tabs so markdown/code formatting survives', () => {
  const chunks: string[] = [];
  const mgr = new StreamManager((c) => chunks.push(c), { maxBufferSize: 1 });
  mgr.start();
  mgr.feed(makeEvent('line1\nline2\tindented\n'));
  mgr.stop();
  expect(chunks.join('')).toBe('line1\nline2\tindented\n');
});

test('handles an escape sequence split across two deltas safely', () => {
  const chunks: string[] = [];
  const mgr = new StreamManager((c) => chunks.push(c), { maxBufferSize: 1 });
  mgr.start();
  mgr.feed(makeEvent('a\x1b'));   // lone ESC — C0 strip removes it immediately
  mgr.feed(makeEvent('[31mb'));   // remainder can only be literal text
  mgr.stop();
  expect(chunks.join('')).toBe('a[31mb');
});

test('skips tool-call deltas entirely (never written to the terminal)', () => {
  const chunks: string[] = [];
  const mgr = new StreamManager((c) => chunks.push(c), { maxBufferSize: 1 });
  mgr.start();
  mgr.feed(makeEvent('', true));
  mgr.stop();
  expect(chunks).toEqual([]);
});
