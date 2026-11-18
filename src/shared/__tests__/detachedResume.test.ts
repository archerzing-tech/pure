// src/shared/__tests__/detachedResume.test.ts
// 崩溃恢复通告：转录里的 deferred 收执是「上个进程被杀时那支还在跑」的唯一
// 判据。判据错一边就两头都错——把已送达的支报成丢失，或把真丢的支放过去让
// 模型以为活干完了。

import { describe, it, expect } from 'bun:test';
import type { Message } from '../types';
import {
  DETACHED_RESUME_TAG,
  findInterruptedDelegations,
  renderDetachedResumeNotice,
  resolveInterruptedDelegations,
} from '../detachedResume';

const receipt = (toolCallId: string, toolName = 'code_editor', deferred: boolean | undefined = true): Message => ({
  role: 'tool',
  content: '已受理，后台运行中',
  toolCallId,
  toolName,
  ...(deferred === undefined ? {} : { deferred }),
});

describe('后台委派崩溃恢复通告', () => {
  it('只认还挂着 deferred 的收执：已送达的支不算丢', () => {
    const messages: Message[] = [
      { role: 'user', content: '做两件事' },
      { role: 'assistant', content: '', toolCalls: [] },
      receipt('call_live'),
      receipt('call_done', 'code_reviewer', false),
      { role: 'tool', content: 'read_file 结果', toolCallId: 'call_read', toolName: 'read_file' },
    ];
    expect(findInterruptedDelegations(messages)).toEqual([
      { toolCallId: 'call_live', toolName: 'code_editor' },
    ]);
  });

  it('通告说清三件事：没回来、别当完成、要就同参重派', () => {
    const notice = renderDetachedResumeNotice({ toolCallId: 'call_a', toolName: 'code_editor' });
    expect(notice.startsWith(DETACHED_RESUME_TAG)).toBe(true);
    expect(notice).toContain('call_id=call_a');
    expect(notice).toContain('产出已经随进程没了');
    expect(notice).toContain('别把它算进汇总');
    expect(notice).toContain('相同参数重派');
  });

  it('就地改写收执：内容换成通告，deferred 清掉——同一对象，落盘带得走', () => {
    const lost = receipt('call_x');
    const messages: Message[] = [receipt('call_done', 'code_editor', false), lost];

    expect(resolveInterruptedDelegations(messages)).toEqual([{ toolCallId: 'call_x', toolName: 'code_editor' }]);

    expect(lost.content.startsWith(DETACHED_RESUME_TAG)).toBe(true);
    expect(lost.content).toContain('call_id=call_x');
    expect(lost.deferred).toBe(false);
    // 已送达的支一个字都不动。
    expect(messages[0].content).toBe('已受理，后台运行中');
  });

  it('幂等：改写之后不会再被当成丢掉一次', () => {
    const messages: Message[] = [receipt('call_x')];
    expect(resolveInterruptedDelegations(messages)).toHaveLength(1);
    expect(resolveInterruptedDelegations(messages)).toHaveLength(0);
  });

  it('无在飞支时什么都不做', () => {
    const messages: Message[] = [{ role: 'user', content: '普通回合' }, receipt('call_done', 'code_editor', false)];
    const before = messages.map((m) => m.content);
    expect(resolveInterruptedDelegations(messages)).toHaveLength(0);
    expect(messages.map((m) => m.content)).toEqual(before);
  });
});
