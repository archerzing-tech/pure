import { describe, expect, it } from 'bun:test';
import {
  TURN_NO_WRITE_THRESHOLD,
  TURN_REPEAT_THRESHOLD,
  createTurnProgressWatch,
  turnProgressEnabled,
} from '../turnProgress';

const READ_ARGS = JSON.stringify({ path: 'src/app.ts' });

describe('turnProgress 重复调用判据', () => {
  it('同一调用成功到第 3 次才提醒（第 2 次不提醒）', () => {
    const watch = createTurnProgressWatch();
    expect(watch.observe('read_file', READ_ARGS, true, 1)).toBe('');
    expect(watch.observe('read_file', READ_ARGS, true, 1)).toBe('');
    const note = watch.observe('read_file', READ_ARGS, true, 1);
    expect(TURN_REPEAT_THRESHOLD).toBe(3);
    expect(note).toContain('signal="repeated_call"');
    expect(note).toContain('3 times');
  });

  it('参数键序不同算同一次调用，参数不同算不同调用', () => {
    const watch = createTurnProgressWatch();
    watch.observe('read_file', JSON.stringify({ path: 'a.ts', offset: 1 }), true, 1);
    watch.observe('read_file', JSON.stringify({ offset: 1, path: 'a.ts' }), true, 1);
    expect(watch.observe('read_file', JSON.stringify({ offset: 1, path: 'a.ts' }), true, 1)).toContain('repeated_call');
    const other = createTurnProgressWatch();
    other.observe('read_file', JSON.stringify({ path: 'a.ts' }), true, 1);
    other.observe('read_file', JSON.stringify({ path: 'b.ts' }), true, 1);
    expect(other.observe('read_file', JSON.stringify({ path: 'c.ts' }), true, 1)).toBe('');
  });

  it('失败的重复不算（那条路由 FailurePolicy 的阶梯管）', () => {
    const watch = createTurnProgressWatch();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(watch.observe('read_file', READ_ARGS, false, 1)).toBe('');
    }
    // 失败不累积：之后成功的那一次只是第 1 次成功。
    expect(watch.observe('read_file', READ_ARGS, true, 1)).toBe('');
  });

  it('每回合只提醒一次', () => {
    const watch = createTurnProgressWatch();
    watch.observe('read_file', READ_ARGS, true, 1);
    watch.observe('read_file', READ_ARGS, true, 1);
    expect(watch.observe('read_file', READ_ARGS, true, 1)).toContain('repeated_call');
    // 提醒过之后，第 4、5 次不再刷屏。
    expect(watch.observe('read_file', READ_ARGS, true, 1)).toBe('');
    expect(watch.observe('read_file', READ_ARGS, true, 1)).toBe('');
  });
});

describe('turnProgress 无写入判据', () => {
  it(`连续 ${TURN_NO_WRITE_THRESHOLD} 个回合无写入才提醒`, () => {
    const watch = createTurnProgressWatch();
    // 第 1 回合进入不算连；之后每进一个新回合结算上一回合。
    for (let round = 1; round <= TURN_NO_WRITE_THRESHOLD; round += 1) {
      expect(watch.observe('read_file', JSON.stringify({ path: `f${round}.ts` }), true, round)).toBe('');
    }
    const note = watch.observe('read_file', JSON.stringify({ path: 'last.ts' }), true, TURN_NO_WRITE_THRESHOLD + 1);
    expect(note).toContain('signal="no_write"');
    expect(note).toContain(`${TURN_NO_WRITE_THRESHOLD} rounds`);
  });

  it('成功写入打断连续计数', () => {
    const watch = createTurnProgressWatch();
    for (let round = 1; round <= 5; round += 1) {
      watch.observe('read_file', JSON.stringify({ path: `f${round}.ts` }), true, round);
    }
    expect(watch.observe('edit_file', JSON.stringify({ path: 'src/app.ts' }), true, 5)).toBe('');
    // 写入之后重新起算：连续无写入数从写入回合之后算起，第 6 个才提醒。
    for (let round = 6; round <= 5 + TURN_NO_WRITE_THRESHOLD; round += 1) {
      expect(watch.observe('read_file', JSON.stringify({ path: `g${round}.ts` }), true, round)).toBe('');
    }
    expect(watch.observe('read_file', JSON.stringify({ path: 'g-next.ts' }), true, 6 + TURN_NO_WRITE_THRESHOLD)).toContain('no_write');
  });

  it('首见的回合号为 5 时不把 1-4 补算成无写入', () => {
    const watch = createTurnProgressWatch();
    // 恢复/续跑场景：引擎从中间回合开始喂事件。
    for (let round = 5; round < 5 + TURN_NO_WRITE_THRESHOLD; round += 1) {
      expect(watch.observe('read_file', JSON.stringify({ path: `r${round}.ts` }), true, round)).toBe('');
    }
    expect(watch.observe('read_file', JSON.stringify({ path: 'r-last.ts' }), true, 5 + TURN_NO_WRITE_THRESHOLD)).toContain('no_write');
  });

  it('写入失败不算写入（只有成功落盘才打断）', () => {
    const watch = createTurnProgressWatch();
    for (let round = 1; round <= 6; round += 1) {
      watch.observe('write_file', JSON.stringify({ path: 'x.ts', content: 'x' }), false, round);
    }
    expect(watch.observe('read_file', JSON.stringify({ path: 'y.ts' }), true, 7)).toContain('no_write');
  });
});

describe('turnProgress 开关', () => {
  it('默认开，PURE_TURN_PROGRESS=0 关', () => {
    const previous = process.env.PURE_TURN_PROGRESS;
    try {
      delete process.env.PURE_TURN_PROGRESS;
      expect(turnProgressEnabled()).toBe(true);
      process.env.PURE_TURN_PROGRESS = '0';
      expect(turnProgressEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PURE_TURN_PROGRESS;
      else process.env.PURE_TURN_PROGRESS = previous;
    }
  });

  it('阈值可用环境变量覆盖（大仓库臂用更低的线）', () => {
    const previous = process.env.PURE_TURN_PROGRESS_REPEAT;
    try {
      process.env.PURE_TURN_PROGRESS_REPEAT = '2';
      const watch = createTurnProgressWatch();
      watch.observe('read_file', READ_ARGS, true, 1);
      expect(watch.observe('read_file', READ_ARGS, true, 1)).toContain('repeated_call');
    } finally {
      if (previous === undefined) delete process.env.PURE_TURN_PROGRESS_REPEAT;
      else process.env.PURE_TURN_PROGRESS_REPEAT = previous;
    }
  });
});
