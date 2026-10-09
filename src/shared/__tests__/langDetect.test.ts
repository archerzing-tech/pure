// src/shared/__tests__/langDetect.test.ts
// 思考/输出语言对齐（2026-10-09 用户需求）的检测与注入契约。背景：提示词
// 里"Match the user's language"的教学实测拦不住思考跑英文——机制化：每轮
// 按用户输入的主要文字判定，显式指令挂 system prompt 尾部（可替换标记幂等）。

import { describe, expect, it } from 'bun:test';
import {
  applyLanguageDirective,
  detectReplyLanguage,
  lastHumanUserText,
  replyLanguageDirective,
} from '../langDetect';

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
});

describe('applyLanguageDirective（幂等注入）', () => {
  it('把指令挂到 system prompt 尾部的可替换标记里', () => {
    const out = applyLanguageDirective('BASE PROMPT', replyLanguageDirective('zh'));
    expect(out).toContain('BASE PROMPT');
    expect(out).toContain('<user_language>用户要求用中文来思考与输出。</user_language>');
  });

  it('重复应用替换旧标记，不一行行堆积（续跑重注入幂等）', () => {
    const once = applyLanguageDirective('BASE', replyLanguageDirective('zh'));
    const twice = applyLanguageDirective(once, replyLanguageDirective('en'));
    expect(twice.match(/<user_language>/g)?.length).toBe(1);
    expect(twice).toContain('The user expects reasoning and output in English.');
    expect(twice).not.toContain('用户要求用中文');
  });
});

describe('lastHumanUserText（internal 不代表用户）', () => {
  it('取最后一条非 internal 的真人输入', () => {
    const lang = detectReplyLanguage(lastHumanUserText([
      { role: 'user', content: '你好，帮我看看这个崩溃的堆栈是怎么回事' },
      { role: 'assistant', content: 'ok' },
      // 宿主代劳的续跑/修复轮是英文机器话，语言不代表用户——必须跳过。
      { role: 'user', content: 'Resume the paused branch from its checkpoint.', internal: true },
    ]));
    expect(lang).toBe('zh');
  });

  it('全是 internal 时退化为空串 → 默认 zh', () => {
    expect(lastHumanUserText([{ role: 'user', content: 'machine turn', internal: true }])).toBe('');
  });
});
