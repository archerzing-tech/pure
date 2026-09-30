import { describe, it, expect } from 'bun:test';
import { TurnRenderer } from '../renderer';
import type { ChannelCapabilities, OutboundMessage } from '../types';
import type { EngineEvent } from '../../shared/types';

const CAPS: ChannelCapabilities = { chatTypes: ['dm'], media: {}, streaming: 'edit', maxTextLength: 4000, markdown: 'basic' };

function token(text: string): EngineEvent {
  return { type: 'TokenDelta', payload: { content: text, stateId: 's', isToolCall: false }, timestamp: 0 };
}
function completed(finalOutput?: string): EngineEvent {
  return { type: 'Completed', payload: { finalOutput, isComplete: true, interrupted: false, turnCount: 1 }, timestamp: 0 };
}
function error(message: string): EngineEvent {
  return { type: 'Error', payload: { code: 'E', message, stateType: 'ACT', recoverable: false }, timestamp: 0 };
}

function harness(caps: ChannelCapabilities = CAPS, now?: () => number) {
  const frames: OutboundMessage[] = [];
  const renderer = new TurnRenderer({ capabilities: caps, emit: (m) => frames.push(m), throttleMs: 1000, now });
  return { renderer, frames };
}

describe('TurnRenderer', () => {
  it('accumulates a full snapshot rather than emitting deltas', () => {
    let clock = 0;
    const { renderer, frames } = harness(CAPS, () => (clock += 2000));
    renderer.acknowledge();
    renderer.push(token('he'));
    renderer.push(token('llo'));
    renderer.push(completed('hello'));
    const progress = frames.filter((f) => f.kind === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1].text).toBe('hello');
    expect(frames[frames.length - 1]).toMatchObject({ kind: 'final', text: 'hello', final: true });
  });

  it('throttles progress frames to one per window', () => {
    let clock = 0;
    const { renderer, frames } = harness(CAPS, () => clock);
    renderer.push(token('a'));
    renderer.push(token('b'));
    clock += 500;
    renderer.push(token('c'));
    clock += 600;
    renderer.push(token('d'));
    expect(frames.filter((f) => f.kind === 'progress').length).toBe(2);
  });

  it('emits only a final frame when the channel cannot stream', () => {
    const { renderer, frames } = harness({ ...CAPS, streaming: 'none' });
    renderer.acknowledge();
    renderer.push(token('answer'));
    renderer.push(completed('answer'));
    expect(frames.filter((f) => f.kind === 'progress')).toEqual([]);
    expect(frames).toEqual([{ kind: 'final', text: 'answer', final: true }]);
  });

  it('falls back to the accumulated text when Completed carries no output', () => {
    const { renderer, frames } = harness();
    renderer.push(token('partial'));
    renderer.push(completed(undefined));
    expect(frames[frames.length - 1]).toMatchObject({ kind: 'final', text: 'partial' });
  });

  it('surfaces errors as non-droppable frames', () => {
    const { renderer, frames } = harness({ ...CAPS, streaming: 'none' });
    renderer.push(error('boom'));
    expect(frames).toEqual([{ kind: 'error', text: '出错了：boom', final: true }]);
  });

  it('marks an interrupted turn as final with a reason', () => {
    const { renderer, frames } = harness();
    renderer.push(token('half'));
    renderer.push({ type: 'Interrupted', payload: { reason: 'user aborted', completedSteps: [] }, timestamp: 0 });
    expect(frames[frames.length - 1].text).toContain('已中断');
    expect(frames[frames.length - 1].final).toBe(true);
  });
});
