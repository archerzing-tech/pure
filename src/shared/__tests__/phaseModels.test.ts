// 9.2 — phase-model override normalization shared by the GUI and the CLI.
import { describe, expect, test } from 'bun:test';
import { judgeModelFor, mergePhaseModelConfig, phaseModelOverrides, reflectModelFor, sanitizePhaseModelConfig } from '../phaseModels';

describe('phaseModelOverrides', () => {
  test('keeps only phases that actually reroute', () => {
    const out = phaseModelOverrides(
      { think: 'glm-5.3', handover: 'glm-4.5-flash', reflect: 'glm-4.5-flash' },
      'glm-5.3-flash',
    );
    expect(out).toEqual({ THINK: 'glm-5.3', HANDOVER: 'glm-4.5-flash', REFLECT: 'glm-4.5-flash' });
  });

  test('drops values equal to the main model (no shadow adapter)', () => {
    const out = phaseModelOverrides({ think: 'glm-5.3-flash' }, 'glm-5.3-flash');
    expect(out).toEqual({});
  });

  test('drops blank and whitespace-only values, trims the rest', () => {
    const out = phaseModelOverrides(
      { think: '  glm-5.3  ', handover: '   ', reflect: undefined },
      'main',
    );
    expect(out).toEqual({ THINK: 'glm-5.3' });
  });

  test('undefined config yields an empty map (llmFor stays unset)', () => {
    expect(phaseModelOverrides(undefined, 'glm-5.3-flash')).toEqual({});
  });
});

describe('mergePhaseModelConfig', () => {
  test('flags win per field, untouched fields keep the persisted value', () => {
    const merged = mergePhaseModelConfig(
      { think: 'glm-5.3', reflect: 'glm-4.5-flash' },
      { think: 'glm-5.2' },
    );
    expect(merged).toEqual({ think: 'glm-5.2', reflect: 'glm-4.5-flash' });
  });

  test('blank flags do not erase persisted values', () => {
    const merged = mergePhaseModelConfig({ reflect: 'cheap-model' }, { reflect: '  ' });
    expect(merged).toEqual({ reflect: 'cheap-model' });
  });

  test('no base and no flags yields undefined (config stays unset)', () => {
    expect(mergePhaseModelConfig(undefined, {})).toBeUndefined();
    expect(mergePhaseModelConfig(undefined, { think: '' })).toBeUndefined();
  });
});

// P0-2 — sleep-time reflection / overlay drafting resolves its model through
// the same REFLECT override the in-turn reflector uses (E0.3 contract), so the
// cheap-channel guard applies to every host that holds a single adapter.
describe('reflectModelFor', () => {
  test('returns the REFLECT override when routing is on', () => {
    expect(reflectModelFor({ reflect: 'glm-4.5-flash' }, 'glm-5.3-flash')).toBe('glm-4.5-flash');
  });

  test('undefined when unset, blank, or equal to the main model — caller falls back to its main adapter', () => {
    expect(reflectModelFor(undefined, 'glm-5.3-flash')).toBeUndefined();
    expect(reflectModelFor({ reflect: '  ' }, 'glm-5.3-flash')).toBeUndefined();
    expect(reflectModelFor({ reflect: 'glm-5.3-flash' }, 'glm-5.3-flash')).toBeUndefined();
  });

  test('other phases never leak into the reflect slot', () => {
    expect(reflectModelFor({ think: 'glm-5.3' }, 'glm-5.3-flash')).toBeUndefined();
  });
});

// 刀 4.2 — 判例轻档（插话分类/聚焦点名/语义路由）的模型解析：配置门控，
// 未配置/配了主模型本身时调用方回退现有链，行为与轻档引入前一致。
describe('judgeModelFor', () => {
  test('returns the judge override when set and different from the main model', () => {
    expect(judgeModelFor({ judge: 'glm-4.5-flash' }, 'glm-5.3-flash')).toBe('glm-4.5-flash');
  });

  test('undefined when unset, blank, or equal to the main model (no shadow adapter)', () => {
    expect(judgeModelFor(undefined, 'glm-5.3-flash')).toBeUndefined();
    expect(judgeModelFor({ judge: '  ' }, 'glm-5.3-flash')).toBeUndefined();
    expect(judgeModelFor({ judge: 'glm-5.3-flash' }, 'glm-5.3-flash')).toBeUndefined();
  });

  test('engine phases never leak into the judge slot', () => {
    expect(judgeModelFor({ reflect: 'glm-4.5-flash', think: 'glm-4.5-air' }, 'glm-5.3-flash')).toBeUndefined();
  });

  test('sanitize and merge both carry the judge field (config + --judge-model)', () => {
    expect(sanitizePhaseModelConfig({ judge: '  glm-4.5-flash ', reflect: '' })).toEqual({ judge: 'glm-4.5-flash' });
    expect(mergePhaseModelConfig({ reflect: 'glm-4.5-flash' }, { judge: 'glm-4.5-air' })).toEqual({ reflect: 'glm-4.5-flash', judge: 'glm-4.5-air' });
    // 空串 flag 不抹掉持久化值。
    expect(mergePhaseModelConfig({ judge: 'glm-4.5-flash' }, { judge: '  ' })).toEqual({ judge: 'glm-4.5-flash' });
  });
});
