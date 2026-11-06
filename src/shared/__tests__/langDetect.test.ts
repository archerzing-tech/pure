// src/shared/__tests__/langDetect.test.ts
// 思考/输出语言对齐（2026-10-09 用户需求）的判定契约。2026-11-06 P3 判定源
// 收口：user 消息前面拼着注入块围栏，判定前先剥掉只看真人自己的话；显式
// 指令离开 system 尾部，随 user-turn 注入件走（语言切换不再打断前缀缓存）。

import { describe, expect, it } from 'bun:test';
import {
  detectReplyLanguage,
  replyLanguageDirective,
  stripInjectionBlocks,
} from '../langDetect';

describe('stripInjectionBlocks（剥离注入块围栏）', () => {
  it('剥掉头部注入块，留下真人文本', () => {
    const msg = '<task_context>\n背景资料一堆\n</task_context>\n\n今天天气不错';
    expect(stripInjectionBlocks(msg)).toBe('今天天气不错');
  });

  it('三种围栏（task_context/session_memory/adaptive_context）都剥', () => {
    expect(stripInjectionBlocks('<session_memory>\n记性\n</session_memory>\n正文')).toBe('正文');
    expect(stripInjectionBlocks('<adaptive_context>\nX\n</adaptive_context>\n正文')).toBe('正文');
  });

  it('无注入块的输入原样返回（普通回合常态）', () => {
    expect(stripInjectionBlocks('直接说事')).toBe('直接说事');
    expect(stripInjectionBlocks('')).toBe('');
  });

  it('真人文本里出现同名闭合字样不误剥（围栏成对才剥）', () => {
    expect(stripInjectionBlocks('帮我看看 </task_context> 这个正则为什么贪心')).toBe(
      '帮我看看 </task_context> 这个正则为什么贪心',
    );
  });
});

describe('detectReplyLanguage（中英混杂看主要文字）', () => {
  it('纯中文 → zh；纯英文 → en', () => {
    expect(detectReplyLanguage('帮我看看这个崩溃的堆栈怎么回事')).toBe('zh');
    expect(detectReplyLanguage('Please take a look at this crash stack and explain the root cause.')).toBe('en');
  });

  it('中文夹英文关键词/代码（编程提问常态）→ zh', () => {
    // 主要文字是中文：API 名、代码 token 再多也只是点缀。
    expect(detectReplyLanguage('这个 useEffect 为什么会无限重渲染？deps 里我传了 [] 但每次 setState 都触发')).toBe('zh');
    expect(detectReplyLanguage('帮我把 config.provider 改成 deepseek-openai，注意 baseURL 要走代理')).toBe('zh');
  });

  it('英文夹少量中文 → en', () => {
    expect(detectReplyLanguage('Please fix this bug — the label should say 已完成 instead of the raw id.')).toBe('en');
  });

  it('空串/机器串（json/路径片段）→ zh（默认会话语言）', () => {
    expect(detectReplyLanguage('')).toBe('zh');
    expect(detectReplyLanguage('{"json":"only"}')).toBe('zh');
    expect(detectReplyLanguage('~/work/config.json')).toBe('zh');
  });

  it('注入块灌满样本也判真人语言（P3 污染定案回归锚）', () => {
    // GUI 的 user 消息 = 注入块 + 真人文本；中文真人文本排在 2000 字符
    // 样本之外也要被判对——剥离发生在采样之前。
    const filler = '<session_memory>\n' + '英文 memory digest line here. '.repeat(80) + '\n</session_memory>\n';
    expect(detectReplyLanguage(filler + '继续这个任务，先跑一下测试')).toBe('zh');
  });

  it('纯英文真人文本不被中文注入块带偏', () => {
    const filler = '<task_context>\n' + '中文背景资料确实很长。'.repeat(120) + '\n</task_context>\n';
    expect(detectReplyLanguage(filler + 'Run the full test suite before pushing.')).toBe('en');
  });
});

describe('replyLanguageDirective（user-turn 注入指令）', () => {
  it('zh/en 两档各给一句显式指令（含思考）', () => {
    expect(replyLanguageDirective('zh')).toContain('中文');
    expect(replyLanguageDirective('en')).toContain('English');
  });
});
