// 9.2 — phase-model override normalization shared by the GUI and the CLI.
import { describe, expect, test } from 'bun:test';
import { mergePhaseModelConfig, phaseModelOverrides } from '../phaseModels';

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
