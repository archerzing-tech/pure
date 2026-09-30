// scripts/verify-channel-feishu.ts
// P1 飞书验收（cn-im-channels.md §2）：mock transport 上跑完整 gateway 链路 ——
// 未配对私信被挡在 agent 外并给出配对码 → 批准后 agent 在 workspace 造文件 →
// 群聊未 @ 不响应、@ 了才响应；通道档 LLM 复核也被断言跑过。
//
// mock transport 之外的部分全是生产代码：适配器、gateway、路由、harness、工具门控。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/channels/gateway';
import { ChannelRegistry } from '../src/channels/registry';
import { ChannelSessionIndex } from '../src/channels/sessionIndex';
import { PairingGate } from '../src/channels/pairing';
import { createFeishuAdapter } from '../src/adapter/channels/feishu';
import { defaultChannelsConfig } from '../src/channels/config';
import type { ChannelsConfig } from '../src/channels/config';
import type { FeishuCardAction, FeishuRawMessage, FeishuTransport, FeishuTransportHandlers } from '../src/adapter/channels/feishu/types';
import { createScriptedChannelFactory, scriptedStats } from './lib/scriptedChannelAgent';

const FILE_PROMPT = '请在工作区创建 hello.txt';

interface MockFeishu extends FeishuTransport {
  handlers?: FeishuTransportHandlers;
  texts: Array<{ chatId: string; text: string }>;
  cards: Array<{ chatId: string; card: unknown }>;
  patches: Array<{ messageId: string; card: unknown }>;
  images: Array<{ chatId: string; data: Uint8Array; name: string }>;
}

/** 卡片按钮回调（真实长连接不保证送达，这里单独驱动测试适配器的回调分支）。 */
function buttonReply(transport: MockFeishu, chatId: string, chatType: 'p2p' | 'group', decision: string): void {
  const action: FeishuCardAction = { openId: 'ou_verify', chatId, chatType, messageId: `om_clicked_${Date.now()}`, actionValue: { approvalId: 'ap', decision } };
  transport.handlers!.onCardAction(action);
}

function mockTransport(): MockFeishu {
  const transport: MockFeishu = {
    texts: [], cards: [], patches: [], images: [], handlers: undefined,
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendText(chatId, text) { transport.texts.push({ chatId, text }); return `om_t${transport.texts.length}`; },
    async sendCard(chatId, card) {
      transport.cards.push({ chatId, card });
      // 审批卡片：脚本模拟「人按了批准按钮」——走按钮回调路径（非文字）。
      if (JSON.stringify(card).includes('需要批准')) {
        setTimeout(() => buttonReply(transport, chatId, 'p2p', 'allow'), 10);
      }
      return `om_c${transport.cards.length}`;
    },
    async patchCard(messageId, card) { transport.patches.push({ messageId, card }); },
    async sendImage(chatId, image, name) {
      transport.images.push({ chatId, data: image, name });
      return `om_i${transport.images.length}`;
    },
  };
  return transport;
}

function emit(transport: MockFeishu, text: string, opts: { chatId: string; chatType: 'p2p' | 'group'; mentionsBot: boolean; id: string }): void {
  const raw: FeishuRawMessage = {
    messageId: opts.id,
    chatId: opts.chatId,
    chatType: opts.chatType,
    messageType: 'text',
    text: opts.mentionsBot ? `@_user_1 ${text}` : text,
    mentionsBot: opts.mentionsBot,
    senderId: 'ou_verify',
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

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`);
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'pure-feishu-verify-'));
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

  const dm = { chatId: 'oc_dm', chatType: 'p2p' as const };
  const group = { chatId: 'oc_group', chatType: 'group' as const };
  const helloPath = join(workspace, 'hello.txt');

  try {
    process.stdout.write('▶ P1 飞书通道验收（mock transport）\n');
    await gateway.start();

    // 1) 未配对私信：不进 agent，只回配对码。
    emit(transport, FILE_PROMPT, { ...dm, mentionsBot: false, id: 'om_dm_1' });
    await waitFor(() => transport.texts.some((t) => t.text.includes('pure channels approve')), 5000, 'pairing notice');
    assert(!existsSync(helloPath), '未配对私信不得触发 agent（不该有文件）');
    assert(gateway.sessionCount === 0, '未配对私信不得创建会话');
    const pending = gate.listPending();
    assert(pending.length === 1, '应产生一条待配对请求');
    process.stdout.write(`  ✓ 未配对私信被挡下，配对码 ${pending[0].code}\n`);

    // 2) 批准后再来：agent 造文件，出站走卡片，审批走按钮回调。
    const peer = gate.approve(pending[0].code);
    assert(!!peer, '配对码应可批准');
    emit(transport, FILE_PROMPT, { ...dm, mentionsBot: false, id: 'om_dm_2' });
    await waitFor(() => existsSync(helloPath), 15_000, 'hello.txt');
    assert(readFileSync(helloPath, 'utf8').includes('hello from channel gateway'), 'hello.txt 内容应来自脚本化工具调用');
    assert(transport.cards.length >= 1, 'agent 的回答应以卡片下发');
    assert(scriptedStats.verifierCalls >= 1, '通道会话应跑过 LLM 复核验证');
    process.stdout.write(`  ✓ 配对后：agent 在 ${helloPath} 造出文件；卡片 ${transport.cards.length} 张；LLM 复核 ${scriptedStats.verifierCalls} 次\n`);

    // 3) 群聊未 @：不响应。
    const sessionsBefore = gateway.sessionCount;
    const cardsBefore = transport.cards.length;
    emit(transport, FILE_PROMPT, { ...group, mentionsBot: false, id: 'om_group_1' });
    await new Promise((r) => setTimeout(r, 200));
    assert(gateway.sessionCount === sessionsBefore, '群聊未 @ 不得创建会话');
    assert(transport.cards.length === cardsBefore, '群聊未 @ 不得下发消息');
    process.stdout.write('  ✓ 群聊未 @ 不响应\n');

    // 4) 群聊 @ 了：正常响应。
    emit(transport, '你好', { ...group, mentionsBot: true, id: 'om_group_2' });
    await waitFor(() => transport.cards.length > cardsBefore, 10_000, 'group reply card');
    assert(gateway.sessionCount === sessionsBefore + 1, '群聊 @ 后应创建会话');
    process.stdout.write('  ✓ 群聊 @ 后正常响应\n');

    // 5) 富输出：回答里的 ```svg 光栅化成 PNG，经适配器真投递图片消息。
    emit(transport, '画一张图', { ...group, mentionsBot: true, id: 'om_group_3' });
    await waitFor(() => transport.images.length >= 1, 20_000, 'outbound image message');
    const png = transport.images[0].data;
    assert(png.length > 100, `PNG 附件应有实际内容（${png.length} 字节）`);
    assert(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, '附件应是 PNG（magic bytes 不符）');
    assert(transport.images[0].chatId === group.chatId, '图片应发到该群会话');
    process.stdout.write(`  ✓ 富输出：\`\`\`svg 光栅化为 ${png.length} 字节 PNG 并投递（${transport.images[0].name}）\n`);

    process.stdout.write('✅ verify:channel-feishu PASS\n');
  } finally {
    await gateway.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`❌ verify:channel-feishu FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
