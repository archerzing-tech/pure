// src/ui/__tests__/taskScriptPersistence.test.ts
// 期 4·持久化：TaskScript 必须跟着会话走。验收标准是设计文档写的那句
// 「重启后剧本一致」——不只是账还在，而是**重启后推导出来的结果和实时一样**。
//
// 另一半是「坏了就不认」：旧版本快照、缺字段、signals 不是数组，宁可当没存过，
// 也不能拿一本坏账去推导——那会产出看起来正常的假账。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController } from '../chat';
import { createSessionTaskScriptPersistence, deleteSession, loadSession, saveSession, SESSION_SNAPSHOT_VERSION, type SessionSnapshotV2 } from '../store';
import { deriveTaskScript, taskScriptHandOver, type TaskScript } from '../../shared/taskScript';
import type { Plan } from '../../coding-agent/types';

const sessionIds = new Set<string>();

// 存储层在非 Tauri 环境落 localStorage，真链路也需要 #chat 外壳才能建卡。
beforeAll(() => {
  GlobalRegistrator.register();
  const chatShell = document.createElement('div');
  chatShell.id = 'chat';
  document.body.appendChild(chatShell);
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

function track(sessionId: string): string {
  sessionIds.add(sessionId);
  return sessionId;
}

function samplePlan(): Plan {
  return {
    reasoning: 'r',
    steps: [
      { id: '1', action: '改 chat.ts', description: 'd', expectedOutcome: '功能完成', todosRequired: false },
      { id: '2', action: '跑验证', description: 'd', expectedOutcome: '结果可交付', todosRequired: false },
    ],
  };
}

function baseSnapshot(plan: Plan, extra: Partial<SessionSnapshotV2['uiState']> = {}): SessionSnapshotV2 {
  return {
    version: SESSION_SNAPSHOT_VERSION,
    modelContext: {
      messages: [
        { role: 'user', content: '继续' },
        { role: 'assistant', content: '在做了' },
      ],
    },
    events: [],
    transcript: [],
    uiState: {
      planProgress: { plan, currentPlan: 1, currentTodo: 1, status: 'active' },
      ...extra,
    },
  };
}

async function flush(chat: ChatController): Promise<void> {
  await (chat as unknown as { activePlanProgressPersistence?: { flush: () => Promise<void> } }).activePlanProgressPersistence?.flush();
  await (chat as unknown as { activeTaskScriptPersistence?: { flush: () => Promise<void> } }).activeTaskScriptPersistence?.flush();
}

afterEach(async () => {
  for (const sessionId of sessionIds) await deleteSession(sessionId);
  sessionIds.clear();
});

describe('taskScript persistence · 存读往返', () => {
  it('写入 uiState.taskScript 并原样读回（纯 JSON，不丢信号）', async () => {
    const sessionId = track(`ts-roundtrip-${Date.now()}-${Math.random()}`);
    const plan = samplePlan();
    await saveSession(sessionId, baseSnapshot(plan));

    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
    // 恢复出来的账本为空时，喂两条信号再 flush 落盘。
    (chat as unknown as { activeTaskScript: unknown }).activeTaskScript = {
      version: 1,
      plan,
      signals: [
        { kind: 'control', marker: 'phaseStart', phase: 1 },
        { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/ui/chat.ts' },
        { kind: 'verification', command: 'bun test', ok: true },
      ],
    };
    (chat as unknown as { activeTaskScriptPersistence?: { persist: (s: unknown) => void } }).activeTaskScriptPersistence
      ?.persist((chat as unknown as { activeTaskScript: unknown }).activeTaskScript);
    await flush(chat);

    const saved = (await loadSession(sessionId))!.snapshot.uiState.taskScript;
    expect(saved).toEqual({
      version: 1,
      plan,
      signals: [
        { kind: 'control', marker: 'phaseStart', phase: 1 },
        { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/ui/chat.ts' },
        { kind: 'verification', command: 'bun test', ok: true },
      ],
    });
  });

  it('重启后推导结果与重启前一致（不只是账还在）', async () => {
    const sessionId = track(`ts-rederive-${Date.now()}-${Math.random()}`);
    const plan = samplePlan();
    const live = {
      version: 1 as const,
      plan,
      signals: [
        { kind: 'control' as const, marker: 'phaseStart' as const, phase: 1 },
        { kind: 'tool' as const, toolName: 'write_file', ok: true, artifact: 'a.ts' },
        { kind: 'control' as const, marker: 'phaseDone' as const, phase: 1 },
        { kind: 'tool' as const, toolName: 'execute_command', ok: true, command: 'bun test' },
        { kind: 'turnEnd' as const },
      ],
    };
    await saveSession(sessionId, baseSnapshot(plan, { taskScript: live }));

    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);

    const restored = chat.getTaskScript();
    expect(restored).not.toBeNull();
    expect(restored?.signals).toHaveLength(live.signals.length);
    expect(deriveTaskScript(restored!)).toEqual(deriveTaskScript(live));
    expect(taskScriptHandOver(restored!)).toEqual(taskScriptHandOver(live));
    // 账本自己的兜底收束（第 1 步模型标完成，第 2 步按回合末的真实活动兜底）
    // 让两步都收束——重启前后必须得出同一个结论。
    expect(chat.getTaskScriptHandOver()?.allDone).toBe(true);
  });

  it('恢复后的卡片能读到同一本账（证据没丢）', async () => {
    const sessionId = track(`ts-card-${Date.now()}-${Math.random()}`);
    const plan = samplePlan();
    await saveSession(sessionId, baseSnapshot(plan, {
      taskScript: {
        version: 1,
        plan,
        signals: [
          { kind: 'control', marker: 'phaseStart', phase: 1 },
          { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'src/ui/chat.ts' },
        ],
      },
    }));
    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
    expect(chat.getTaskScriptHandOver()?.steps[0]?.evidence.artifacts).toEqual(['src/ui/chat.ts']);
  });
});

describe('taskScript persistence · 坏了就不认', () => {
  const bad: Array<[string, unknown]> = [
    ['null', null],
    ['非对象', '账本'],
    ['数组', []],
    ['版本不认识', { version: 2, plan: samplePlan(), signals: [] }],
    ['没有版本号', { plan: samplePlan(), signals: [] }],
    ['计划不是步骤表', { version: 1, plan: { steps: 'x' }, signals: [] }],
    ['signals 不是数组', { version: 1, plan: samplePlan(), signals: 'x' }],
  ];

  for (const [name, taskScript] of bad) {
    it(`拒绝${name}的快照（宁可没账，不要坏账）`, async () => {
      const sessionId = track(`ts-bad-${Date.now()}-${Math.random()}`);
      await saveSession(sessionId, baseSnapshot(samplePlan(), { taskScript: taskScript as never }));
      const chat = new ChatController();
      chat.setSessionId(sessionId);
      chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
      expect(chat.getTaskScript()).toBeNull();
    });
  }

  it('信号里混入非信号项时只丢那一项，不整本作废', async () => {
    const sessionId = track(`ts-mixed-${Date.now()}-${Math.random()}`);
    const plan = samplePlan();
    await saveSession(sessionId, baseSnapshot(plan, {
      taskScript: {
        version: 1,
        plan,
        signals: [null, { kind: 'tool', toolName: 'write_file', ok: true, artifact: 'a.ts' }, 'garbage'] as never,
      },
    }));
    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
    expect(chat.getTaskScript()?.signals).toHaveLength(1);
    expect(chat.getTaskScript()?.signals[0]?.kind).toBe('tool');
  });

  it('旧快照没有 taskScript 字段也不报错（存量会话照常恢复）', async () => {
    const sessionId = track(`ts-legacy-${Date.now()}-${Math.random()}`);
    await saveSession(sessionId, baseSnapshot(samplePlan()));
    const chat = new ChatController();
    chat.setSessionId(sessionId);
    chat.loadFromStorage((await loadSession(sessionId))!.snapshot);
    expect(chat.getTaskScript()).toBeNull();
    expect(chat.getPlanProgressModel()).not.toBeNull();
  });
});

describe('taskScript persistence · 写放大与收尾', () => {
  it('连续写入被合并，flush 把最后一笔记下去', async () => {
    const sessionId = track(`ts-debounce-${Date.now()}-${Math.random()}`);
    const plan = samplePlan();
    await saveSession(sessionId, baseSnapshot(plan));

    const persistence = createSessionTaskScriptPersistence(sessionId);
    let script: TaskScript = { version: 1, plan, signals: [] };
    for (let i = 0; i < 20; i += 1) {
      script = { ...script, signals: [...script.signals, { kind: 'tool', toolName: 'write_file', ok: true, artifact: `f${i}.ts` }] };
      persistence.persist(script);
    }
    await persistence.flush();
    persistence.dispose();

    const saved = (await loadSession(sessionId))!.snapshot.uiState.taskScript;
    expect(saved?.signals).toHaveLength(20);
    expect(saved?.signals.at(-1)).toEqual({ kind: 'tool', toolName: 'write_file', ok: true, artifact: 'f19.ts' });
  });

  it('dispose 之后不再落盘（切换会话后不该把旧会话的账写回去）', async () => {
    const sessionId = track(`ts-disposed-${Date.now()}-${Math.random()}`);
    const plan = samplePlan();
    await saveSession(sessionId, baseSnapshot(plan));

    const persistence = createSessionTaskScriptPersistence(sessionId);
    persistence.dispose();
    persistence.persist({ version: 1, plan, signals: [{ kind: 'turnEnd' }] });
    await persistence.flush();

    expect((await loadSession(sessionId))!.snapshot.uiState.taskScript).toBeUndefined();
  });
});
