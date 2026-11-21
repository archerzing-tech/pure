import { describe, expect, it } from 'bun:test';
import { TURN_NOTE_GAP, createTurnNoteBudget, turnNoteGap } from '../turnNoteBudget';

const NOTE = 'Failure policy: this call is a dead end. Prefer a path proven this session.';

describe('turnNoteBudget 事实与指令', () => {
  it('事实型不受节流：同一段事实每轮都发', () => {
    const budget = createTurnNoteBudget();
    expect(budget.note('fact', NOTE, 1)).toBe(NOTE);
    expect(budget.note('fact', NOTE, 2)).toBe(NOTE);
    expect(budget.note('fact', NOTE, 3)).toBe(NOTE);
  });

  it(`指令型：同文在 ${TURN_NOTE_GAP} 轮内只发一次`, () => {
    const budget = createTurnNoteBudget();
    expect(budget.note('instruction', NOTE, 1)).toBe(NOTE);
    expect(budget.note('instruction', NOTE, 2)).toBe('');
    // 跨过间隔后重新允许（模型隔了一轮仍在同一死路上，值得再提一次）。
    expect(budget.note('instruction', NOTE, 1 + TURN_NOTE_GAP)).toBe(NOTE);
  });

  it('内容不同的指令各自放行', () => {
    const budget = createTurnNoteBudget();
    expect(budget.note('instruction', NOTE, 1)).toBe(NOTE);
    expect(budget.note('instruction', 'Verification failed: src/a.test.ts expected 3 got 2.', 1)).toContain('Verification failed');
  });

  it('空白差异算同一段指令', () => {
    const budget = createTurnNoteBudget();
    expect(budget.note('instruction', NOTE, 1)).toBe(NOTE);
    expect(budget.note('instruction', `  ${NOTE.replace(' ', '   ')}\n`, 2)).toBe('');
  });

  it('空文本不进账', () => {
    const budget = createTurnNoteBudget();
    expect(budget.note('instruction', '   ', 1)).toBe('');
    expect(budget.note('fact', '', 1)).toBe('');
  });

  it('同一轮内同文只放行一次（并行/多结果路径的防守）', () => {
    const budget = createTurnNoteBudget();
    expect(budget.note('instruction', NOTE, 4)).toBe(NOTE);
    expect(budget.note('instruction', NOTE, 4)).toBe('');
  });

  it('PURE_TURN_NOTE_GAP=0 关掉跨轮节流，但同轮仍只发一次', () => {
    const previous = process.env.PURE_TURN_NOTE_GAP;
    try {
      process.env.PURE_TURN_NOTE_GAP = '0';
      expect(turnNoteGap()).toBe(0);
      const budget = createTurnNoteBudget();
      expect(budget.note('instruction', NOTE, 1)).toBe(NOTE);
      expect(budget.note('instruction', NOTE, 1)).toBe('');
      expect(budget.note('instruction', NOTE, 2)).toBe(NOTE);
    } finally {
      if (previous === undefined) delete process.env.PURE_TURN_NOTE_GAP;
      else process.env.PURE_TURN_NOTE_GAP = previous;
    }
  });
});
