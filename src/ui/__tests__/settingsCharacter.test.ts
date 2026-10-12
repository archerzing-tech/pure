import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { listCharacterProfiles } from '../../character';

// 人格轨道 刀 5 的设置页接线锁。
//
// 为什么用静态断言而不是渲染测试：设置面板是一个 4600 行的 DOM 类（静态标记在
// index.html、读写散在 loadToForm / gatherConfig / autoSave 三处），仓库对它的
// 既有纪律是「不靠单元测试、靠源码断言锁接线」（同 cli-intent.test.ts 的写法）。
// 这里锁的是最容易在重命名时静默坏掉的三处**同名契约**：
//   ① index.html 的 #cfg-character 存在（否则选择器渲染到空气上）；
//   ② settings.ts 同时**读**它（loadToForm）与**写**它（gatherConfig）；
//   ③ i18n 两套语言都有那一行的键（否则界面上是原始 key 或英文兜底）。
const HTML = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../settings.ts', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../../shared/i18n.ts', import.meta.url), 'utf8');

describe('Settings → General → 性格（刀 5）', () => {
  it('index.html 有选择器，且选项由名册动态渲染（不是写死的两项）', () => {
    expect(HTML).toContain('id="cfg-character"');
    expect(HTML).toContain('data-i18n="general.character"');
    // 写死选项会让「加内核」必须改 HTML——刀 5 的裁定是选项来自 registry。
    expect(HTML).not.toMatch(/<select id="cfg-character"[^>]*>\s*<option/);
  });

  it('settings.ts 读、写、注入三件事都在（同一个 id 契约）', () => {
    expect(SETTINGS).toContain("getElementById('cfg-character')");
    expect(SETTINGS).toContain('renderCharacterOptions');
    expect(SETTINGS).toContain('setActiveCharacterProfile(select.value)');
    // 存档面：gatherConfig 里必须有这个字段，否则选完一刷新就回默认内核。
    expect(SETTINGS).toContain('characterProfileId:');
  });

  it('i18n 中英两套都有该行的键', () => {
    for (const key of ['general.character', 'general.character.hint']) {
      expect((I18N.match(new RegExp(`'${key.replace('.', '\\.')}'`, 'g')) ?? []).length).toBe(2);
    }
  });

  it('名册里至少两个内核可选（只有一个的话这行没意义）', () => {
    expect(listCharacterProfiles().length).toBeGreaterThanOrEqual(2);
  });
});
