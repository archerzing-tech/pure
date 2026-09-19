import { describe, expect, it } from 'bun:test';
import { collectAgentRunEvents, thinkPhaseModel } from './codingAgentExecutor';
import type { EngineEvent } from '../shared/types';

async function* events(...list: EngineEvent[]): AsyncIterable<EngineEvent> {
  for (const event of list) yield event;
}

const completed = (payload: Partial<Extract<EngineEvent, { type: 'Completed' }>['payload']> = {}): EngineEvent => ({
  type: 'Completed',
  payload: { isComplete: true, interrupted: false, turnCount: 1, ...payload },
  timestamp: 0,
});

describe('evaluation run event collection', () => {
  it('counts tool calls and keeps the usage from Completed', async () => {
    const result = await collectAgentRunEvents(events(
      { type: 'ToolResult', payload: { toolName: 'read_file', result: { success: true }, duration: 1 } } as unknown as EngineEvent,
      completed({ usage: { promptTokens: 10, completionTokens: 2 } }),
    ));
    expect(result.toolCalls).toBe(1);
    expect(result.completed).toBe(true);
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.turns).toBe(1);
    expect(result.fatalError).toBeUndefined();
  });

  it('keeps the turn count from the terminal event when a cap ends the run', async () => {
    const result = await collectAgentRunEvents(events(
      { type: 'Interrupted', payload: { reason: 'max_turns', completedSteps: [], turnCount: 30 }, timestamp: 0 },
      completed({ isComplete: false, interrupted: true, turnCount: 30 }),
    ));
    expect(result.turns).toBe(30);
    expect(result.fatalError?.code).toBe('AGENT_INTERRUPTED');
    expect(result.fatalError?.message).toBe('max_turns');
  });

  // A dead key or an unknown model code must NOT be scorable as a plain failed
  // attempt: the engine reports it as a fatal Error, or (when a failure policy
  // is installed) as Interrupted + `Completed { interrupted: true }`.
  it('surfaces an unrecoverable error as fatal', async () => {
    const result = await collectAgentRunEvents(events(
      { type: 'Error', payload: { code: 'LLM_STREAM_ERROR', message: '400 Unknown Model', stateType: 'THINK', recoverable: false, recoveryAction: 'terminate' }, timestamp: 0 },
      { type: 'Interrupted', payload: { reason: 'llm_stream_error: 400 Unknown Model', completedSteps: [], turnCount: 0 }, timestamp: 0 },
      completed({ isComplete: false, interrupted: true }),
    ));
    expect(result.completed).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(result.fatalError?.code).toBe('LLM_STREAM_ERROR');
  });

  it('surfaces an interrupted run as fatal even without an Error event', async () => {
    const result = await collectAgentRunEvents(events(
      { type: 'FailurePolicyDecision', payload: { action: { kind: 'stop', reason: 'llm_error: 400 Unknown Model' }, failure: { type: 'llm_error', message: '400 Unknown Model', turnNumber: 1 }, turnNumber: 1 }, timestamp: 0 } as unknown as EngineEvent,
      { type: 'Interrupted', payload: { reason: 'llm_error: 400 Unknown Model', completedSteps: [], turnCount: 1 }, timestamp: 0 },
      completed({ isComplete: false, interrupted: true }),
    ));
    expect(result.completed).toBe(true);
    expect(result.fatalError?.code).toBe('AGENT_INTERRUPTED');
    expect(result.fatalError?.message).toContain('400 Unknown Model');
  });

  it('ignores recoverable errors', async () => {
    const result = await collectAgentRunEvents(events(
      { type: 'Error', payload: { code: 'VERIFY_FAILED', message: 'try again', stateType: 'VERIFY', recoverable: true }, timestamp: 0 },
      completed(),
    ));
    expect(result.fatalError).toBeUndefined();
    expect(result.completed).toBe(true);
  });

  it('keeps a completed turn clean', async () => {
    const result = await collectAgentRunEvents(events(completed()));
    expect(result.fatalError).toBeUndefined();
    expect(result.completed).toBe(true);
  });
});

describe('9.3 — thinkPhaseModel routing decision', () => {
  it('routes THINK only when the override names a different model', () => {
    expect(thinkPhaseModel({ model: 'glm-4.5-flash', thinkModel: 'glm-5.3-flash' })).toBe('glm-5.3-flash');
  });

  it('keeps the run single-adapter for the main model or whitespace', () => {
    expect(thinkPhaseModel({ model: 'glm-4.5-flash', thinkModel: 'glm-4.5-flash' })).toBeUndefined();
    expect(thinkPhaseModel({ model: 'glm-4.5-flash', thinkModel: '   ' })).toBeUndefined();
    expect(thinkPhaseModel({ model: 'glm-4.5-flash' })).toBeUndefined();
  });

  it('trims a padded override', () => {
    expect(thinkPhaseModel({ model: 'glm-4.5-flash', thinkModel: ' glm-5.3-flash ' })).toBe('glm-5.3-flash');
  });
});
