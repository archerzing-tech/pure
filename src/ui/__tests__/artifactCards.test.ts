// src/ui/__tests__/artifactCards.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { planArtifactDisplay, artifactKindLabel, fileIconMeta, type ArtifactItem } from '../artifactCards';
import { setPathLinkWorkspace } from '../pathLink';

describe('planArtifactDisplay', () => {
  beforeEach(() => setPathLinkWorkspace(''));

  const file = (path: string): ArtifactItem => ({ path });

  it('returns none for an empty turn', () => {
    expect(planArtifactDisplay([])).toEqual({ mode: 'none' });
  });

  it('shows one card per artifact up to the threshold', () => {
    const items = [file('a.ts'), file('b.ts'), file('c.ts')];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items });
  });

  it('keeps every generated file and has no folder-card input type', () => {
    const items = [file('src/main.ts'), file('src/app.ts')];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items });
  });

  it('shows all generated files in a project', () => {
    const items = Array.from({ length: 5 }, (_, i) => file(`f${i}.ts`));
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items });
  });

  it('shows nothing when no files were generated', () => {
    expect(planArtifactDisplay([])).toEqual({ mode: 'none' });
  });
});

describe('artifactKindLabel', () => {
  it('labels folders and extension-based file types', () => {
    expect(artifactKindLabel('src')).toBe('文件');
    expect(artifactKindLabel('src/app.ts')).toBe('TS');
    expect(artifactKindLabel('README')).toBe('文件');
  });
});

describe('fileIconMeta', () => {
  it('keeps a format-specific fallback for browser/dev mode', () => {
    expect(fileIconMeta('src/app.ts').cls).toBe('artifact-icon-code');
    expect(fileIconMeta('docs/readme.md').cls).toBe('artifact-icon-doc');
    expect(fileIconMeta('assets/photo.png').cls).toBe('artifact-icon-img');
    expect(artifactKindLabel('archive.zip')).toBe('ZIP');
  });
});
