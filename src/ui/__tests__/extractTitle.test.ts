// src/ui/__tests__/extractTitle.test.ts
// 标题规则测试：取首条用户消息前 6 个字，超长加省略号（2026-09-26 用户定调
// 「标题用用户输入的前5-6个字，太长就…」）。TS/Rust 两侧同规则，这里锁 TS 侧；
// Rust 侧 extract_title（lib.rs）靠同一注释锚定，无 Rust 测试。

import { describe, expect, it } from 'bun:test';
import { extractTitle } from '../store';
import type { Message } from '../../shared/types';

const msg = (content: string): Message => ({ role: 'user', content } as Message);

describe('extractTitle 标题截断规则', () => {
  it('恰好 6 个字：原样保留，不加省略号', () => {
    expect(extractTitle([msg('帮我订个机票')])).toBe('帮我订个机票');
  });

  it('超过 6 个字：截到 6 字加省略号', () => {
    expect(extractTitle([msg('帮我调研三家数据库公司并给出选型建议')])).toBe('帮我调研三家…');
  });

  it('按字符截断：emoji 等多码元字符不可被劈开', () => {
    // 🌍 是 2 个 UTF-16 码元——按码元取 6 个字符，绝不能出现半个 emoji。
    const title = extractTitle([msg('🌍🌍🌍🌍🌍🌍🌍 hello')]);
    expect(title).toBe('🌍🌍🌍🌍🌍🌍…');
  });

  it('首条用户消息才有效：assistant 打头不算', () => {
    expect(extractTitle([
      { role: 'assistant', content: '你好，有什么可以帮你？' } as Message,
      msg('查一下天气'),
    ])).toBe('查一下天气');
  });

  it('没有用户消息：回退 New chat', () => {
    expect(extractTitle([{ role: 'assistant', content: 'hi' } as Message])).toBe('New chat');
    expect(extractTitle([])).toBe('New chat');
  });
});
