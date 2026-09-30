// scripts/verify-channel-loop.ts
// P0 验收（设计文档 §11）：起 gateway → webchat 发一句 → agent 在临时 workspace
// 造一个文件 → 文本流式回到浏览器；进程重启后同一会话能续聊（checkpoint 恢复）。
// 通道档验证器（含 LLM 复核）也在这里被断言跑过。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/channels/gateway';
import { ChannelRegistry } from '../src/channels/registry';
import { ChannelSessionIndex } from '../src/channels/sessionIndex';
import { createWebChatAdapter } from '../src/adapter/channels/webchat';
import { defaultChannelsConfig, writeChannelsConfig } from '../src/channels/config';
import type { ChannelsConfig } from '../src/channels/config';
import { createScriptedChannelFactory, scriptedStats } from './lib/scriptedChannelAgent';

const FIRST_PROMPT = '请在工作区创建 hello.txt';
const SECOND_PROMPT = '我刚让你做什么？';

function buildConfig(workspace: string): ChannelsConfig {
  const config = defaultChannelsConfig();
  config.enabled = true;
  config.channels = { webchat: { enabled: true, accounts: { default: {} } } };
  config.default = { workspace: null, permissionMode: 'PLAN', toolProfile: 'readonly', evolutionEnabled: false };
  config.bindings = [{ match: { channel: 'webchat' }, workspace, permissionMode: 'NORMAL', toolProfile: 'coding' }];
  config.streaming.throttleMs = 0;
  return config;
}

function connect(port: number, peer: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?peer=${peer}`);
  const finals: string[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('websocket failed to open')));
  });
  ws.addEventListener('message', (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as { type: string; text?: string; final?: boolean };
      if (frame.type === 'message' && frame.final === true && typeof frame.text === 'string') finals.push(frame.text);
      // 审批卡片：脚本扮演「在电脑前的人」，回复 y（通道审批的双轨文字路径）。
      if (frame.type === 'message' && frame.final !== true && frame.text?.includes('需要批准')) {
        ws.send(JSON.stringify({ text: 'y' }));
      }
    } catch {
      // ignore non-JSON
    }
  });
  return { ws, ready, finals };
}

async function waitForFinal(state: { finals: string[] }, timeoutMs = 20_000): Promise<string> {
  const start = Date.now();
  while (state.finals.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a final frame');
    await new Promise((r) => setTimeout(r, 50));
  }
  return state.finals[state.finals.length - 1];
}

function freePort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function startGateway(config: ChannelsConfig, sessionsDir: string, indexPath: string, lockPath: string, port: number): Promise<Gateway> {
  const registry = new ChannelRegistry({ log: () => {} });
  registry.register(createWebChatAdapter({ host: '127.0.0.1', port }));
  const gateway = new Gateway({
    config,
    registry,
    factory: createScriptedChannelFactory({ sessionsDir }),
    lockPath,
    index: new ChannelSessionIndex(indexPath),
    evictionIntervalMs: 0,
    log: (m) => process.stdout.write(`  ${m}\n`),
  });
  await gateway.start();
  return gateway;
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'pure-channel-verify-'));
  const workspace = join(base, 'workspace');
  const sessionsDir = join(base, 'sessions');
  const channelsDir = join(base, 'channels');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });
  const configPath = join(channelsDir, 'channels.json');
  const indexPath = join(channelsDir, 'sessions.json');
  const lockPath = join(channelsDir, 'gateway.lock');
  const config = buildConfig(workspace);
  writeChannelsConfig(configPath, config);

  const port = freePort();
  let gateway: Gateway | undefined;
  let client: ReturnType<typeof connect> | undefined;
  try {
    process.stdout.write('▶ P0 通道路由验收\n');

    gateway = await startGateway(config, sessionsDir, indexPath, lockPath, port);
    client = connect(port, 'verify-peer');
    await client.ready;
    client.ws.send(JSON.stringify({ text: FIRST_PROMPT }));
    const firstReply = await waitForFinal(client);
    client.ws.close();

    const helloPath = join(workspace, 'hello.txt');
    assert(existsSync(helloPath), 'agent 应在 workspace 造出 hello.txt');
    assert(readFileSync(helloPath, 'utf8').includes('hello from channel gateway'), 'hello.txt 内容应来自脚本化工具调用');
    assert(firstReply.includes('hello.txt'), `首轮回复应提到产物（实际：${firstReply}）`);
    assert(scriptedStats.verifierCalls >= 1, '通道会话应跑过 LLM 复核验证（证明用的是更强验证档）');
    process.stdout.write(`  ✓ 首轮：agent 在 ${helloPath} 造出文件；LLM 复核 ${scriptedStats.verifierCalls} 次\n`);

    await gateway.stop();
    gateway = undefined;
    assert(existsSync(indexPath), 'sessions.json 应已落盘（会话索引）');
    assert(!existsSync(lockPath), 'gateway 停止后应释放进程锁');

    gateway = await startGateway(config, sessionsDir, indexPath, lockPath, port);
    client = connect(port, 'verify-peer');
    await client.ready;
    client.ws.send(JSON.stringify({ text: SECOND_PROMPT }));
    const secondReply = await waitForFinal(client);
    client.ws.close();

    assert(secondReply.includes('创建 hello.txt'), `重启后续聊应看到历史（实际：${secondReply}）`);
    process.stdout.write(`  ✓ 重启后：同一会话续聊，回复=「${secondReply.slice(0, 60)}…」\n`);

    process.stdout.write('✅ verify:channel-loop PASS\n');
  } finally {
    try { client?.ws.close(); } catch { /* ignore */ }
    if (gateway) await gateway.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`❌ verify:channel-loop FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
