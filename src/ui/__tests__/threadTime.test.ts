import { describe, expect, it } from 'bun:test';
import {
  recordThreadInterval,
  residualOf,
  resetThreadIntervals,
  sumIntervals,
  threadIntervalCount,
  type ThreadInterval,
} from '../threadTime';

describe('threadTime 纯核（M1 计量的记账部分）', () => {
  it('只计窗口内的交集，并按桶分开', () => {
    const list: ThreadInterval[] = [
      { bucket: 'render', start: 900, end: 1_050 },
      { bucket: 'persist', start: 1_000, end: 1_100 },
      { bucket: 'render', start: 2_000, end: 2_300 },
    ];
    const result = sumIntervals(list, 1_000, 2_000);
    // render：950–1050 落在窗口里 50ms；2000 那段起点就在窗口尾，不计。
    expect(result.byBucket.render).toBe(50);
    expect(result.byBucket.persist).toBe(100);
    expect(result.total).toBe(150);
  });

  it('完全落在窗口外的区间不计（含窗口反向）', () => {
    const list: ThreadInterval[] = [{ bucket: 'render', start: 10, end: 20 }];
    expect(sumIntervals(list, 100, 200).total).toBe(0);
    expect(sumIntervals(list, 200, 100).total).toBe(0);
  });

  it('残余是上界：忙时扣掉可归因部分，不为负也不带小数', () => {
    expect(residualOf(500, 120)).toBe(380);
    expect(residualOf(100, 260)).toBe(0);
    expect(residualOf(10.4, 0)).toBe(10);
  });

  it('零长度/反向区间不入账', () => {
    resetThreadIntervals();
    recordThreadInterval('render', 100, 100);
    recordThreadInterval('render', 120, 100);
    expect(threadIntervalCount()).toBe(0);
    recordThreadInterval('render', 200, 260);
    expect(threadIntervalCount()).toBe(1);
  });

  it('区间环有上限：超量后只保留最近的部分', () => {
    resetThreadIntervals();
    for (let index = 0; index < 5_000; index++) {
      recordThreadInterval('persist', index * 10, index * 10 + 5);
    }
    expect(threadIntervalCount()).toBeLessThanOrEqual(4_096);
  });
});
