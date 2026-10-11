import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_CHARACTER_PROFILE,
  VETERAN_FAST_CORE_PROMPT,
  VETERAN_FAST_KERNEL_VERSION,
  VETERAN_FAST_LINES,
  type CharacterDecisionProfile,
} from '../index';

// 人格轨道 刀 2 的机制面（docs/persona-core-upgrade.md §1、铁律 1）：
//   ① 内核叙事三方版本一致（源句表 / profile / .md 镜像头行）；
//   ② .md 人读镜像与源句表**逐字同文**——改一边不改另一边即红；
//   ③ 注入文本真的带上每条源句（否则内核通道是空的）；
//   ④ 铁律 1：决策面每个旋钮的每个源句 id 都真存在；
//   ⑤ 红线 1/2 的负向锁：注入文本里不许出现谄媚 / 陪伴话术。
const MIRROR = readFileSync(new URL('../kernels/veteran-fast.md', import.meta.url), 'utf8');
const CORE = DEFAULT_CHARACTER_PROFILE.core;

describe('性格内核「老手快线」v0（刀 2）', () => {
  it('三方版本一致：源句表 / profile / .md 镜像', () => {
    expect(VETERAN_FAST_KERNEL_VERSION).toBe('v0');
    expect(DEFAULT_CHARACTER_PROFILE.version).toBe(VETERAN_FAST_KERNEL_VERSION);
    expect(MIRROR).toContain('veteran-fast');
    expect(MIRROR).toContain('v0');
  });

  it('源句表非空且 id 唯一（K1…Kn 顺序即注入顺序）', () => {
    const ids = Object.keys(VETERAN_FAST_LINES);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ids).size).toBe(ids.length);
    for (const text of Object.values(VETERAN_FAST_LINES)) {
      expect(text.trim().length).toBeGreaterThan(20);
    }
  });

  it('.md 人读镜像与源句表逐字同文（含 id）', () => {
    for (const [id, text] of Object.entries(VETERAN_FAST_LINES)) {
      expect(MIRROR).toContain(`\`${id}\``);
      expect(MIRROR).toContain(text);
    }
  });

  it('注入文本带 <character_core> 框架与全部源句，且不臃肿', () => {
    expect(CORE.startsWith('<character_core>')).toBe(true);
    expect(CORE.endsWith('</character_core>')).toBe(true);
    for (const text of Object.values(VETERAN_FAST_LINES)) {
      expect(CORE).toContain(text);
    }
    // 每回合都要付这份 token：给它一个上限，防内核叙事无节制长大。
    expect(CORE.length).toBeLessThan(2_000);
  });

  it('profile.core 与内核装配函数同源（不是手抄第二份）', () => {
    expect(CORE).toBe(VETERAN_FAST_CORE_PROMPT);
  });

  it('铁律 1：决策面每个旋钮都标注了推导源句，且 id 真存在', () => {
    const knobs = Object.keys(DEFAULT_CHARACTER_PROFILE.decision) as Array<keyof CharacterDecisionProfile>;
    expect(Object.keys(DEFAULT_CHARACTER_PROFILE.decisionDerivation).sort()).toEqual([...knobs].sort());
    for (const knob of knobs) {
      const sources = DEFAULT_CHARACTER_PROFILE.decisionDerivation[knob];
      expect(sources.length).toBeGreaterThan(0);
      for (const id of sources) {
        expect(VETERAN_FAST_LINES[id]).toBeDefined();
        expect(MIRROR).toContain(`\`${id}\``);
      }
    }
  });

  it('红线 1/2 负向锁：注入文本不含谄媚 / 陪伴话术', () => {
    const banned = [
      'always be here',
      'always here for you',
      "I'm always",
      '陪着你',
      '我一直',
      'hope this helps',
      'Hope this helps',
      'Great question',
      'Certainly!',
    ];
    for (const phrase of banned) {
      expect(CORE).not.toContain(phrase);
    }
  });
});
