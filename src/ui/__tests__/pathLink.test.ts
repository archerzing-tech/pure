// src/ui/__tests__/pathLink.test.ts
// Covers the transcript path detector (findPathMatches) and the open-path
// resolver (resolvePathForOpen). Pure functions — no DOM required.

import { describe, expect, test } from 'bun:test';
import { findPathMatches, resolvePathForOpen, setPathLinkWorkspace } from '../pathLink';

function paths(text: string): string[] {
  return findPathMatches(text).map((m) => m.path);
}

describe('findPathMatches — absolute paths', () => {
  test('POSIX absolute path', () => {
    expect(paths('open /Users/foo/src/main.ts now')).toEqual(['/Users/foo/src/main.ts']);
  });

  test('absolute path with :line:col suffix keeps suffix in display text', () => {
    const m = findPathMatches('/a/b/c.ts:12:3');
    expect(m).toHaveLength(1);
    expect(m[0].path).toBe('/a/b/c.ts');
    expect(m[0].text).toBe('/a/b/c.ts:12:3');
  });

  test('line-only suffix', () => {
    expect(findPathMatches('see /a/b.ts:9')[0].path).toBe('/a/b.ts');
  });

  test('trailing sentence punctuation is trimmed', () => {
    expect(paths('check /a/b.ts.')).toEqual(['/a/b.ts']);
  });

  test('lone /tmp is matched (single component, no extension)', () => {
    // Absolute paths are unambiguous enough to allow 1 component only when
    // there is an extension; /tmp alone is not clickable to avoid noise.
    expect(paths('copy to /tmp')).toEqual([]);
    expect(paths('copy to /tmp/x')).toEqual(['/tmp/x']);
  });

  test('home-relative path', () => {
    expect(paths('at ~/project/file.ts')).toEqual(['~/project/file.ts']);
  });

  test('windows drive path', () => {
    expect(paths('open C:\\Users\\foo\\x.ts')).toEqual(['C:\\Users\\foo\\x.ts']);
  });
});

describe('findPathMatches — URLs are not paths', () => {
  test('https URL is not matched', () => {
    setPathLinkWorkspace('/ws');
    expect(paths('see https://example.com/a/b')).toEqual([]);
  });

  test('http://localhost URL is not matched', () => {
    setPathLinkWorkspace('/ws');
    expect(paths('run http://localhost:3000/foo')).toEqual([]);
  });
});

describe('findPathMatches — relative paths', () => {
  test('relative path with extension is matched when workspace is set', () => {
    setPathLinkWorkspace('/ws');
    expect(paths('fix src/ui/chat.ts')).toEqual(['src/ui/chat.ts']);
  });

  test('relative path is NOT matched without a workspace', () => {
    setPathLinkWorkspace('');
    expect(paths('fix src/ui/chat.ts')).toEqual([]);
  });

  test('a/b without extension is not matched', () => {
    setPathLinkWorkspace('/ws');
    expect(paths('the ratio a/b is fine')).toEqual([]);
  });

  test('directory with trailing slash is matched', () => {
    setPathLinkWorkspace('/ws');
    expect(paths('look at src/components/')).toEqual(['src/components/']);
  });

  test('dot-prefixed relative paths', () => {
    setPathLinkWorkspace('/ws');
    expect(paths('run ./scripts/build.sh')).toEqual(['./scripts/build.sh']);
    expect(paths('run ../lib/helper.ts')).toEqual(['../lib/helper.ts']);
  });
});

describe('resolvePathForOpen', () => {
  test('relative path resolves against the workspace', () => {
    setPathLinkWorkspace('/Users/me/proj');
    expect(resolvePathForOpen('src/ui/chat.ts')).toBe('/Users/me/proj/src/ui/chat.ts');
  });

  test('relative path with line suffix strips it and resolves', () => {
    setPathLinkWorkspace('/Users/me/proj');
    expect(resolvePathForOpen('src/ui/chat.ts:12')).toBe('/Users/me/proj/src/ui/chat.ts');
  });

  test('absolute path is left unchanged', () => {
    expect(resolvePathForOpen('/tmp/x.ts')).toBe('/tmp/x.ts');
  });

  test('windows absolute path is left unchanged', () => {
    expect(resolvePathForOpen('C:\\Users\\foo\\x.ts')).toBe('C:\\Users\\foo\\x.ts');
  });

  test('home path stays ~ (Rust expands it)', () => {
    expect(resolvePathForOpen('~/project/x.ts')).toBe('~/project/x.ts');
  });
});
