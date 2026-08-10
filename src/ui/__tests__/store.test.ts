import { describe, expect, it } from 'bun:test';
import { dedupeFileWrites, groupFileWrites, normalizeFileWritePath, upsertFileWrite } from '../store';

describe('file write activity deduplication', () => {
  it('normalizes equivalent relative path spellings', () => {
    expect(normalizeFileWritePath('./src\\app.ts')).toBe('src/app.ts');
    expect(normalizeFileWritePath(' src//app.ts ')).toBe('src/app.ts');
  });

  it('normalizes dot segments and absolute path separators', () => {
    expect(normalizeFileWritePath('./src/../src/app.ts')).toBe('src/app.ts');
    expect(normalizeFileWritePath('/Users/me/project/../project/app.ts')).toBe('/Users/me/project/app.ts');
  });

  it('treats workspace-relative and workspace-absolute paths as one file', () => {
    const entries = [{ path: '/workspace/src/app.ts', ts: 1, success: true }];
    upsertFileWrite(entries, { path: 'src/app.ts', ts: 2, success: false }, '/workspace');
    expect(entries).toEqual([{ path: 'src/app.ts', ts: 2, success: false }]);
  });

  it('keeps only the latest entry for each file', () => {
    expect(dedupeFileWrites([
      { path: 'src/app.ts', ts: 1, success: true },
      { path: './src/app.ts', ts: 2, success: false },
      { path: 'README.md', ts: 3, success: true },
    ])).toEqual([
      { path: 'src/app.ts', ts: 2, success: false },
      { path: 'README.md', ts: 3, success: true },
    ]);
  });

  it('updates an existing file row instead of appending a duplicate', () => {
    const entries = [{ path: 'src/app.ts', ts: 1, success: true }];
    upsertFileWrite(entries, { path: './src/app.ts', ts: 2, success: false });
    expect(entries).toEqual([{ path: 'src/app.ts', ts: 2, success: false }]);
  });

  it('groups paths and keeps the most recent write status ordered by time', () => {
    expect(groupFileWrites([
      { path: 'README.md', ts: 3, success: true },
      { path: './src/app.ts', ts: 1, success: true },
      { path: 'src/app.ts', ts: 4, success: false },
      { path: 'old.ts', ts: 2, success: true },
    ])).toEqual([
      { path: 'src/app.ts', ts: 4, success: false },
      { path: 'README.md', ts: 3, success: true },
      { path: 'old.ts', ts: 2, success: true },
    ]);
  });

  it('does not let an older persisted entry replace a newer status', () => {
    expect(dedupeFileWrites([
      { path: 'src/app.ts', ts: 9, success: true },
      { path: './src/app.ts', ts: 3, success: false },
    ])).toEqual([{ path: 'src/app.ts', ts: 9, success: true }]);
  });
});
