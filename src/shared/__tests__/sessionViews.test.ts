// src/shared/__tests__/sessionViews.test.ts
// 手机端「会话」总览/时间线的只读视图层：状态推导（running/settled/failed/idle）、
// 索引 ∪ 目录合并、尾读容错与路径注入防护。
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessionViews, readSessionTimeline } from '../node/sessionViews';

const dirs: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pure-sessionviews-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedIndex(pureDir: string, entries: Record<string, { sessionId: string; lastActivityAt: number; workspace: string | null }>): void {
  mkdirSync(join(pureDir, 'channels'), { recursive: true });
  writeFileSync(join(pureDir, 'channels', 'sessions.json'), JSON.stringify(entries));
}

function seedEvents(pureDir: string, sessionId: string, events: unknown[]): void {
  const dir = join(pureDir, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const input = (ts: number) => ({ ts, kind: 'user_input', actor: 'gateway', origin: { surface: 'qq', peer: 'qq:1' }, payload: { text: '在吗' } });
const settled = (ts: number, extra: object = {}) => ({ ts, kind: 'turn_settled', actor: 'gateway', payload: { totalMs: 4200, ...extra } });

describe('listSessionViews', () => {
  it('derives running/settled/failed/idle from the event tail and merges the index', () => {
    const pureDir = fixture();
    seedIndex(pureDir, {
      'qq:main:dm:qq:1': { sessionId: 'chan_1', lastActivityAt: 2000, workspace: '/w1' },
      'feishu:main:dm:fs:9': { sessionId: 'chan_2', lastActivityAt: 9000, workspace: null },
      'qq:main:dm:qq:2': { sessionId: 'chan_3', lastActivityAt: 1000, workspace: null },
    });
    // chan_1：输入后没有落定 → running。
    seedEvents(pureDir, 'chan_1', [input(1500)]);
    // chan_2：输入 → 落定 → settled（活动时刻取事件与索引的较大者）。
    seedEvents(pureDir, 'chan_2', [input(9500), settled(9700)]);
    // chan_3：索引里有、没有事件日志 → idle。
    // GUI 侧会话：不在索引里，只有目录 → surface gui。
    seedEvents(pureDir, 'session_gui1', [
      { ts: 5000, kind: 'user_input', actor: 'gui', payload: { text: '本地问一句' } },
      { ts: 6000, kind: 'turn_settled', actor: 'gui', payload: { totalMs: 900, failed: true, error: '引擎超时' } },
    ]);

    const views = listSessionViews(pureDir);
    expect(views.map((v) => v.sessionId)).toEqual(['chan_2', 'session_gui1', 'chan_1', 'chan_3']);

    const running = views.find((v) => v.sessionId === 'chan_1')!;
    expect(running.status).toBe('running');
    expect(running.surface).toBe('qq');
    expect(running.peer).toBe('qq:1');
    expect(running.workspace).toBe('/w1');
    // 活动时刻以日志事件为准（1500 > 索引 2000？否——取较大者）。
    expect(running.lastActivityAt).toBe(2000);

    const done = views.find((v) => v.sessionId === 'chan_2')!;
    expect(done.status).toBe('settled');
    expect(done.statusDetail).toContain('4.2s');
    expect(done.lastActivityAt).toBe(9700);

    const failed = views.find((v) => v.sessionId === 'session_gui1')!;
    expect(failed.status).toBe('failed');
    expect(failed.statusDetail).toContain('引擎超时');
    expect(failed.surface).toBe('gui');

    const idle = views.find((v) => v.sessionId === 'chan_3')!;
    expect(idle.status).toBe('idle');
  });

  it('tolerates a corrupt index and malformed event lines', () => {
    const pureDir = fixture();
    mkdirSync(join(pureDir, 'channels'), { recursive: true });
    writeFileSync(join(pureDir, 'channels', 'sessions.json'), '{ not json');
    seedEvents(pureDir, 'chan_1', [
      input(1000),
      '{ broken line',
      settled(2000),
    ]);
    const views = listSessionViews(pureDir);
    expect(views).toHaveLength(1);
    expect(views[0].status).toBe('settled');
  });

  it('ignores directory names outside the session id charset', () => {
    const pureDir = fixture();
    seedEvents(pureDir, 'chan_ok', [input(1000)]);
    // 注入形态的目录名：不存在于真实盘上，但存在也不能进视图。
    mkdirSync(join(pureDir, 'sessions', '..%2Fetc'), { recursive: true });
    writeFileSync(join(pureDir, 'sessions', '..%2Fetc', 'events.jsonl'), JSON.stringify(input(1000)));
    const views = listSessionViews(pureDir);
    expect(views.map((v) => v.sessionId)).toEqual(['chan_ok']);
  });
});

describe('readSessionTimeline', () => {
  it('projects the log into timeline entries and keeps order', () => {
    const pureDir = fixture();
    seedEvents(pureDir, 'chan_1', [input(1000), settled(2000, { failed: true, error: 'x' })]);
    const tl = readSessionTimeline(pureDir, 'chan_1');
    expect(tl).toHaveLength(2);
    expect(tl[0].summary).toContain('用户(qq)：在吗');
    expect(tl[1].summary).toContain('回合落定');
  });

  it('returns empty for unknown or hostile session ids', () => {
    const pureDir = fixture();
    seedEvents(pureDir, 'chan_1', [input(1000)]);
    expect(readSessionTimeline(pureDir, 'chan_missing')).toEqual([]);
    expect(readSessionTimeline(pureDir, '../channels.json')).toEqual([]);
    expect(readSessionTimeline(pureDir, 'chan_1/x')).toEqual([]);
  });
});
