// scripts/verify-channel-diagrams.ts
// 富输出降级矩阵里最后两格的验收：```mermaid / ```puml 在真实 Chromium 里跑真引擎
// （不是 mock 渲染器），经适配器把 PNG 真投递出去。
//
// 两段：
//  1) 直接调 gateway 的默认渲染器 —— 证明 mermaid/puml 光栅化本身可用；
//  2) mock 飞书 transport 上跑完整 gateway —— agent 的回答里带 ```mermaid，
//     断言最终真有一条 PNG 图片消息发出，且正文里没有「未光栅化」的降级说明。
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/channels/gateway';
import { ChannelRegistry } from '../src/channels/registry';
import { ChannelSessionIndex } from '../src/channels/sessionIndex';
import { PairingGate } from '../src/channels/pairing';
import { createFeishuAdapter } from '../src/adapter/channels/feishu';
import { createDefaultRichRenderers } from '../src/channels/rasterize/headlessRenderer';
import { defaultChannelsConfig } from '../src/channels/config';
import type { ChannelsConfig } from '../src/channels/config';
import type { FeishuRawMessage, FeishuTransport, FeishuTransportHandlers } from '../src/adapter/channels/feishu/types';
import { createScriptedChannelFactory, scriptedStats, VERIFY_MERMAID, VERIFY_PUML } from './lib/scriptedChannelAgent';

const MERMAID_PROMPT = '画一张流程图';

interface MockFeishu extends FeishuTransport {
  handlers?: FeishuTransportHandlers;
  texts: Array<{ chatId: string; text: string }>;
  cards: Array<{ chatId: string; card: unknown }>;
  images: Array<{ chatId: string; data: Uint8Array; name: string }>;
}

function mockTransport(): MockFeishu {
  const transport: MockFeishu = {
    texts: [], cards: [], images: [], handlers: undefined,
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendText(chatId, text) { transport.texts.push({ chatId, text }); return `om_t${transport.texts.length}`; },
    async sendCard(chatId, card) { transport.cards.push({ chatId, card }); return `om_c${transport.cards.length}`; },
    async patchCard() {},
    async sendImage(chatId, image, name) {
      transport.images.push({ chatId, data: image, name });
      return `om_i${transport.images.length}`;
    },
  };
  return transport;
}

function emit(transport: MockFeishu, text: string, id: string): void {
  const raw: FeishuRawMessage = {
    messageId: id, chatId: 'oc_dm', chatType: 'p2p', messageType: 'text',
    text, mentionsBot: false, senderId: 'ou_verify',
  };
  transport.handlers!.onMessage(raw);
}

function configFor(workspace: string): ChannelsConfig {
  const config = defaultChannelsConfig();
  config.enabled = true;
  config.channels = { feishu: { enabled: true, dmPolicy: 'pairing', accounts: { main: {} } } };
  config.default = { workspace: null, permissionMode: 'PLAN', toolProfile: 'readonly', evolutionEnabled: false };
  config.bindings = [{ match: { channel: 'feishu' }, workspace, permissionMode: 'NORMAL', toolProfile: 'coding' }];
  config.streaming.throttleMs = 0;
  return config;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function assertPng(png: Uint8Array | null | undefined, label: string): void {
  assert(!!png, `${label} 应产出 PNG`);
  assert((png as Uint8Array).length > 500, `${label} 的 PNG 应有实际内容（${(png as Uint8Array).length} 字节）`);
  assert([...(png as Uint8Array).slice(0, 4)].join(',') === '137,80,78,71', `${label} 应是 PNG（magic bytes 不符）`);
}

async function main(): Promise<void> {
  process.stdout.write('▶ mermaid / puml headless 光栅化验收\n');

  // 1) 渲染器本身：真引擎、真 Chromium、真 resvg。
  const renderers = createDefaultRichRenderers({ log: (m) => process.stdout.write(`  ${m}\n`) });
  try {
    if (typeof renderers.mermaidToPng !== 'function' || typeof renderers.pumlToPng !== 'function') {
      throw new Error('没有可用的 Chrome —— 装上 Google Chrome 或设置 PURE_CHROME_PATH 后重试');
    }
    const startedAt = Date.now();
    const mermaidPng = await renderers.mermaidToPng(VERIFY_MERMAID);
    assertPng(mermaidPng, 'mermaid');
    const mermaidMs = Date.now() - startedAt;
    const pumlPng = await renderers.pumlToPng(VERIFY_PUML);
    assertPng(pumlPng, 'puml');
    process.stdout.write(`  ✓ 真引擎渲染：mermaid ${mermaidPng!.length} 字节（${mermaidMs}ms 含打包+启动），puml ${pumlPng!.length} 字节\n`);
  } finally {
    renderers.dispose?.();
  }

  // 2) 端到端：回答里的 ```mermaid 经 gateway → 适配器 → transport 真投递。
  const base = mkdtempSync(join(tmpdir(), 'pure-diagrams-verify-'));
  const workspace = join(base, 'workspace');
  const sessionsDir = join(base, 'sessions');
  const channelsDir = join(base, 'channels');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });

  const transport = mockTransport();
  const registry = new ChannelRegistry({ log: () => {} });
  registry.register(createFeishuAdapter({ accountId: 'main', transport }));
  const gate = new PairingGate({ pendingPath: join(channelsDir, 'pending.json'), peersPath: join(channelsDir, 'peers.json'), log: () => {} });
  const gateway = new Gateway({
    config: configFor(workspace),
    registry,
    factory: createScriptedChannelFactory({ sessionsDir }),
    lockPath: join(channelsDir, 'gateway.lock'),
    index: new ChannelSessionIndex(join(channelsDir, 'sessions.json')),
    pairing: gate,
    evictionIntervalMs: 0,
    log: (m) => process.stdout.write(`  ${m}\n`),
  });

  try {
    await gateway.start();
    emit(transport, MERMAID_PROMPT, 'om_d1');
    await waitFor(() => transport.texts.some((t) => t.text.includes('pure channels approve')), 5000, 'pairing notice');
    const pending = gate.listPending();
    assert(!!gate.approve(pending[0].code), '配对码应可批准');

    emit(transport, MERMAID_PROMPT, 'om_d2');
    await waitFor(() => transport.images.length >= 1, 60_000, 'outbound mermaid image');
    assertPng(transport.images[0].data, '端到端 mermaid');
    const noteShown = transport.cards.some((c) => JSON.stringify(c.card).includes('未光栅化'));
    assert(!noteShown, 'mermaid 已光栅化，正文不该再出现降级说明');
    assert(scriptedStats.verifierCalls >= 1, '通道会话应跑过 LLM 复核验证');
    process.stdout.write(`  ✓ 端到端：\`\`\`mermaid 变成 ${transport.images[0].data.length} 字节 PNG 经适配器投递（${transport.images[0].name}）\n`);

    process.stdout.write('✅ verify:channel-diagrams PASS\n');
  } finally {
    await gateway.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`❌ verify:channel-diagrams FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
