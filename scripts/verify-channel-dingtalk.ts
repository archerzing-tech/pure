// scripts/verify-channel-dingtalk.ts
// 钉钉验收（cn-im-channels.md §4）：mock transport 上跑完整 gateway 链路 ——
// 未配对私信被挡 → 批准后 agent 在 workspace 造文件（审批走卡片按钮 action 约定）
// → 群聊未 @ 不响应、@ 则响应；卡片流式能力开启时走卡片更新。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../src/channels/gateway';
import { ChannelRegistry } from '../src/channels/registry';
import { ChannelSessionIndex } from '../src/channels/sessionIndex';
import { PairingGate } from '../src/channels/pairing';
import { createDingTalkAdapter } from '../src/adapter/channels/dingtalk';
import { defaultChannelsConfig } from '../src/channels/config';
import type { ChannelsConfig } from '../src/channels/config';
import type { DingTalkCard, DingTalkRawMessage, DingTalkTransport, DingTalkTransportHandlers } from '../src/adapter/channels/dingtalk/types';
import { createScriptedChannelFactory, scriptedStats } from './lib/scriptedChannelAgent';

const FILE_PROMPT = '请在工作区创建 hello.txt';

interface MockDingTalk extends DingTalkTransport {
  handlers?: DingTalkTransportHandlers;
  markdowns: Array<{ conversationId: string; text: string }>;
  cards: Array<{ conversationId: string; card: DingTalkCard }>;
  updates: Array<{ outTrackId: string; card: DingTalkCard }>;
  images: Array<{ conversationId: string; data: Uint8Array; name: string }>;
}

function mockTransport(): MockDingTalk {
  const transport: MockDingTalk = {
    canStreamCards: true,
    markdowns: [], cards: [], updates: [], images: [], handlers: undefined,
    async start(handlers) { transport.handlers = handlers; },
    async stop() {},
    async sendMarkdown(conversationId, text) { transport.markdowns.push({ conversationId, text }); return `dt_m${transport.markdowns.length}`; },
    async sendCard(conversationId, card) {
      transport.cards.push({ conversationId, card });
      // 审批卡片：脚本模拟「人点了批准按钮」（钉钉 action 约定 approve=批准）。
      if (card.markdown.includes('需要批准')) {
        setTimeout(() => transport.handlers!.onCardAction({
          outTrackId: card.outTrackId,
          action: 'approve',
          conversationId,
          conversationType: '1',
        }), 10);
      }
      return `dt_c${transport.cards.length}`;
    },
    async updateCard(outTrackId, card) { transport.updates.push({ outTrackId, card }); },
    async sendImage(conversationId, image, name) {
      transport.images.push({ conversationId, data: image, name });
      return `dt_i${transport.images.length}`;
    },
  };
  return transport;
}

function emit(transport: MockDingTalk, text: string, opts: { conversationId: string; conversationType: '1' | '2'; atBot: boolean; id: string }): void {
  const raw: DingTalkRawMessage = {
    messageId: opts.id,
    conversationId: opts.conversationId,
    conversationType: opts.conversationType,
    text: opts.atBot ? `@pure ${text}` : text,
    atBot: opts.atBot,
    senderStaffId: 'staff_verify',
    senderNick: 'Verifier',
  };
  transport.handlers!.onMessage(raw);
}

function configFor(workspace: string): ChannelsConfig {
  const config = defaultChannelsConfig();
  config.enabled = true;
  config.channels = { dingtalk: { enabled: true, dmPolicy: 'pairing', accounts: { main: {} } } };
  config.default = { workspace: null, permissionMode: 'PLAN', toolProfile: 'readonly', evolutionEnabled: false };
  config.bindings = [{ match: { channel: 'dingtalk' }, workspace, permissionMode: 'NORMAL', toolProfile: 'coding' }];
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
  const base = mkdtempSync(join(tmpdir(), 'pure-dingtalk-verify-'));
  const workspace = join(base, 'workspace');
  const sessionsDir = join(base, 'sessions');
  const channelsDir = join(base, 'channels');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(channelsDir, { recursive: true });

  const transport = mockTransport();
  const registry = new ChannelRegistry({ log: () => {} });
  registry.register(createDingTalkAdapter({ accountId: 'main', transport }));
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

  const dm = { conversationId: 'cid_dm', conversationType: '1' as const };
  const group = { conversationId: 'cid_group', conversationType: '2' as const };
  const helloPath = join(workspace, 'hello.txt');

  try {
    process.stdout.write('▶ 钉钉通道验收（mock transport）\n');
    await gateway.start();

    emit(transport, FILE_PROMPT, { ...dm, atBot: false, id: 'dt_dm_1' });
    await waitFor(() => transport.markdowns.some((m) => m.text.includes('pure channels approve')), 5000, 'pairing notice');
    assert(!existsSync(helloPath), '未配对私信不得触发 agent');
    assert(gateway.sessionCount === 0, '未配对私信不得创建会话');
    const pending = gate.listPending();
    process.stdout.write(`  ✓ 未配对私信被挡下，配对码 ${pending[0].code}\n`);

    assert(!!gate.approve(pending[0].code), '配对码应可批准');
    emit(transport, FILE_PROMPT, { ...dm, atBot: false, id: 'dt_dm_2' });
    await waitFor(() => existsSync(helloPath), 15_000, 'hello.txt');
    assert(readFileSync(helloPath, 'utf8').includes('hello from channel gateway'), 'hello.txt 内容应来自脚本化工具调用');
    assert(transport.cards.length >= 1, 'agent 的回答应以卡片下发');
    assert(scriptedStats.verifierCalls >= 1, '通道会话应跑过 LLM 复核验证');
    process.stdout.write(`  ✓ 配对后：agent 造出 ${helloPath}；卡片 ${transport.cards.length} 张；LLM 复核 ${scriptedStats.verifierCalls} 次\n`);

    const sessionsBefore = gateway.sessionCount;
    const cardsBefore = transport.cards.length;
    emit(transport, FILE_PROMPT, { ...group, atBot: false, id: 'dt_group_1' });
    await new Promise((r) => setTimeout(r, 200));
    assert(gateway.sessionCount === sessionsBefore, '群聊未 @ 不得创建会话');
    assert(transport.cards.length === cardsBefore, '群聊未 @ 不得下发消息');
    process.stdout.write('  ✓ 群聊未 @ 不响应\n');

    emit(transport, '你好', { ...group, atBot: true, id: 'dt_group_2' });
    await waitFor(() => transport.cards.length > cardsBefore, 10_000, 'group reply card');
    assert(gateway.sessionCount === sessionsBefore + 1, '群聊 @ 后应创建会话');
    process.stdout.write('  ✓ 群聊 @ 后正常响应\n');

    // 5) 富输出：回答里的 ```svg 光栅化成 PNG，经适配器真投递图片消息。
    emit(transport, '画一张图', { ...group, atBot: true, id: 'dt_group_3' });
    await waitFor(() => transport.images.length >= 1, 20_000, 'outbound image message');
    const png = transport.images[0].data;
    assert(png.length > 100, `PNG 附件应有实际内容（${png.length} 字节）`);
    assert(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, '附件应是 PNG（magic bytes 不符）');
    assert(transport.images[0].conversationId === group.conversationId, '图片应发到该群会话');
    process.stdout.write(`  ✓ 富输出：\`\`\`svg 光栅化为 ${png.length} 字节 PNG 并投递（${transport.images[0].name}）\n`);

    process.stdout.write('✅ verify:channel-dingtalk PASS\n');
  } finally {
    await gateway.stop();
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`❌ verify:channel-dingtalk FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
