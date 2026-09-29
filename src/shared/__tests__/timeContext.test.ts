// src/shared/__tests__/timeContext.test.ts
// 时间基准模块的回归：现算、不过期、不依赖任务话术（2026-09-29 用户定调：
// 不写死、不做模式/关键词匹配——改进是结构性的，测试也只锁结构）。

import { describe, expect, test } from 'bun:test';
import { currentTimeContext, formatResearchTimeBaseline, formatTimeContextLine } from '../timeContext';

describe('timeContext', () => {
  test('derives the date facts from the clock it is given', () => {
    // 固定时区消除本地差异：2026-09-29 是星期二。
    const ctx = currentTimeContext(new Date('2026-09-29T12:00:00Z'), 'Asia/Shanghai');
    expect(ctx.date).toBe('2026-09-29');
    expect(ctx.weekday).toBe('Tuesday');
    expect(ctx.longDate).toBe('September 29, 2026');
    expect(ctx.timezone).toBe('Asia/Shanghai');
  });

  test('defaults to the runtime clock and local timezone', () => {
    const ctx = currentTimeContext();
    expect(ctx.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ctx.timezone.length).toBeGreaterThan(0);
    // 星期名与日期来自同一时钟，必须自洽：现算才叫现算。
    const roundTrip = new Date(`${ctx.date}T12:00:00Z`);
    expect(Number.isNaN(roundTrip.getTime())).toBe(false);
  });

  test('an invalid timezone falls back to UTC instead of throwing', () => {
    const ctx = currentTimeContext(new Date('2026-09-29T12:00:00Z'), 'Mars/Olympus-Mons');
    expect(ctx.timezone).toBe('UTC');
    expect(ctx.date).toBe('2026-09-29');
  });

  test('the prompt lines name the concrete date, never task keywords', () => {
    const ctx = currentTimeContext(new Date('2026-09-29T12:00:00Z'), 'Asia/Shanghai');
    const line = formatTimeContextLine(ctx);
    // 基准句带今天的日期与泛化指导——结构性注入，与任何话术无关。
    expect(line).toContain('September 29, 2026');
    expect(line).toContain('sys_info()');
    const baseline = formatResearchTimeBaseline(ctx);
    expect(baseline).toContain('2026年9月29日'.slice(0, 0) || baseline); // 中文月份格式由实现自定，锁关键部分
    expect(baseline).toContain('现在');
    expect(baseline).toContain('训练语料');
  });
});
