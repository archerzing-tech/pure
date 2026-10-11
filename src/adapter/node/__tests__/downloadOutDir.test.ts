// src/adapter/node/__tests__/downloadOutDir.test.ts
// resolveDownloadOutDir 口径（2026-10-11 与 GUI resolveDownloadOutSpec 对齐）：
// 裸文件名落 Downloads、`~/…` 按真实 home 展开、带扩展名的绝对路径取父目录、
// 绝对目录与 workspace 原样通过。三类历史病灶各有一条回归线。
import { describe, expect, it } from 'bun:test';
import { resolveDownloadOutDir } from '../NodeToolAdapter';

const HOME = '/Users/tester';
const CWD = '/ws/dir';

describe('resolveDownloadOutDir', () => {
  it('drops a bare filename into ~/Downloads instead of nesting name.ext/name.ext', () => {
    expect(resolveDownloadOutDir('report.pdf', HOME, CWD)).toBe('/Users/tester/Downloads');
    expect(resolveDownloadOutDir('a.png', HOME, CWD)).toBe('/Users/tester/Downloads');
  });

  it('expands ~/ against the real home instead of breeding a literal ~ dir', () => {
    expect(resolveDownloadOutDir('~/pics', HOME, CWD)).toBe('/Users/tester/pics');
    expect(resolveDownloadOutDir('~', HOME, CWD)).toBe('/Users/tester');
  });

  it('treats an absolute path with an extension as the file itself (parent wins)', () => {
    expect(resolveDownloadOutDir('/data/pics/a.png', HOME, CWD)).toBe('/data/pics');
    expect(resolveDownloadOutDir('/data/a.png', HOME, CWD)).toBe('/data');
  });

  it('passes absolute directories, workspace and empty/downloads through as before', () => {
    expect(resolveDownloadOutDir('/data/pics', HOME, CWD)).toBe('/data/pics');
    expect(resolveDownloadOutDir('workspace', HOME, CWD)).toBe(CWD);
    expect(resolveDownloadOutDir('', HOME, CWD)).toBe('/Users/tester/Downloads');
    expect(resolveDownloadOutDir('downloads', HOME, CWD)).toBe('/Users/tester/Downloads');
  });

  it('keeps relative dir names under Downloads (sanitized)', () => {
    expect(resolveDownloadOutDir('sub/dir', HOME, CWD)).toBe('/Users/tester/Downloads/sub/dir');
  });
});
