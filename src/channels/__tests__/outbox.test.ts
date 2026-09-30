import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryOutbox } from '../outbox';
import type { ChannelSender, ChannelTarget, OutboundMessage } from '../types';

const target: ChannelTarget = { accountId: 'default', peerId: 'p1', peerKind: 'dm' };
const message: OutboundMessage = { kind: 'final', text: 'hi', final: true };

function senderWith(behaviour: (attempt: number) => void): { sender: ChannelSender; attempts: number[] } {
  const attempts: number[] = [];
  const sender: ChannelSender = {
    id: 'fake',
    async send() {
      attempts.push(attempts.length + 1);
      behaviour(attempts.length);
      return { messageId: 'm1' };
    },
  };
  return { sender, attempts };
}

describe('MemoryOutbox', () => {
  it('retries a failed send and reports delivery', async () => {
    const { sender, attempts } = senderWith((attempt) => {
      if (attempt < 3) throw new Error('temporary');
    });
    const outbox = new MemoryOutbox(() => sender, { sleep: async () => {}, log: () => {} });
    outbox.enqueue('fake', target, message);
    const result = await outbox.drain();
    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(attempts.length).toBe(3);
    expect(outbox.pendingCount).toBe(0);
  });

  it('abandons a message after the retry cap and keeps draining the rest', async () => {
    const bad: ChannelSender = { id: 'bad', async send() { throw new Error('nope'); } };
    const good: ChannelSender = { id: 'good', async send() { return { messageId: 'ok' }; } };
    const outbox = new MemoryOutbox((id) => (id === 'bad' ? bad : good), { maxAttempts: 2, sleep: async () => {}, log: () => {} });
    outbox.enqueue('bad', target, message);
    outbox.enqueue('good', target, message);
    const result = await outbox.drain();
    expect(result).toEqual({ delivered: 1, failed: 1 });
  });

  it('drops messages for a channel with no adapter', async () => {
    const outbox = new MemoryOutbox(() => undefined, { maxAttempts: 1, sleep: async () => {}, log: () => {} });
    outbox.enqueue('ghost', target, message);
    expect(await outbox.drain()).toEqual({ delivered: 0, failed: 1 });
  });

  it('reports pending count before draining', () => {
    const outbox = new MemoryOutbox(() => undefined, { log: () => {} });
    outbox.enqueue('a', target, message);
    outbox.enqueue('b', target, message);
    expect(outbox.pendingCount).toBe(2);
  });
});

describe('MemoryOutbox persistence and replay', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-outbox-'));
    path = join(dir, 'outbox.jsonl');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes queued messages to disk and replays them on the next process', async () => {
    const offline = new MemoryOutbox(() => undefined, { path, log: () => {} });
    offline.enqueue('fake', target, message);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);

    const sent: OutboundMessage[] = [];
    const sender: ChannelSender = { id: 'fake', async send(_t, m) { sent.push(m); return { messageId: 'm' }; } };
    const replayed = new MemoryOutbox(() => sender, { path, log: () => {} });
    expect(replayed.pendingCount).toBe(1);
    expect(await replayed.drain()).toEqual({ delivered: 1, failed: 0 });
    expect(sent[0].text).toBe('hi');
    // 投递后文件清空：不重复投递。
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('keeps only the undelivered entries after a partial drain', async () => {
    const first = new MemoryOutbox(() => undefined, { path, log: () => {} });
    first.enqueue('real', target, message);
    const realSender: ChannelSender = { id: 'real', async send() { return { messageId: 'm' }; } };
    const second = new MemoryOutbox((id) => (id === 'real' ? realSender : undefined), { path, log: () => {} });
    second.enqueue('ghost', target, { ...message, text: 'ghost' });
    const result = await second.drain();
    expect(result).toEqual({ delivered: 1, failed: 1 });
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('round-trips attachments through base64', async () => {
    const original = new MemoryOutbox(() => undefined, { path, log: () => {} });
    original.enqueue('fake', target, {
      kind: 'final',
      text: 'report',
      final: true,
      attachments: [{ name: 'r.txt', mimeType: 'text/plain', data: new Uint8Array([104, 105]) }],
    });
    const sent: OutboundMessage[] = [];
    const sender: ChannelSender = { id: 'fake', async send(_t, m) { sent.push(m); return { messageId: 'm' }; } };
    const replayed = new MemoryOutbox(() => sender, { path, log: () => {} });
    await replayed.drain();
    expect(sent[0].attachments?.[0].name).toBe('r.txt');
    expect(Buffer.from(sent[0].attachments![0].data).toString()).toBe('hi');
  });

  it('survives a corrupted outbox file by starting empty', () => {
    const corruptPath = join(dir, 'corrupt.jsonl');
    const seed = new MemoryOutbox(() => undefined, { path: corruptPath, log: () => {} });
    seed.enqueue('fake', target, message);
    writeFileSync(corruptPath, '{not json\n');
    const recovered = new MemoryOutbox(() => undefined, { path: corruptPath, log: () => {} });
    expect(recovered.pendingCount).toBe(0);
  });
});
