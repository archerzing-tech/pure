import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMergedConventions, mergeConventions, splitSections } from '../conventions';

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
});
