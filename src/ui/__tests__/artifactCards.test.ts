// src/ui/__tests__/artifactCards.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { planArtifactDisplay, commonRootDir, MAX_CARD_FILES, type ArtifactItem } from '../artifactCards';
import { setPathLinkWorkspace } from '../pathLink';

describe('planArtifactDisplay', () => {
  beforeEach(() => setPathLinkWorkspace(''));

  const file = (path: string): ArtifactItem => ({ path, kind: 'file' });

  it('returns none for an empty turn', () => {
    expect(planArtifactDisplay([])).toEqual({ mode: 'none' });
  });

  it('shows one card per artifact up to the threshold', () => {
    const items = [file('a.ts'), file('b.ts'), file('c.ts')];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items });
  });

  it('keeps directories as individual cards within the threshold', () => {
    const items: ArtifactItem[] = [
      { path: 'src', kind: 'dir' },
      file('src/main.ts'),
    ];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items });
  });

  it('collapses to a directory card once the threshold is exceeded', () => {
    const items = Array.from({ length: MAX_CARD_FILES + 1 }, (_, i) => file(`f${i}.ts`));
    const plan = planArtifactDisplay(items);
    expect(plan.mode).toBe('dir');
  });

  it('produces a common root for multi-file projects (past the card threshold)', () => {
    const items = [
      file('proj/src/a.ts'), file('proj/src/b.ts'), file('proj/src/c.ts'),
      file('proj/src/d.ts'), file('proj/src/e.ts'),
    ];
    const plan = planArtifactDisplay(items);
    expect(plan).toEqual({ mode: 'dir', dir: 'proj/src' });
  });

  it('falls back to the first artifact parent for scattered files', () => {
    const items = [
      file('a/x.ts'), file('b/y.ts'), file('b/z.ts'), file('c/w.ts'), file('d/v.ts'),
    ];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'dir', dir: 'a' });
  });
});

describe('commonRootDir', () => {
  beforeEach(() => setPathLinkWorkspace(''));

  const file = (path: string): ArtifactItem => ({ path, kind: 'file' });
  const dir = (path: string): ArtifactItem => ({ path, kind: 'dir' });

  it('returns null for no artifacts', () => {
    expect(commonRootDir([])).toBeNull();
  });

  it('finds the shared directory prefix', () => {
    expect(commonRootDir([file('a/b/c.ts'), file('a/b/d.ts'), file('a/b/e/f.ts')])).toBe('a/b');
  });

  it('resolves relative paths against the workspace when configured', () => {
    setPathLinkWorkspace('/ws');
    expect(commonRootDir([file('src/a.ts'), file('src/b.ts')])).toBe('ws/src');
  });

  it('handles a single file by returning its parent directory', () => {
    expect(commonRootDir([file('a/b/c.ts')])).toBe('a/b');
  });

  it('keeps a directory artifact itself as the root', () => {
    expect(commonRootDir([dir('proj/src'), file('proj/src/a.ts'), file('proj/src/b.ts')])).toBe('proj/src');
  });

  it('falls back to the first artifact parent when nothing is shared', () => {
    expect(commonRootDir([file('a/x.ts'), file('b/y.ts')])).toBe('a');
  });
});
