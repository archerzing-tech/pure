// src/ui/__tests__/pathIndex.test.ts
// Roadmap 阶段 11.2 (P1): the pure half of workspace path repair. Every case
// here is a refusal as much as a fix — a wrong rewrite sends the agent to edit
// the wrong file, which is worse than not correcting anything.

import { describe, expect, it } from 'bun:test';
import { correctWorkspacePaths, getPathIndex, resetPathIndex, warmPathIndex } from '../pathIndex';

const INDEX = [
  'README.md',
  'src/app.ts',
  'src/api.ts',
  'src/shared/types.ts',
  'src/ui/chat.ts',
  'src/ui/main.ts',
  'src/ui/panels/main.tsx',
  '改进进度记录.md',
];

const correct = (text: string, paths: readonly string[] = INDEX) => correctWorkspacePaths(text, paths);

describe('correctWorkspacePaths (pure)', () => {
  it('repairs a slipped filename and reports the pair', () => {
    const result = correct('看一下 src/ui/mian.ts 里的 sendMessage');
    expect(result.text).toBe('看一下 src/ui/main.ts 里的 sendMessage');
    expect(result.repairs).toEqual([{ from: 'src/ui/mian.ts', to: 'src/ui/main.ts' }]);
  });

  it('repairs a slipped directory or extension', () => {
    expect(correct('看看 sr/ui/main.ts').text).toBe('看看 src/ui/main.ts');
    expect(correct('打开 src/ui/main.lts').text).toBe('打开 src/ui/main.ts');
  });

  it('repairs Chinese-named files too', () => {
    expect(correct('更新 改进进度记彔.md').text).toBe('更新 改进进度记录.md');
  });

  it('leaves a path that exists exactly as it is', () => {
    const result = correct('把 src/ui/main.ts 里的重复逻辑抽出来');
    expect(result.text).toBe('把 src/ui/main.ts 里的重复逻辑抽出来');
    expect(result.repairs).toEqual([]);
  });

  it('refuses to guess when two candidates are equally close', () => {
    // src/app.ts and src/api.ts are both one slip away from src/ap.ts.
    const result = correct('改一下 src/ap.ts');
    expect(result.text).toBe('改一下 src/ap.ts');
    expect(result.repairs).toEqual([]);
  });

  it('never rewrites inside fenced code', () => {
    const draft = '这段代码\n```\nimport x from "src/ui/mian.ts"\n```\n有问题';
    expect(correct(draft).text).toBe(draft);
  });

  it('leaves a path the user is creating alone', () => {
    // A file that does not exist yet must never be replaced by its nearest
    // existing neighbour.
    expect(correct('新建 src/ui/main2.ts').text).toBe('新建 src/ui/main2.ts');
    expect(correct('create a new src/ui/mian.ts').text).toBe('create a new src/ui/mian.ts');
    // ...but the guard is clause-scoped: a second sentence still gets repaired.
    expect(correct('新建一个文件，另外看一下 src/ui/mian.ts').text)
      .toBe('新建一个文件，另外看一下 src/ui/main.ts');
  });

  it('skips absolute paths, URLs and globs', () => {
    const draft = '读 /etc/hosts.ts 和 https://x.test/src/ui/mian.ts 还有 src/**/*.lts';
    expect(correct(draft).text).toBe(draft);
  });

  it('still repairs a path the user quoted', () => {
    // Quoting is how users point AT a path, not a reason to leave a slip in it.
    expect(correct('打开 "src/ui/mian.ts"').text).toBe('打开 "src/ui/main.ts"');
    expect(correct("import from 'src/ui/mian.ts'").text).toBe("import from 'src/ui/main.ts'");
  });

  it('leaves ordinary prose alone', () => {
    const draft = '这个方法在 v2.3.1 里还好用吗？';
    expect(correct(draft).repairs).toEqual([]);
  });

  it('repairs every occurrence but reports each slip once', () => {
    const result = correct('src/ui/mian.ts 和 src/ui/mian.ts 都要改');
    expect(result.text).toBe('src/ui/main.ts 和 src/ui/main.ts 都要改');
    expect(result.repairs).toEqual([{ from: 'src/ui/mian.ts', to: 'src/ui/main.ts' }]);
  });

  it('does nothing without a warm index', () => {
    const draft = '看一下 src/ui/mian.ts';
    expect(correctWorkspacePaths(draft, []).text).toBe(draft);
  });
});

describe('warmPathIndex (async half)', () => {
  it('stays a no-op outside Tauri instead of failing the composer', async () => {
    resetPathIndex();
    await warmPathIndex('/tmp/does-not-exist');
    expect(getPathIndex()).toEqual([]);
    // A second call for the same cold workspace resolves and still reports none.
    await warmPathIndex('/tmp/does-not-exist');
    expect(getPathIndex()).toEqual([]);
    resetPathIndex();
  });

  it('drops the index when the workspace is cleared', async () => {
    resetPathIndex();
    await warmPathIndex('');
    expect(getPathIndex()).toEqual([]);
  });
});
