// src/shared/__tests__/thirdPartyScope.test.ts
import { describe, expect, it } from 'bun:test';
import { isThirdPartyPath, THIRD_PARTY_DIR_NAMES } from '../thirdPartyScope';

describe('isThirdPartyPath (三方件默认不在理解范围)', () => {
  it('hits a dependency directory at any depth', () => {
    expect(isThirdPartyPath('node_modules/pkg/index.js')).toBe(true);
    expect(isThirdPartyPath('project/.venv/lib/python3.12/x.py')).toBe(true);
    expect(isThirdPartyPath('deep/nested/node_modules/q.js')).toBe(true);
    expect(isThirdPartyPath('Pods/AFNetworking/README.md')).toBe(true);
    expect(isThirdPartyPath('target/debug/build/out')).toBe(true);
  });

  it('matches directory segments case-insensitively', () => {
    expect(isThirdPartyPath('project/Node_modules/x.js')).toBe(true);
    expect(isThirdPartyPath('Vendor/lib.rb')).toBe(true);
  });

  it('never hits a first-party file that merely contains a dir name in its FILENAME', () => {
    // `src/target.ts` splits to ['src', 'target.ts'] — no bare 'target' segment.
    expect(isThirdPartyPath('src/target.ts')).toBe(false);
    expect(isThirdPartyPath('scripts/build.py')).toBe(false);
    expect(isThirdPartyPath('src/app/main.ts')).toBe(false);
  });

  it('understands Windows separators', () => {
    expect(isThirdPartyPath('src\\node_modules\\x.js')).toBe(true);
    expect(isThirdPartyPath('src\\app\\main.ts')).toBe(false);
  });

  it('answers false for empty and bare names that are not dependency dirs', () => {
    expect(isThirdPartyPath('')).toBe(false);
    expect(isThirdPartyPath('src')).toBe(false);
  });

  it('keeps the canonical set the tools advertise', () => {
    // The tool descriptions promise these; removing one here silently
    // un-hides it from listing/glob/find/rg at once.
    for (const dir of ['node_modules', 'site-packages', '.venv', 'venv', 'vendor', 'Pods', 'target', 'dist', 'build', '.git']) {
      expect(THIRD_PARTY_DIR_NAMES).toContain(dir);
    }
  });
});
