// src/shared/__tests__/scheduling.test.ts
// 第 5 期「调度」的核心不变式：五分类 kind → 处理级（蓝图逐字），处理级 →
// 优先级（数值越大越急），「这个急」提级只抬到本档之上、下一档之下。
import { describe, expect, it } from 'bun:test';
import {
  levelForKind,
  priorityForKind,
  priorityForLevel,
  PROCESSING_LEVEL_PRIORITY,
  QUEUED_PRIORITY,
  URGENT_BOOST,
} from '../scheduling';

describe('第 5 期：kind → 处理级', () => {
  it('五分类逐条对齐蓝图（中断/边界/即答/队列/陪伴）', () => {
    for (const kind of ['stop', 'premise-change', 'goal-change']) {
      expect(levelForKind(kind)).toBe('interrupt');
    }
    expect(levelForKind('steer')).toBe('boundary');
    expect(levelForKind('question')).toBe('immediate-answer');
    expect(levelForKind('task')).toBe('queued');
    expect(levelForKind('chatter')).toBe('companion');
  });

  it('未知 kind 兜底队列级——唯一保证跑完的投递（与 netVerdict 同向）', () => {
    expect(levelForKind('nonsense')).toBe('queued');
    expect(levelForKind('')).toBe('queued');
  });
});

describe('第 5 期：处理级 → 优先级', () => {
  it('优先级随处理级单调递减：中断 > 边界 > 即答 > 队列 > 陪伴', () => {
    const p = PROCESSING_LEVEL_PRIORITY;
    expect(p.interrupt).toBeGreaterThan(p.boundary);
    expect(p.boundary).toBeGreaterThan(p['immediate-answer']);
    expect(p['immediate-answer']).toBeGreaterThan(p.queued);
    expect(p.queued).toBeGreaterThan(p.companion);
    // 普通队列级就是 QueuedTask.priority 的缺省/旧档兜底值。
    expect(QUEUED_PRIORITY).toBe(p.queued);
  });

  it('kind 折成优先级：task=队列级，interrupt 级最急', () => {
    expect(priorityForKind('task')).toBe(QUEUED_PRIORITY);
    expect(priorityForKind('stop')).toBe(PROCESSING_LEVEL_PRIORITY.interrupt);
    expect(priorityForKind('steer')).toBeGreaterThan(priorityForKind('task'));
  });
});

describe('第 5 期：这个急（提级）', () => {
  it('提级只抬到本档之上、仍低于下一档——不冒充中断/边界', () => {
    expect(priorityForKind('task', true)).toBe(QUEUED_PRIORITY + URGENT_BOOST);
    expect(priorityForKind('task', true)).toBeGreaterThan(priorityForKind('task', false));
    // 急件的 task 仍排在即答/边界/中断之下——它只是"排到同侪前面先办"。
    expect(priorityForKind('task', true)).toBeLessThan(priorityForLevel('immediate-answer', false));
    expect(priorityForKind('steer', true)).toBeLessThan(priorityForLevel('interrupt', false));
  });

  it('不传 urgent = 普通档（缺省是保守方向：不谎报急）', () => {
    expect(priorityForKind('task')).toBe(priorityForKind('task', false));
    expect(priorityForLevel('queued')).toBe(QUEUED_PRIORITY);
  });
});
