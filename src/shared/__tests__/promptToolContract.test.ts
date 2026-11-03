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

describe('正向锚：一线 web 工具的用法教学应住在模型可见的描述面（本次修复缺陷的正向面）', () => {
  // 以读到的源文本事实为准：2026-11-03 B 档把 web 工具教学从 PromptAssembler
  // 的 capabilities 常量迁入 toolDefs 的 description（模型选工具时描述恰在
  // 眼前；调用签名由 schema 的 parameters 承载，描述面教的是用法判据）。
  // 锚随教学走：一线 web 工具必须保持公开可见，且用法教学必须持续住在工具
  // 描述里——而不是默默删除本断言。

  const defOf = (name: string) => BUILT_IN_TOOL_DEFS.find((def) => def.name === name);

  it('web_search 公开可见且 description 教重述纪律（失败不原样重试）', () => {
    expect(PUBLIC_TOOL_NAMES.has('web_search')).toBe(true);
    expect(defOf('web_search')?.description).toContain('do NOT repeat the same or a near-identical query');
  });

  it('web_fetch 公开可见且 description 教换页纪律与公共 API 目录兜底', () => {
    expect(PUBLIC_TOOL_NAMES.has('web_fetch')).toBe(true);
    const description = defOf('web_fetch')?.description ?? '';
    expect(description).toContain('do NOT retry the same URL');
    expect(description).toContain('public-apis');
  });
});
