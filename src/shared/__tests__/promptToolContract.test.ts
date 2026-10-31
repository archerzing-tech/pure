// src/shared/__tests__/promptToolContract.test.ts
// 「提示词 ↔ 工具集」契约测试（2026-10-31 审计 §2.1/§4.7）。
// 病根：提示词多处教模型调用 web_search/web_fetch，而这两个名字不在
// PUBLIC_TOOL_NAMES 里——模型被指引去调一个它看不见的工具。
// 本测试锁住这一类回归：凡 BUILT_IN_TOOL_DEFS 有定义、但被 PUBLIC_TOOL_NAMES
// 排除的 built-in 工具名，不得以 `name(` 调用形态出现在三份提示源文本里。
// 测法：读源码文本（不 import 提示模块——要验的是提示词字面本身），
// 用「隐藏名单」驱动，而不是从提示里正则抓工具名（避免 sys_info() 这类
// 正文明白工具的假阳性）。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILT_IN_TOOL_DEFS, PUBLIC_TOOL_NAMES } from '../toolDefs';

/** 三份系统提示源文件（新增提示源时在此登记）。 */
const PROMPT_SOURCE_FILES = ['PromptAssembler.ts', 'promptLayers.ts', 'agentBehavior.ts'] as const;

const SOURCES = PROMPT_SOURCE_FILES.map((file) => ({
  file,
  text: readFileSync(join(import.meta.dir, '..', file), 'utf8'),
}));

const hiddenToolNames = (): string[] =>
  BUILT_IN_TOOL_DEFS.map((def) => def.name).filter((name) => !PUBLIC_TOOL_NAMES.has(name));

/**
 * 调用形态：工具名紧跟 `(`（允许中间空白）。
 * 前置 `\b` 词边界防止子串误伤：`search_files(` 不会被 `code_searcher(`
 * 或假想的 `pre_search_files(` 触发（`_` 属词字符，跨它不成边界）。
 * built-in 工具名都是纯标识符，无正则元字符，直接内插安全。
 */
const callForm = (name: string): RegExp => new RegExp(`\\b${name}\\s*\\(`);

/** 命中调用形态的源码行（截断后用于失败信息定位）。 */
function callFormHits(text: string, name: string): string[] {
  const re = callForm(name);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => re.test(line))
    .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line));
}

describe('提示词 ↔ 工具集契约（审计 §2.1/§4.7）', () => {
  it('隐藏 built-in 工具清单现状 == [search_files]（新增隐藏工具必须显式过目此清单，防断言空转）', () => {
    expect(hiddenToolNames()).toEqual(['search_files']);
  });

  it('隐藏 built-in 工具不得以调用形态出现在三份提示源文本里', () => {
    const hidden = hiddenToolNames();
    // 空隐藏集会让逐名断言空转（永远绿），先钉非空。
    expect(hidden.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const name of hidden) {
      for (const { file, text } of SOURCES) {
        for (const line of callFormHits(text, name)) {
          violations.push(`${file}: 教模型调用看不见的工具 ${name}( → ${line}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('正向锚：一线 web 工具应以调用形态被提示词教到（本次修复缺陷的正向面）', () => {
  // 以读到的源文本事实为准：调用形态的锚点当前在 PromptAssembler 的联网
  // 工具清单里（web_search(query, maxResults?) / web_fetch(url, maxChars?)）。
  // 若将来提示词改写导致锚点消失，这里会红——届时应确认新文案仍在教调用，
  // 而不是默默删除本断言。

  it('web_search 以调用形态出现在 PromptAssembler.ts 里', () => {
    const assembler = SOURCES.find((s) => s.file === 'PromptAssembler.ts');
    expect(assembler).toBeDefined();
    expect(callFormHits(assembler!.text, 'web_search').length).toBeGreaterThan(0);
  });

  it('web_fetch 以调用形态出现在 PromptAssembler.ts 里', () => {
    const assembler = SOURCES.find((s) => s.file === 'PromptAssembler.ts');
    expect(assembler).toBeDefined();
    expect(callFormHits(assembler!.text, 'web_fetch').length).toBeGreaterThan(0);
  });
});
