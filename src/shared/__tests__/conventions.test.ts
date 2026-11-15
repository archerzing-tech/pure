import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadMergedConventions,
  loadMergedConventionsWithDiagnostics,
  mergeConventions,
  mergeLayers,
  defaultVersionOf,
  stripDefaultMarkers,
  upgradeSeededAgentsMd,
  parseSeedState,
  syncSeededAgentsMd,
  expandImports,
  scopeMatchesPath,
  mentionedPaths,
  ancestorDirsOf,
  conventionsForPaths,
  filePathsFromToolCalls,
  workspaceRelativePath,
  conventionsBudgetWarnings,
  CONVENTIONS_LAYER_BUDGET,
  CONVENTIONS_TOTAL_BUDGET,
  sectionKey,
  splitSections,
} from '../conventions';
import { DEFAULT_AGENTS_MD } from '../defaultAgentsMd';

describe('DEFAULT_AGENTS_MD parity', () => {
  it('stays in sync with templates/default-agents.md (trimmed)', () => {
    // The product default's single source is templates/default-agents.md —
    // NOT the project-root AGENTS.md, which is this repo's own dev conventions
    // and must never ship as the global default (`bun run agents:sync`).
    const root = join(import.meta.dir, '..', '..', '..');
    const template = readFileSync(join(root, 'templates', 'default-agents.md'), 'utf8').trim();
    expect(DEFAULT_AGENTS_MD.trim()).toBe(template);
  });

  it('derives the packaged copy from the same template (sync script contract)', () => {
    // src-tauri/AGENTS.md is a gitignored build artifact (tauri resources), so
    // a fresh clone cannot assert its content — assert the generator instead:
    // it must read the template and never the project-root AGENTS.md.
    const root = join(import.meta.dir, '..', '..', '..');
    const script = readFileSync(join(root, 'scripts', 'sync-default-agents-md.ts'), 'utf8');
    expect(script).toContain('templates/default-agents.md');
    expect(script).toContain('src-tauri/AGENTS.md');
    expect(script).not.toContain('`${ROOT}AGENTS.md`');
  });
});

describe('conventions merge (two-layer AGENTS.md)', () => {
  it('returns empty when both layers are empty', () => {
    expect(mergeConventions(null, null)).toBe('');
    expect(mergeConventions('', '')).toBe('');
  });

  it('inherits app-layer-only constraints unchanged', () => {
    const app = '# App\n\napp default rule';
    const user = '';
    expect(mergeConventions(app, user)).toContain('app default rule');
  });

  it('user layer overrides the SAME constraint (black over white)', () => {
    const app = '# 颜色\n\nwhite';
    const user = '# 颜色\n\nblack';
    const merged = mergeConventions(app, user);
    expect(merged).toContain('black');
    expect(merged).not.toContain('\nwhite');
    // The heading appears once (override, not duplicated).
    expect(merged.match(/# 颜色/g)?.length).toBe(1);
  });

  it('keeps constraints unique to either layer', () => {
    const app = '# A\n\nfrom app\n\n# Shared\n\napp shared';
    const user = '# B\n\nfrom user\n\n# Shared\n\nuser shared';
    const merged = mergeConventions(app, user);
    expect(merged).toContain('from app');
    expect(merged).toContain('from user');
    expect(merged).toContain('user shared');
    expect(merged).not.toContain('app shared');
  });

  it('treats the leading block before the first heading as a constraint', () => {
    const app = 'preamble app';
    const user = 'preamble user';
    expect(mergeConventions(app, user)).toContain('preamble user');
  });

  it('splitSections keys by heading text case-insensitively', () => {
    const sections = splitSections('# Foo\n\na\n\n# foo\n\nb');
    // headings with the same normalized key collapse to the later body
    expect(sections.filter((s) => s.key === 'foo').length).toBe(2);
  });
});

describe('section keys (heading normalization)', () => {
  it('ignores numbering, case and trailing punctuation', () => {
    expect(sectionKey('1. 语言')).toBe('语言');
    expect(sectionKey('## 1.2 语言：')).toBe('语言');
    expect(sectionKey('Language')).toBe('language');
    expect(sectionKey('（3）项目事实。')).toBe('项目事实');
    expect(sectionKey('三、提交信息约定')).toBe('提交信息约定');
  });

  it('lets a numbered parent section be overridden by an unnumbered child heading', () => {
    // Migration case: existing ~/.pure/AGENTS.md copies carry `## 1. 语言`.
    const app = '## 1. 语言\n\nuse the user language';
    const user = '## 语言\n\n回复用中文';
    const merged = mergeConventions(app, user);
    expect(merged).toContain('回复用中文');
    expect(merged).not.toContain('use the user language');
    expect(merged.match(/语言/g)?.length).toBe(1);
  });
});

describe('section merge modes', () => {
  it('appends to the parent section when the directive sits above the heading', () => {
    const app = '## 语言\n\ndefault line';
    const user = '<!-- merge: append -->\n## 语言\n\nproject line';
    const merged = mergeConventions(app, user);
    // Both bodies survive, the parent comes first, the heading is printed once,
    // and the directive itself never reaches the model.
    expect(merged).toContain('default line');
    expect(merged).toContain('project line');
    expect(merged.match(/## 语言/g)?.length).toBe(1);
    expect(merged.indexOf('default line')).toBeLessThan(merged.indexOf('project line'));
    expect(merged).not.toContain('<!--');
  });

  it('keeps plain sections overriding — the directive is opt-in', () => {
    const app = '## 语言\n\ndefault line';
    const user = '## 语言\n\nproject line';
    const merged = mergeConventions(app, user);
    expect(merged).toContain('project line');
    expect(merged).not.toContain('default line');
  });

  it('accumulates appends across all three layers', () => {
    const { text, diagnostics } = mergeLayers([
      { name: 'app', source: 'app', text: '## 语言\n\napp line' },
      { name: 'global', source: 'global', text: '<!-- merge: append -->\n## 语言\n\nglobal line' },
      { name: 'workspace', source: 'ws', text: '<!-- merge: append -->\n## 语言\n\nworkspace line' },
    ]);
    expect(text).toContain('app line');
    expect(text).toContain('global line');
    expect(text).toContain('workspace line');
    expect(diagnostics.overrides.map((o) => o.mode)).toEqual(['append', 'append']);
    expect(text.match(/## 语言/g)?.length).toBe(1);
  });

  it('applies through the disk loader (workspace appends to the app default)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'pure-append-'));
    try {
      writeFileSync(join(rootDir, 'AGENTS.md'), '<!-- merge: append -->\n## 语言\n\nworkspace extra');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\ndefault rule',
        userSpaceRoot: rootDir,
      });
      expect(text).toContain('default rule');
      expect(text).toContain('workspace extra');
      expect(diagnostics.overrides.at(-1)?.mode).toBe('append');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe('merge diagnostics', () => {
  it('reports layer sources, overrides and child-only sections', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'pure-diag-'));
    try {
      writeFileSync(join(rootDir, 'AGENTS.md'), '## 语言\n\nworkspace language\n\n## 仅工作区\n\nwork only');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\napp language',
        userSpaceRoot: rootDir,
      });
      expect(text).toContain('workspace language');
      expect(diagnostics.layers.map((l) => l.name)).toEqual(['app', 'global', 'workspace']);
      const workspace = diagnostics.layers.find((l) => l.name === 'workspace');
      expect(workspace?.present).toBe(true);
      expect(workspace?.sections).toEqual(['语言', '仅工作区']);
      // The override names both sides, so a silent takeover can be reported.
      expect(diagnostics.overrides).toContainEqual({
        section: '语言',
        from: 'app',
        by: 'workspace',
        mode: 'override',
        replacedChars: '## 语言\n\napp language'.length,
      });
      expect(diagnostics.appends).toContainEqual({ section: '仅工作区', by: 'workspace' });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('uses the baked default for the app layer and never the current directory', async () => {
    // Guards the double-identity bug: no appSpaceRoot → app layer is the
    // product template, not <cwd>/AGENTS.md (this repo's dev conventions).
    const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
      userSpaceRoot: join(tmpdir(), 'pure-nonexistent-ws-xyz'),
    });
    // The version marker is seed metadata, never content.
    expect(text).toBe(stripDefaultMarkers(DEFAULT_AGENTS_MD).trim());
    const app = diagnostics.layers.find((l) => l.name === 'app');
    expect(app?.source).toContain('templates/default-agents.md');
  });
});

describe('default upgrade (version marker + seed state)', () => {
  const V2 = '<!-- pure:default version=2 -->\n## 语言\n\nnew language\n\n## 新节\n\nbrand new';

  it('reads the version marker and strips it from content', () => {
    expect(defaultVersionOf(V2)).toBe(2);
    expect(defaultVersionOf('## 语言\n\nno marker')).toBe(0);
    expect(stripDefaultMarkers(V2)).not.toContain('pure:default');
    expect(stripDefaultMarkers(V2)).toContain('## 语言');
  });

  it('adopts untouched sections and appends missing ones', () => {
    const user = '## 语言\n\nold language';
    const state = { version: 1, sections: { 语言: '## 语言\n\nold language' } };
    const result = upgradeSeededAgentsMd(user, V2, state);
    expect(result.text).toContain('new language');
    expect(result.text).toContain('brand new');
    expect(result.adopted).toEqual(['语言']);
    expect(result.added).toEqual(['新节']);
    expect(result.version).toBe(2);
    expect(result.text).not.toContain('pure:default');
  });

  it('never clobbers a section the user edited', () => {
    const user = '## 语言\n\n我的规则';
    const state = { version: 1, sections: { 语言: '## 语言\n\nold language' } };
    const result = upgradeSeededAgentsMd(user, V2, state);
    expect(result.text).toContain('我的规则');
    expect(result.text).not.toContain('new language');
    expect(result.kept).toEqual(['语言']);
    // The baseline moves to what the user actually has, so the next bump
    // cannot mistake their text for ours.
    expect(result.state.sections['语言']).toBe('## 语言\n\n我的规则');
  });

  it('with no state yet, keeps existing sections and records them as baseline', () => {
    const user = '## 语言\n\nlegacy user text';
    const result = upgradeSeededAgentsMd(user, V2, null);
    expect(result.text).toContain('legacy user text');
    expect(result.kept).toEqual(['语言']);
    expect(result.added).toEqual(['新节']);
    expect(result.state.sections['语言']).toBe('## 语言\n\nlegacy user text');
  });

  it('seeds everything into an empty file', () => {
    const result = upgradeSeededAgentsMd('', V2, null);
    expect(result.text).toContain('new language');
    expect(result.text).toContain('brand new');
    expect(result.text).not.toContain('pure:default');
  });

  it('parses a corrupt state file as no state', () => {
    expect(parseSeedState('{not json')).toBeNull();
    expect(parseSeedState('{"version":"3","sections":{"语言":"x"}}')).toEqual({
      version: 3,
      sections: { 语言: 'x' },
    });
  });

  it('seeds once, then upgrades on disk without touching user edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-seed-'));
    try {
      expect(await syncSeededAgentsMd(root, V2)).toContain('已写入默认约定');
      expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('new language');
      expect(JSON.parse(readFileSync(join(root, 'AGENTS.default.json'), 'utf8')).version).toBe(2);
      // Unchanged default → no work, no note.
      expect(await syncSeededAgentsMd(root, V2)).toBeNull();

      // User edits one section; v3 changes it plus adds one.
      writeFileSync(join(root, 'AGENTS.md'), '## 语言\n\n我的规则\n');
      const V3 = '<!-- pure:default version=3 -->\n## 语言\n\nv3 language\n\n## 新节\n\nv3 new';
      const note = await syncSeededAgentsMd(root, V3);
      const after = readFileSync(join(root, 'AGENTS.md'), 'utf8');
      expect(note).toContain('v3');
      expect(after).toContain('我的规则');
      expect(after).not.toContain('v3 language');
      expect(after).toContain('v3 new');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('imports (@file.md)', () => {
  it('expands a relative import inside the workspace layer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-import-'));
    try {
      mkdirSync(join(root, 'rules'));
      writeFileSync(join(root, 'AGENTS.md'), '# 主规则\n\n主文\n\n@rules/extra.md');
      writeFileSync(join(root, 'rules', 'extra.md'), '## 导入节\n\n来自导入');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\nx',
        userSpaceRoot: root,
      });
      expect(text).toContain('来自导入');
      expect(text).not.toContain('@rules/extra.md');
      expect(diagnostics.imports.length).toBe(1);
      expect(diagnostics.imports[0].file.endsWith('rules/extra.md')).toBe(true);
      expect(diagnostics.imports[0].depth).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('follows nested imports and stops on a cycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-cycle-'));
    try {
      writeFileSync(join(root, 'AGENTS.md'), '## 主\n\n@b.md');
      writeFileSync(join(root, 'b.md'), '## B\n\nb content\n\n@AGENTS.md');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\nx',
        userSpaceRoot: root,
      });
      expect(text).toContain('b content');
      // The back-edge stays a literal line instead of recursing forever.
      expect(text).toContain('@AGENTS.md');
      expect(diagnostics.imports.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores @lines inside fenced code blocks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-fence-'));
    try {
      writeFileSync(join(root, 'AGENTS.md'), '## 主\n\n```\n@x.md\n```\n');
      writeFileSync(join(root, 'x.md'), '## X\n\nshould not load');
      const { text } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\nx',
        userSpaceRoot: root,
      });
      expect(text).not.toContain('should not load');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses imports that escape the layer root', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'pure-escape-'));
    try {
      const root = join(outer, 'workspace');
      mkdirSync(root);
      writeFileSync(join(outer, 'outside.md'), '## Outside\n\nsecret');
      writeFileSync(join(root, 'AGENTS.md'), '## 主\n\n@../outside.md');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\nx',
        userSpaceRoot: root,
      });
      expect(text).not.toContain('secret');
      expect(diagnostics.imports).toEqual([]);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('expands in layer-relative mode so the renderer can share the logic', async () => {
    const files = new Map([
      ['AGENTS.md', '## 主\n\n@rules/extra.md'],
      ['rules/extra.md', '## 导入\n\nrelative import body'],
    ]);
    const read = async (p: string) => files.get(p) ?? null;
    const out = await expandImports(files.get('AGENTS.md') as string, 'AGENTS.md', read, {
      root: '',
    });
    expect(out.text).toContain('relative import body');
    expect(out.imports[0].file).toBe('rules/extra.md');
  });

  it('refuses .. escapes in layer-relative mode', async () => {
    const read = async (p: string) => (p === '../secret.md' ? 'TOP_SECRET_BODY' : null);
    const out = await expandImports('## 主\n\n@../secret.md', 'AGENTS.md', read, { root: '' });
    expect(out.text).not.toContain('TOP_SECRET_BODY');
    expect(out.imports).toEqual([]);
  });

  it('stops at the depth cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-depth-'));
    try {
      writeFileSync(join(root, 'AGENTS.md'), '## 主\n\n@a1.md');
      for (let i = 1; i <= 4; i++) {
        writeFileSync(join(root, `a${i}.md`), `## L${i}\n\nlevel ${i}\n\n@a${i + 1}.md`);
      }
      const read = async (file: string) => {
        try {
          return readFileSync(file, 'utf8');
        } catch {
          return null;
        }
      };
      const { text, imports } = await expandImports(
        readFileSync(join(root, 'AGENTS.md'), 'utf8'),
        join(root, 'AGENTS.md'),
        read,
        { root },
      );
      expect(text).toContain('level 1');
      expect(text).toContain('level 2');
      expect(text).toContain('level 3');
      // Depth 3 is the cap: level 4 stays an unexpanded import line.
      expect(text).not.toContain('level 4');
      expect(text).toContain('@a4.md');
      expect(imports.every((i) => i.depth < 3)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('section scopes (paths) and soft budget', () => {
  it('labels a scoped section and records it, keeping the directive out of the text', () => {
    const text = '<!-- paths: src/ui/** -->\n## 界面规矩\n\n用 className\n\n## 通用\n\n都一样';
    const merged = mergeLayers([{ name: 'workspace', source: 'ws', text }]);
    expect(merged.text).toContain('生效范围：src/ui/**');
    expect(merged.text).not.toContain('<!-- paths');
    expect(merged.diagnostics.scopes).toContainEqual({
      section: '界面规矩',
      by: 'workspace',
      paths: ['src/ui/**'],
    });
  });

  it('drops a scoped section when the given paths do not match', () => {
    const text = '<!-- paths: src/ui/** -->\n## 界面规矩\n\nui only\n\n## 通用\n\nall';
    const filtered = mergeLayers([{ name: 'workspace', source: 'ws', text }], {
      paths: ['src/engine/FailurePolicy.ts'],
    });
    expect(filtered.text).not.toContain('ui only');
    expect(filtered.text).toContain('all');

    const kept = mergeLayers([{ name: 'workspace', source: 'ws', text }], {
      paths: ['src/ui/chat.ts'],
    });
    expect(kept.text).toContain('ui only');
  });

  it('matches glob shapes used in practice', () => {
    expect(scopeMatchesPath('src/ui/**', 'src/ui/chat.ts')).toBe(true);
    expect(scopeMatchesPath('src/ui/**', 'src/engine/x.ts')).toBe(false);
    expect(scopeMatchesPath('src/**/chat.ts', 'src/ui/deep/chat.ts')).toBe(true);
    expect(scopeMatchesPath('docs/*.md', 'docs/a.md')).toBe(true);
    expect(scopeMatchesPath('docs/*.md', 'docs/sub/a.md')).toBe(false);
  });

  it('keeps override semantics: heading still decides, scope only labels', () => {
    const app = '<!-- paths: src/ui/** -->\n## 界面规矩\n\napp rule';
    const user = '## 界面规矩\n\nuser rule';
    const merged = mergeConventions(app, user);
    expect(merged).toContain('user rule');
    expect(merged).not.toContain('app rule');
  });

  it('warns when a layer or the merged text exceeds the soft budget', () => {
    const big = `## 大节\n\n${'字'.repeat(CONVENTIONS_LAYER_BUDGET + 10)}`;
    const over = mergeLayers([{ name: 'workspace', source: 'ws', text: big }]);
    expect(over.diagnostics.warnings.length).toBeGreaterThan(0);
    expect(over.diagnostics.warnings[0]).toContain('预算');

    const small = mergeLayers([{ name: 'workspace', source: 'ws', text: '## 小\n\nok' }]);
    expect(small.diagnostics.warnings).toEqual([]);
  });

  // GUI 自己拼层（不走 mergeLayers），软预算告警必须与 CLI 同一口径。
  it('computes the same budget warnings for callers that merge on their own', () => {
    expect(
      conventionsBudgetWarnings('短', [{ name: 'workspace', present: true, chars: CONVENTIONS_LAYER_BUDGET + 1 }]),
    ).toEqual([`workspace 层 ${CONVENTIONS_LAYER_BUDGET + 1} 字符，超过 ${CONVENTIONS_LAYER_BUDGET} 字符预算`]);
    expect(conventionsBudgetWarnings('短', [{ name: 'app', present: false, chars: 0 }])).toEqual([]);
    const long = 'x'.repeat(CONVENTIONS_TOTAL_BUDGET + 1);
    expect(conventionsBudgetWarnings(long, [])[0]).toContain('合并后');
  });
});

describe('nested conventions (mentioned paths)', () => {
  it('walks outermost-first ancestors of a mentioned path', () => {
    expect(ancestorDirsOf('packages/web/src/app.ts')).toEqual(['packages', 'packages/web', 'packages/web/src']);
    expect(mentionedPaths('改一下 src/ui/chat.ts 和 docs/README.md')).toEqual([
      'src/ui/chat.ts',
      'docs/README.md',
    ]);
    expect(mentionedPaths('/etc/hosts.md and ../outside.md')).toEqual([]);
  });

  it('loads nested AGENTS.md for a mentioned path and lets the nearer one win', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-nested-'));
    try {
      mkdirSync(join(root, 'packages', 'web'), { recursive: true });
      writeFileSync(join(root, 'packages', 'AGENTS.md'), '## 语言\n\n包级规则');
      writeFileSync(join(root, 'packages', 'web', 'AGENTS.md'), '## 语言\n\nweb 级规则\n\n## WebOnly\n\nweb only');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\n默认',
        userSpaceRoot: root,
        nestedFrom: '修一下 packages/web/src/app.ts 的报错',
      });
      const nested = diagnostics.layers.filter((l) => l.name === 'nested');
      expect(nested.map((l) => l.source)).toEqual([
        'packages/AGENTS.md',
        'packages/web/AGENTS.md',
      ]);
      expect(text).toContain('web only');
      // Both declare 语言: the nearer (web) layer overrides the package one.
      expect(text).toContain('web 级规则');
      expect(text).not.toContain('包级规则');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads a directory chain for the files a batch actually read, once per session', async () => {
    const files: Record<string, string> = {
      'packages/AGENTS.md': '## 语言\n\n包级规则',
      'packages/web/AGENTS.md': '## WebOnly\n\nweb only',
    };
    const read = async (rel: string) => files[rel] ?? null;
    const seen = new Set<string>();

    const first = await conventionsForPaths(['packages/web/src/app.ts'], read, seen);
    expect(first.map((l) => l.source)).toEqual(['packages/AGENTS.md', 'packages/web/AGENTS.md']);
    expect([...seen]).toEqual(['packages/AGENTS.md', 'packages/web/AGENTS.md']);

    // The same directory chain again: already paid for, nothing re-injected.
    expect(await conventionsForPaths(['packages/web/src/other.ts'], read, seen)).toEqual([]);
    // A file in a directory nobody has loaded yet still resolves on its own.
    const b = await conventionsForPaths(['packages/web/app.ts'], read, seen);
    expect(b).toEqual([]);
  });

  it('extracts paths from read/edit calls only, and survives malformed args', () => {
    const calls = [
      { function: { name: 'read_file', arguments: JSON.stringify({ path: 'packages/web/src/app.ts' }) } },
      { function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/ui/chat.ts', old: 'a' }) } },
      { function: { name: 'write_file', arguments: JSON.stringify({ path: 'packages/new/file.ts' }) } },
      { function: { name: 'read_file', arguments: 'not json' } },
      { function: { name: 'read_file', arguments: JSON.stringify({ path: 'packages\\web\\a.ts' }) } },
    ];
    expect(filePathsFromToolCalls(calls)).toEqual([
      'packages/web/src/app.ts',
      'src/ui/chat.ts',
      'packages/web/a.ts',
    ]);
  });

  it('normalizes absolute paths under the workspace root', () => {
    expect(workspaceRelativePath('/ws/packages/web/a.ts', '/ws')).toBe('packages/web/a.ts');
    expect(workspaceRelativePath('./src/a.ts', '/ws')).toBe('src/a.ts');
    expect(workspaceRelativePath('/other/dir/a.ts', '/ws')).toBe('/other/dir/a.ts');
    expect(workspaceRelativePath('src/a.ts', null)).toBe('src/a.ts');
  });

  it('loads nothing when the turn names no path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pure-nonested-'));
    try {
      mkdirSync(join(root, 'packages', 'web'), { recursive: true });
      writeFileSync(join(root, 'packages', 'web', 'AGENTS.md'), '## WebOnly\n\nweb only');
      const { text, diagnostics } = await loadMergedConventionsWithDiagnostics({
        appText: '## 语言\n\n默认',
        userSpaceRoot: root,
        nestedFrom: '帮我看看这个项目',
      });
      expect(diagnostics.layers.some((l) => l.name === 'nested')).toBe(false);
      expect(text).not.toContain('web only');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadMergedConventions (disk)', () => {
  let appRoot: string;
  let globalRoot: string;
  let userRoot: string;
  beforeAll(() => {
    appRoot = mkdtempSync(join(tmpdir(), 'pure-app-'));
    globalRoot = mkdtempSync(join(tmpdir(), 'pure-global-'));
    userRoot = mkdtempSync(join(tmpdir(), 'pure-user-'));
    writeFileSync(join(appRoot, 'AGENTS.md'), '# Shared\n\napp value\n\n# AppOnly\n\napp only');
    writeFileSync(join(globalRoot, 'AGENTS.md'), '# Shared\n\nglobal value\n\n# GlobalOnly\n\nglobal only');
    writeFileSync(join(userRoot, 'AGENTS.md'), '# Shared\n\nuser value\n\n# UserOnly\n\nuser only');
  });
  afterAll(() => {
    rmSync(appRoot, { recursive: true, force: true });
    rmSync(globalRoot, { recursive: true, force: true });
    rmSync(userRoot, { recursive: true, force: true });
  });

  it('reads all three layers: workspace > global > app precedence', async () => {
    const merged = await loadMergedConventions({
      appSpaceRoot: appRoot,
      globalUserRoot: globalRoot,
      userSpaceRoot: userRoot,
    });
    // Shared constraint: workspace wins over global wins over app.
    expect(merged).toContain('user value');
    expect(merged).not.toContain('global value');
    expect(merged).not.toContain('app value');
    // Unique sections from every layer are inherited.
    expect(merged).toContain('app only');
    expect(merged).toContain('global only');
    expect(merged).toContain('user only');
  });

  it('omits the global layer when its root is absent', async () => {
    const merged = await loadMergedConventions({
      appSpaceRoot: appRoot,
      globalUserRoot: join(tmpdir(), 'pure-global-missing-xyz'),
      userSpaceRoot: userRoot,
    });
    expect(merged).toContain('user value');
    expect(merged).toContain('app only');
    expect(merged).not.toContain('global only');
  });

  it('reads both layers, overrides shared, inherits unique sections', async () => {
    const merged = await loadMergedConventions({ appSpaceRoot: appRoot, userSpaceRoot: userRoot });
    expect(merged).toContain('user value');
    expect(merged).not.toContain('app value');
    expect(merged).toContain('app only');
    expect(merged).toContain('user only');
  });

  it('tolerates a missing user-layer AGENTS.md', async () => {
    const merged = await loadMergedConventions({ appSpaceRoot: appRoot, userSpaceRoot: join(tmpdir(), 'pure-nonexistent-xyz') });
    expect(merged).toContain('app only');
    expect(merged).not.toContain('user only');
  });

  it('falls back to CLAUDE.md in a layer that has no AGENTS.md (Claude Code ecosystem, zero migration)', async () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), 'pure-claude-'));
    try {
      writeFileSync(join(claudeRoot, 'CLAUDE.md'), '# Shared\n\nclaude value\n\n# ClaudeOnly\n\nclaude only');
      const merged = await loadMergedConventions({ appSpaceRoot: appRoot, userSpaceRoot: claudeRoot });
      expect(merged).toContain('claude value');
      expect(merged).toContain('claude only');
      // 与同层 AGENTS.md 共存时……
      writeFileSync(join(claudeRoot, 'AGENTS.md'), '# Shared\n\nagents value');
      const both = await loadMergedConventions({ appSpaceRoot: appRoot, userSpaceRoot: claudeRoot });
      // ……AGENTS.md 赢，CLAUDE.md 整层被忽略（不双源）。
      expect(both).toContain('agents value');
      expect(both).not.toContain('claude value');
      expect(both).not.toContain('claude only');
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });
});
