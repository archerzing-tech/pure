// src/ui/__tests__/artifactCards.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { planArtifactDisplay, isIntermediateArtifact, isDataDumpPair, artifactKindLabel, fileIconMeta, type ArtifactItem } from '../artifactCards';
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

  it('drops intermediate data dumps (weather_raw + weather pair) from the result cards', () => {
    // The model stashed fetched weather data mid-answer as weather_raw.js +
    // weather.js; only the real artifact the user asked for survives.
    const items = [
      file('weather_raw.js'),
      file('weather.js'),
      file('game.html'),
    ];
    expect(planArtifactDisplay(items)).toEqual({
      mode: 'files',
      items: [file('game.html')],
    });
  });

  it('hides a turn whose only writes were intermediate dumps', () => {
    expect(planArtifactDisplay([file('weather_raw.js'), file('weather.js')])).toEqual({ mode: 'none' });
    expect(planArtifactDisplay([file('raw_data.json')])).toEqual({ mode: 'none' });
    expect(planArtifactDisplay([file('config.tmp')])).toEqual({ mode: 'none' });
  });
});

describe('isIntermediateArtifact', () => {
  it('flags raw-data dump names', () => {
    expect(isIntermediateArtifact('weather_raw.js')).toBe(true);
    expect(isIntermediateArtifact('raw_data.json')).toBe(true);
    expect(isIntermediateArtifact('notes.raw')).toBe(true);
    expect(isIntermediateArtifact('src/result_raw.sql')).toBe(true);
  });

  it('flags scratch / temp suffixes', () => {
    expect(isIntermediateArtifact('config.tmp')).toBe(true);
    expect(isIntermediateArtifact('config.bak')).toBe(true);
    expect(isIntermediateArtifact('index.html~')).toBe(true);
    expect(isIntermediateArtifact('report.orig')).toBe(true);
  });

  it('keeps real deliverables', () => {
    expect(isIntermediateArtifact('game.html')).toBe(false);
    expect(isIntermediateArtifact('weather.html')).toBe(false);
    expect(isIntermediateArtifact('src/app.ts')).toBe(false);
  });
});

describe('isDataDumpPair', () => {
  it('matches a tidy data file next to its raw sibling', () => {
    const all = ['weather_raw.js', 'weather.js'];
    expect(isDataDumpPair('weather.js', all)).toBe(true);
    expect(isDataDumpPair('weather.json', ['weather_raw.js', 'weather.json'])).toBe(true);
    expect(isDataDumpPair('report.md', ['report_raw.md', 'report.md'])).toBe(true);
  });

  it('never matches html/py/etc deliverables even with a raw sibling', () => {
    const all = ['weather_raw.js', 'weather.html'];
    expect(isDataDumpPair('weather.html', all)).toBe(false);
    const code = ['data_raw.json', 'app.py'];
    expect(isDataDumpPair('app.py', code)).toBe(false);
  });

  it('is false without a raw sibling', () => {
    expect(isDataDumpPair('weather.js', ['weather.js'])).toBe(false);
    expect(isDataDumpPair('data.json', ['data.json', 'chart.ts'])).toBe(false);
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
