// 遥控桥网关侧测试：端口发现文件、真 WS 连入的 hello/state/projection 回路、
// stopSession 的送达真话、stop 清理。GUI 侧 client 的对应行为在 ui 测试面覆盖。
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteBridge, bridgeDiscoverPath } from '../remoteBridgeServer';
import { targetFromChatKey, frameToOutboundKind, formatToolLine, type BridgeFrame } from '../../shared/remoteBridge';

const HOST = '127.0.0.1';

function wsConnect(port: number, path = '/internal/bridge'): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}${path}`);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws connect failed')), { once: true });
  });
}

function wsSend(ws: WebSocket, msg: unknown): Promise<void> {
  ws.send(JSON.stringify(msg));
  return Promise.resolve();
}

describe('targetFromChatKey / frame helpers', () => {
  it('splits chatKey into a channel target, with and without thread', () => {
    expect(targetFromChatKey('qq:default:dm:1001')).toEqual({ channelId: 'qq', accountId: 'default', peerKind: 'dm', peerId: '1001' });
    expect(targetFromChatKey('telegram:acct1:group:-100:7')).toEqual({ channelId: 'telegram', accountId: 'acct1', peerKind: 'group', peerId: '-100', threadId: '7' });
    expect(targetFromChatKey('junk')).toBeNull();
    expect(targetFromChatKey('qq:default:channel:x')).toBeNull();
  });

  it('turn frames are reliable, status/tool frames are droppable', () => {
    const frames: BridgeFrame[] = [
      { kind: 'turn', text: 'x' },
      { kind: 'error', text: 'x' },
      { kind: 'status', text: 'x' },
      { kind: 'tool', text: 'x' },
    ];
    expect(frames.map(frameToOutboundKind)).toEqual(['notice', 'notice', 'progress', 'progress']);
  });

  it('tool lines clip args and hide credentials', () => {
    expect(formatToolLine('execute_command', 'git status --short', 3200, true)).toContain('git status --short');
    expect(formatToolLine('execute_command', 'a'.repeat(200), 0, true)).toContain('…');
    const cred = formatToolLine('configure_channel', JSON.stringify({ appSecret: 'super-secret-value' }), undefined, true);
    expect(cred).toContain('参数不展示');
    expect(cred).not.toContain('super-secret-value');
  });
});

describe('createRemoteBridge', () => {
  let dir: string;
  let opened: Array<ReturnType<typeof createRemoteBridge>> = [];
  let portSeq = 18131;

  function makeBridge(port: number, hooks: { onProjection?: (sessionId: string, frame: BridgeFrame) => void } = {}) {
    const bridge = createRemoteBridge({
      host: HOST,
      port,
      discoverPath: join(dir, 'channels', 'bridge.json'),
      log: () => {},
      onProjection: hooks.onProjection,
    });
    opened.push(bridge);
    return bridge;
  }

  afterEach(() => {
    for (const bridge of opened) bridge.stop();
    opened = [];
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('binds, writes the discover file, and serves ws roundtrips', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pure-bridge-'));
    const seen: Array<{ sessionId: string; frame: BridgeFrame }> = [];
    const bridge = makeBridge(portSeq++, { onProjection: (sessionId, frame) => seen.push({ sessionId, frame }) });
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    expect(existsSync(bridgeDiscoverPath(dir))).toBe(true);
    expect(JSON.parse(readFileSync(bridgeDiscoverPath(dir), 'utf8')).port).toBe(port);

    const ws = await wsConnect(port as number);
    expect(bridge.hasGui()).toBe(true);

    await wsSend(ws, { type: 'hello', sessions: [{ sessionId: 'session_1', running: true, toolNow: 'cargo test', step: 3 }] });
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.liveSessions()[0]?.toolNow).toBe('cargo test');

    await wsSend(ws, { type: 'projection', sessionId: 'session_1', frame: { kind: 'tool', text: '#1 🔧 cargo test ✓' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(1);
    expect(seen[0].frame.kind).toBe('tool');

    // 非桥路径不升级，答 404。
    const res = await fetch(`http://${HOST}:${port}/other`);
    expect(res.status).toBe(404);
    ws.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.hasGui()).toBe(false);
  });

  it('stopSession tells the truth: false with no gui, true when delivered', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pure-bridge-'));
    const bridge = makeBridge(portSeq++);
    expect(bridge.stopSession('session_1')).toBe(false);
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    const ws = await wsConnect(port as number);
    const received = new Promise<void>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'stop') resolve();
      });
    });
    expect(bridge.stopSession('session_1')).toBe(true);
    await received;
    ws.close();
  });

  it('stop removes the discover file and kills the server', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pure-bridge-'));
    const bridge = makeBridge(portSeq++);
    const port = await bridge.start();
    expect(port).toBeGreaterThan(0);
    bridge.stop();
    expect(existsSync(bridgeDiscoverPath(dir))).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    let failed = false;
    try {
      await fetch(`http://${HOST}:${port}/internal/bridge`);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
