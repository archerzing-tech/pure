import { describe, it, expect } from 'bun:test';
import { AgentSession, type BuildSessionSpec, type ChannelHarness, type HarnessBundle } from '../agentSession';
import type { ChannelCapabilities, InboundEvent, OutboundMessage } from '../types';
import type { EngineEvent } from '../../shared/types';

const CAPS: ChannelCapabilities = {
  chatTypes: ['dm'],
  media: { images: true },
  canDeliverImages: true,
  streaming: 'edit',
  maxTextLength: 4000,
  markdown: 'basic',
};

function token(text: string): EngineEvent {
  return { type: 'TokenDelta', payload: { content: text, stateId: 's', isToolCall: false }, timestamp: 0 };
}
function completed(text: string): EngineEvent {
  return { type: 'Completed', payload: { finalOutput: text, isComplete: true, interrupted: false, turnCount: 1, messages: [] }, timestamp: 0 };
}

function spec(): BuildSessionSpec {
  return {
    sessionKey: 'k',
    sessionId: 's1',
    workspace: null,
    permissionMode: 'PLAN',
    toolProfile: 'readonly',
    evolutionEnabled: false,
    capabilities: CAPS,
    approvalHandler: async () => ({ allowed: false }),
    firstUserText: '',
  };
}

function inbound(): InboundEvent {
  return { kind: 'message', channelId: 'c', accountId: 'a', peer: { id: 'p', kind: 'dm' }, messageId: 'in1', text: 'hi', attachments: [], receivedAt: 0 };
}

function harnessFor(events: EngineEvent[]): ChannelHarness {
  return {
    async *run(): AsyncGenerator<EngineEvent, void, void> {
      for (const event of events) yield event;
    },
    async *continueTurn(): AsyncGenerator<EngineEvent, void, void> {
      for (const event of events) yield event;
    },
  };
}

function makeSession(
  events: EngineEvent[],
  delivered: Array<{ message: OutboundMessage; id: string }>,
  extra: { projection?: (text: string, caps: ChannelCapabilities) => Promise<{ messages: OutboundMessage[]; notes: string[] } | null> } = {},
): AgentSession {
  let counter = 0;
  return new AgentSession('k', { accountId: 'a', peerId: 'p', peerKind: 'dm' }, spec(), {
    capabilities: CAPS,
    throttleMs: 0,
    ackPlaceholder: false,
    projection: extra.projection,
    factory: async (s): Promise<HarnessBundle> => ({ harness: harnessFor(events), systemPrompt: 'sys', sessionId: s.sessionId, projectPath: '' }),
    deliver: async (_target, message) => {
      const id = `m${++counter}`;
      delivered.push({ message, id });
      return id;
    },
  });
}

describe('AgentSession streaming delivery', () => {
  it('writes the final frame back into the streaming message instead of sending a duplicate', async () => {
    const delivered: Array<{ message: OutboundMessage; id: string }> = [];
    const session = makeSession([token('你'), token('好'), completed('你好')], delivered);
    await session.runTurn(inbound());

    const progress = delivered.filter((entry) => entry.message.kind === 'progress');
    const final = delivered.find((entry) => entry.message.kind === 'final');
    expect(progress.length).toBeGreaterThan(0);
    expect(final).toBeDefined();
    // 第一个流式帧创建了气泡（返回 id m1），收尾帧必须编辑这条，而不是新发一条。
    expect(delivered[0].id).toBe('m1');
    expect(final!.message.messageId).toBe('m1');
    expect(final!.message.text).toBe('你好');
  });

  it('lets the first text-bearing projected message take over the streaming bubble', async () => {
    const delivered: Array<{ message: OutboundMessage; id: string }> = [];
    const session = makeSession([token('原始回答'), completed('原始回答')], delivered, {
      projection: async () => ({
        messages: [
          { kind: 'final', text: '这是结论。', final: false },
          { kind: 'final', text: '', final: true, attachments: [{ name: 'block-1.png', mimeType: 'image/png', data: new Uint8Array([1]) }] },
        ],
        notes: [],
      }),
    });
    await session.runTurn(inbound());

    const text = delivered.find((entry) => entry.message.text === '这是结论。');
    const image = delivered.find((entry) => entry.message.attachments?.length);
    expect(text!.message.messageId).toBe('m1');
    expect(image!.message.messageId).toBeUndefined();
  });
});
