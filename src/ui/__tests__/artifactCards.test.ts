// src/ui/__tests__/artifactCards.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { planArtifactDisplay, isIntermediateArtifact, isDataDumpPair, artifactKindLabel, fileIconMeta, MAX_FILE_CARDS, isCardFriendlyArtifact, type ArtifactItem } from '../artifactCards';
import { setPathLinkWorkspace } from '../pathLink';

describe('planArtifactDisplay', () => {
  beforeEach(() => setPathLinkWorkspace(''));

  const file = (path: string): ArtifactItem => ({ path });

  it('returns none for an empty turn', () => {
    expect(planArtifactDisplay([])).toEqual({ mode: 'none' });
  });

  it('hides a lone implementation file when there is no final deliverable context', () => {
    const items = [file('src/main.ts')];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'none' });
  });

  it('shows an explicitly requested script as a file card', () => {
    const items = [file('tools/report.py')];
    expect(planArtifactDisplay(items, { userRequest: '请写一个 Python 脚本' })).toEqual({ mode: 'files', items });
  });

  it('recognizes an explicitly requested English script as a deliverable', () => {
    const items = [file('tools/report.py')];
    expect(planArtifactDisplay(items, { userRequest: 'Write a Python script to build the report' })).toEqual({ mode: 'files', items });
  });

  it('deduplicates repeated writes of the same path before applying the card limit', () => {
    const items = [file('README.md'), file('./README.md'), file('README.MD')];
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items: [file('README.md')] });
  });

  it('shows up to ten office/text documents as cards', () => {
    const items = ['brief.md', 'notes.txt', 'proposal.docx', 'slides.pptx', 'budget.xlsx', 'table.csv', 'page.html', 'readme.pdf', 'memo.rtf', 'summary.odt'].map(file);
    expect(items).toHaveLength(MAX_FILE_CARDS);
    expect(planArtifactDisplay(items)).toEqual({ mode: 'files', items });
  });

  it('uses one project-directory link for a multi-file coding project', () => {
    const items = [file('src/main.ts'), file('src/app.ts'), file('package.json'), file('src/app.css')];
    expect(planArtifactDisplay(items, { userRequest: '生成一个 coding 项目' })).toEqual({ mode: 'project', items });
  });

  it('hides helper scripts when the final purpose is an image', () => {
    const items = [file('tools/draw.py'), file('output.png')];
    expect(planArtifactDisplay(items, { userRequest: '画一幅风景画' })).toEqual({
      mode: 'files',
      items: [file('output.png')],
    });
  });

  it('hides helper scripts when the final purpose is a document', () => {
    const items = [file('tools/build_report.py'), file('report.docx')];
    expect(planArtifactDisplay(items, { userRequest: '写一份项目报告' })).toEqual({
      mode: 'files',
      items: [file('report.docx')],
    });
  });

  it('shows nothing when an image/document task only leaves helper scripts', () => {
    expect(planArtifactDisplay([file('tools/render.js')], { userRequest: '制作一张海报' })).toEqual({ mode: 'none' });
  });

  it('uses the project-directory link when card-friendly files exceed ten', () => {
    const items = Array.from({ length: MAX_FILE_CARDS + 1 }, (_, i) => file(`notes-${i}.md`));
    expect(planArtifactDisplay(items)).toEqual({ mode: 'project', items });
  });

  it('uses the project-directory link for mixed documents and project files', () => {
    const items = [file('README.md'), file('index.html'), file('src/main.ts')];
    expect(planArtifactDisplay(items, { userRequest: '生成一个网页项目' })).toEqual({ mode: 'project', items });
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

  it('hides stashed data files for an informational/planning request', () => {
    const items = [file('weather.json'), file('flights.json'), file('hotels.json')];
    expect(planArtifactDisplay(items, { userRequest: '帮我制定一个从西安到上海的旅游规划' })).toEqual({ mode: 'none' });
  });

  it('keeps the project-directory link for a multi-file build without a project noun', () => {
    const items = [file('crawler.py'), file('crawler/utils.py')];
    expect(planArtifactDisplay(items, { userRequest: '帮我开发一个爬虫' })).toEqual({ mode: 'project', items });
  });
});

describe('isCardFriendlyArtifact', () => {
  it('accepts office/text/script documents but not general project files', () => {
    expect(isCardFriendlyArtifact('README.md')).toBe(true);
    expect(isCardFriendlyArtifact('deploy.sh')).toBe(true);
    expect(isCardFriendlyArtifact('slides.pptx')).toBe(true);
    expect(isCardFriendlyArtifact('src/main.ts')).toBe(false);
    expect(isCardFriendlyArtifact('package.json')).toBe(false);
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
