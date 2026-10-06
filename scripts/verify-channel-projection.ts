// scripts/verify-channel-projection.ts
// 通道投影验收：回答里的富块（代码块 / 表格 / 图表）用**桌面端同一套渲染管线**
// 在 headless Chrome 里出图，正文保持平台原生 markdown，按原顺序投递。
//
// 断言的是「一致性契约」能落到地上：
//  1) 富块各自出一张真 PNG（不是 mock），宽度就是桌面端聊天列宽 × 2；
//  2) 正文里的富块源码被图替代，不再重复出现；
//  3) 只发图的帧不产生空消息/空卡片（适配器跳过空文本）；
//  4) 顺序是「文本 → 图 → 文本 → 图」。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/channels/gateway';
import { ChannelRegistry } from '../src/channels/registry';
import { ChannelSessionIndex } from '../src/channels/sessionIndex';
import { PairingGate } from '../src/channels/pairing';
import { createFeishuAdapter } from '../src/adapter/channels/feishu';
import { createProjectionPage } from '../src/channels/projection/browserProjection';
import { defaultChannelsConfig } from '../src/channels/config';
import type { ChannelsConfig } from '../src/channels/config';
import type { FeishuRawMessage, FeishuTransport, FeishuTransportHandlers } from '../src/adapter/channels/feishu/types';
import { createScriptedChannelFactory } from './lib/scriptedChannelAgent';

const MIXED_PROMPT = '给我一段带代码和表格的回答';

interface MockFeishu extends FeishuTransport {
  handlers?: FeishuTransportHandlers;
  texts: Array<{ chatId: string; text: string }>;
  cards: Array<{ messageId: string; chatId: string; card: unknown }>;
  images: Array<{ chatId: string; data: Uint8Array; name: string; at: number }>;
  order: string[];
}

function mockTransport(): MockFeishu {
  const transport: MockFeishu = {
    texts: [], cards: [], images: [], order: [], handlers: undefined,
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendText(chatId, text) {
      transport.texts.push({ chatId, text });
      transport.order.push('text');
      return `om_t${transport.texts.length}`;
    },
    async sendCard(chatId, card) {
      transport.cards.push({ messageId: `om_c${transport.cards.length + 1}`, chatId, card });
      transport.order.push(`card:${JSON.stringify(card).length}`);
      return transport.cards[transport.cards.length - 1].messageId;
    },
    // 流式续帧是「全量快照替换」：必须真的更新同一条卡片，而不是新发一条。
    async patchCard(messageId, card) {
      const entry = transport.cards.find((c) => c.messageId === messageId);
      if (entry) entry.card = card;
    },
    async sendImage(chatId, image, name) {
      transport.images.push({ chatId, data: image, name, at: Date.now() });
      transport.order.push('image');
      return `om_i${transport.images.length}`;
    },
  };
  return transport;
}

function emit(transport: MockFeishu, text: string, id: string): void {
  const raw: FeishuRawMessage = {
    messageId: id, chatId: 'oc_proj', chatType: 'p2p', messageType: 'text',
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

/** PNG 的 IHDR 宽高（大端 4 字节）。 */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function main(): Promise<void> {
  process.stdout.write('▶ 通道投影验收（桌面端一致渲染）\n');

  const page = createProjectionPage({ log: (m) => process.stdout.write(`  ${m}\n`) });
  if (!page) throw new Error('没有可用的 Chrome —— 装上 Google Chrome 或设置 PURE_CHROME_PATH 后重试');

  const base = mkdtempSync(join(tmpdir(), 'pure-projection-verify-'));
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
    // 1) 渲染页自身：一段富块能否出图、尺寸对不对。
    const probe = await page.render('```ts\nconst a = 1;\n```');
    assert(!!probe, '投影页应能把代码块渲染成 PNG');
    const probeSize = pngSize(probe!);
    assert(probeSize.width === 2048, `桌面端列宽 1024 × 2 倍图，实际宽 ${probeSize.width}`);
    process.stdout.write(`  ✓ 渲染页：代码块 → ${probeSize.width}×${probeSize.height} PNG（${probe!.length} 字节）\n`);

    await gateway.start();
    emit(transport, MIXED_PROMPT, 'om_p1');
    await waitFor(() => transport.texts.some((t) => t.text.includes('pure channels approve')), 5000, 'pairing notice');
    const pending = gate.listPending();
    assert(!!gate.approve(pending[0].code), '配对码应可批准');

    transport.order.length = 0;
    transport.cards.length = 0;
    transport.images.length = 0;
    transport.texts.length = 0;
    emit(transport, MIXED_PROMPT, 'om_p2');
    await waitFor(() => transport.images.length >= 3, 120_000, 'three projected block images');

    // 2) 富块各自一张真 PNG。
    for (const image of transport.images) {
      assert(image.data[0] === 0x89 && image.data[1] === 0x50 && image.data[2] === 0x4e && image.data[3] === 0x47, '附件应是 PNG');
      const size = pngSize(image.data);
      assert(size.width === 2048, `图片宽应为桌面端列宽 2 倍，实际 ${size.width}`);
      assert(size.height > 40, `图片高度应合理，实际 ${size.height}`);
    }
    process.stdout.write(`  ✓ 富块出图：${transport.images.length} 张 PNG（代码块 / 表格 / 图表），均为 2048px 宽\n`);

    // 3) 流式帧与最终帧都写回同一条卡片 —— 回答不该被拆成一串重复的消息。
    assert(transport.cards.length === 1, `整条回答应只占一张卡片（流式期间原地更新），实际 ${transport.cards.length} 张`);

    // 4) 最终正文保持原生 markdown，且不再重复富块源码。
    const finalCard = transport.cards[transport.cards.length - 1];
    assert(!!finalCard, '应有一张最终正文卡片');
    const finalJson = JSON.stringify(finalCard.card);
    assert(finalJson.includes('这是结论。'), '正文文本应作为原生 markdown 发出');
    assert(!finalJson.includes('```ts'), '代码块已被图替代，不该再出现在正文里');
    assert(!finalJson.includes('```mermaid'), '图表已被图替代，不该再出现在正文里');
    process.stdout.write('  ✓ 正文：最终卡片保留原生 markdown「这是结论。」，富块源码已被图替代\n');

    // 5) 只发图的帧不产生空卡片（适配器跳过空文本）。
    const emptyCards = transport.cards.filter((c) => JSON.stringify(c.card).includes('"content":""'));
    assert(emptyCards.length === 0, `不该出现空文本卡片，实际 ${emptyCards.length} 张`);

    // 6) 顺序：文本在图之前。
    const firstImage = transport.order.indexOf('image');
    const firstCard = transport.order.findIndex((entry) => entry.startsWith('card:'));
    assert(firstCard >= 0 && firstCard < firstImage, `文本应先于图片，实际顺序 ${transport.order.join(',')}`);
    process.stdout.write(`  ✓ 顺序：${transport.order.join(' → ')}\n`);

    // 可选：把图落盘，供人工对一眼「和桌面端像不像」。
    const outIndex = process.argv.indexOf('--out');
    if (outIndex >= 0 && process.argv[outIndex + 1]) {
      const outDir = process.argv[outIndex + 1];
      mkdirSync(outDir, { recursive: true });
      const names = ['code-block', 'table', 'diagram'];
      transport.images.forEach((image, index) => {
        const name = `${names[index] ?? `block-${index + 1}`}.png`;
        writeFileSync(join(outDir, name), image.data);
        process.stdout.write(`  ↳ 已保存 ${join(outDir, name)}\n`);
      });
    }

    process.stdout.write('✅ verify:channel-projection PASS\n');
  } finally {
    await gateway.stop();
    page.dispose();
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`❌ verify:channel-projection FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
