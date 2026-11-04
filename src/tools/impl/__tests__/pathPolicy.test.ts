// src/tools/impl/__tests__/pathPolicy.test.ts
// path_policy TS 单源（P2-5 第三子刀）的契约测试：
// 1. 行为锁——pathPolicyFixtures.json 两侧同源消费（Rust 侧 include_str! 同表），
//    任一侧改行为不同步 fixture 即红；windowsOnly 词法段 TS 侧全平台跑
//    （纯字符串逻辑），Rust 侧按 cfg(windows)。
// 2. resolveWorkspacePath / hasSymlinkComponent 的编排契约——假 PathPolicyFs
//    注入，不碰真实 fs。

import { describe, expect, it } from 'bun:test';
import {
  expandTilde,
  hasSymlinkComponent,
  joinLexical,
  normalizeLexical,
  resolveWorkspacePath,
  type PathPolicyFs,
} from '../pathPolicy';
import fixtures from '../../../shared/__fixtures__/pathPolicyFixtures.json';

// ── 行为锁：纯函数输入输出表（两侧同源）──

describe('pathPolicyFixtures 行为锁（expandTilde × normalizeLexical）', () => {
  const table = fixtures as {
    expandTilde: Array<{ input: string; home: string; output: string }>;
    normalizeLexical: Array<{ input: string; output: [string, string[]] | null; windowsOnly?: boolean }>;
  };

  it('expandTilde 全表逐条一致', () => {
    for (const row of table.expandTilde) {
      expect(expandTilde(row.input, row.home)).toBe(row.output);
    }
  });

  it('normalizeLexical 全表逐条一致（含 windowsOnly 段：TS 版是纯字符串逻辑）', () => {
    for (const row of table.normalizeLexical) {
      const got = normalizeLexical(row.input);
      if (row.output === null) {
        expect(got).toBeNull();
      } else {
        expect(got).toEqual({ root: row.output[0], parts: row.output[1] });
      }
    }
  });
});

// ── normalizeLexical 语义裁决补充（TS 专属 case：收敛分叉的行为锁不在表内）──

describe('normalizeLexical 收敛裁决', () => {
  it('`..` 越过文件系统根返回 null——旧 Node pathResolve 静默吞到根', () => {
    // pathResolve('/a', '../../../..') === '/'；现在必须显式拒绝，
    // 否则写操作落到模型意图之外的位置（Rust 权威语义）。
    expect(normalizeLexical('/a/../..')).toBeNull();
    expect(joinLexical(normalizeLexical('/a/b/..')!)).toBe('/a');
  });

  it('相对路径的越界 `..` 保留（没锚在前缀上时不是错误）', () => {
    expect(normalizeLexical('../../a')).toEqual({ root: '', parts: ['..', '..', 'a'] });
  });

  it('相对盘符不升级成绝对路径（Rust Prefix 语义）', () => {
    expect(joinLexical(normalizeLexical('C:x')!)).toBe('C:x');
    expect(joinLexical(normalizeLexical('C:/x')!)).toBe('C:/x');
  });
});

// ── expandTilde：从 NodeToolAdapter 上移后的历史锚点保留 ──

describe('expandTilde 语义（原 NodeToolAdapter.test 锚点）', () => {
  it('四式前缀与非边界前缀', () => {
    const home = '/Users/tester';
    expect(expandTilde('~', home)).toBe(home);
    expect(expandTilde('~/Downloads/a.md', home)).toBe('/Users/tester/Downloads/a.md');
    expect(expandTilde('$HOME', home)).toBe(home);
    expect(expandTilde('~user/x', home)).toBe('~user/x');
    expect(expandTilde('$HOMEWORK/x', home)).toBe('$HOMEWORK/x');
    expect(expandTilde('relative/a.txt', home)).toBe('relative/a.txt');
    // home 带尾分隔符不产生双分隔符。
    expect(expandTilde('~/a', '/Users/tester/')).toBe('/Users/tester/a');
  });

  it('trim 不是 expandTilde 的职责（在 resolveWorkspacePath 做）', () => {
    expect(expandTilde(' ~/x', '/h')).toBe(' ~/x');
  });
});

// ── resolveWorkspacePath 编排契约（假 fs）──

/** 内存 fs：paths 是「盘上实体集合」。exists 跟随 symlink 目标（真实 fs 的
 * existsSync 语义），symlinkMeta 不跟随（lstat 语义）——悬空 symlink 因此
 * exists:false 但 symlinkMeta.isSymlink:true，爬升循环靠这对差异拒绝它。 */
function fakeFs(paths: Record<string, { symlink?: string; dir?: boolean }>): PathPolicyFs & { canonicalCalls: string[] } {
  const canonicalCalls: string[] = [];
  const realTarget = (p: string): string | undefined => {
    let cur = paths[p];
    const seen = new Set<string>();
    while (cur?.symlink && !seen.has(p)) {
      seen.add(p);
      if (cur.symlink in paths) {
        p = cur.symlink;
        cur = paths[p];
      } else {
        return undefined; // 悬空
      }
    }
    return cur ? p : undefined;
  };
  return {
    canonicalCalls,
    canonicalize(p) {
      canonicalCalls.push(p);
      const real = realTarget(p);
      if (!real) throw new Error(`no such file or directory: ${p}`);
      return real;
    },
    exists(p) {
      return realTarget(p) !== undefined;
    },
    symlinkMeta(p) {
      const hit = paths[p];
      if (!hit) return null;
      return { isSymlink: Boolean(hit.symlink) };
    },
    isDir(p) {
      const real = realTarget(p);
      return real !== undefined && paths[real].dir === true;
    },
  };
}

describe('resolveWorkspacePath 契约（收敛裁决：Rust 权威语义 + 错误文案）', () => {
  it('workspace 为空/纯空白 → workspace is required', async () => {
    const fs = fakeFs({});
    await expect(resolveWorkspacePath('  ', 'a.txt', fs)).rejects.toThrow('workspace is required');
  });

  it('workspace 不可 canonicalize → invalid workspace', async () => {
    const fs = fakeFs({});
    await expect(resolveWorkspacePath('/no-such-ws', 'a.txt', fs)).rejects.toThrow("invalid workspace '/no-such-ws'");
  });

  it('workspace 不是目录 → workspace is not a directory', async () => {
    const fs = fakeFs({ '/ws': {}, '/ws/f.txt': {} });
    await expect(resolveWorkspacePath('/ws', 'a.txt', fs)).rejects.toThrow('workspace is not a directory: /ws');
  });

  it('path 展开后为空 → path is required（trim+tilde 后判空）', async () => {
    const fs = fakeFs({ '/ws': { dir: true } });
    await expect(resolveWorkspacePath('/ws', '   ', fs)).rejects.toThrow('path is required');
  });

  it('trim 语义：带前导空格的 `~` 仍展开（旧 Node 版因前缀不匹配当相对路径）', async () => {
    const fs = fakeFs({ '/ws': { dir: true }, '/Users/tester/x.txt': {} });
    const got = await resolveWorkspacePath('/ws', ' ~/x.txt', fs, '/Users/tester');
    expect(got).toBe('/Users/tester/x.txt');
  });

  it('绝对路径 passthrough——workspace 边界已移除（全盘可达契约）', async () => {
    const fs = fakeFs({ '/ws': { dir: true }, '/anywhere/out.txt': {} });
    const got = await resolveWorkspacePath('/ws', '/anywhere/out.txt', fs);
    expect(got).toBe('/anywhere/out.txt');
  });

  it('相对路径锚在 workspace（canonicalize 后的真实形状）', async () => {
    const fs = fakeFs({ '/ws': { dir: true, symlink: '/real/ws' }, '/real/ws': { dir: true }, '/real/ws/src/a.txt': {} });
    const got = await resolveWorkspacePath('/ws', 'src/a.txt', fs);
    expect(got).toBe('/real/ws/src/a.txt');
  });

  it('`..` 越过文件系统根 → path cannot be resolved（旧 Node 静默吞的分叉收口）', async () => {
    const fs = fakeFs({ '/ws': { dir: true } });
    await expect(resolveWorkspacePath('/ws', '/../evil.txt', fs)).rejects.toThrow('path cannot be resolved');
    await expect(resolveWorkspacePath('/ws', '/a/../../evil.txt', fs)).rejects.toThrow('path cannot be resolved');
  });

  it('悬空 symlink → path uses an unresolved symlink（文案对齐 Rust 小写）', async () => {
    const fs = fakeFs({
      '/ws': { dir: true },
      '/ws/link.txt': { symlink: '/nowhere/target.txt' },
    });
    await expect(resolveWorkspacePath('/ws', 'link.txt', fs)).rejects.toThrow('path uses an unresolved symlink: link.txt');
  });

  it('新建文件的缺失段补回：最近存在祖先 canonicalize + 逐段接回', async () => {
    const fs = fakeFs({ '/ws': { dir: true }, '/ws/src': { dir: true } });
    const got = await resolveWorkspacePath('/ws', 'src/new/deep/f.txt', fs);
    expect(got).toBe('/ws/src/new/deep/f.txt');
    // 最近存在祖先是 /ws/src，canonicalize 只打它一次。
    expect(fs.canonicalCalls).toEqual(['/ws', '/ws/src']);
  });

  it('存在祖先 canonicalize 失败 → resolve 错误文案', async () => {
    const fs = fakeFs({ '/ws': { dir: true }, '/ws/src': { dir: true } });
    // 让 /ws/src 的 realpath 抛错：把它从存在集合剥掉但 exists 仍报 true。
    const broken: PathPolicyFs = {
      ...fs,
      canonicalize(p) {
        if (p === '/ws/src') throw new Error('permission denied');
        return p;
      },
    };
    await expect(resolveWorkspacePath('/ws', 'src/new.txt', broken)).rejects.toThrow("resolve 'src/new.txt': permission denied");
  });
});

// ── hasSymlinkComponent（Rust 对齐版：workspace 外一律 false）──

describe('hasSymlinkComponent 契约', () => {
  it('workspace 内中间段 symlink → true', async () => {
    const fs = fakeFs({
      '/ws': { dir: true },
      '/ws/link': { symlink: '/elsewhere' },
      '/ws/link/f.txt': {},
    });
    expect(await hasSymlinkComponent('/ws', 'link/f.txt', fs)).toBe(true);
  });

  it('workspace 内纯真实段 → false', async () => {
    const fs = fakeFs({
      '/ws': { dir: true },
      '/ws/a/b/f.txt': {},
    });
    expect(await hasSymlinkComponent('/ws', 'a/b/f.txt', fs)).toBe(false);
  });

  it('workspace 外 → false（对齐 Rust strip_prefix 失败语义；快照链的更严守卫是它的本地函数，不归本单源）', async () => {
    const fs = fakeFs({
      '/ws': { dir: true },
      '/elsewhere': { symlink: '/real' },
      '/elsewhere/f.txt': {},
    });
    expect(await hasSymlinkComponent('/ws', '/elsewhere/f.txt', fs)).toBe(false);
  });

  it('`..` 越根 → false（normalize 失败不算 symlink）', async () => {
    const fs = fakeFs({ '/ws': { dir: true } });
    expect(await hasSymlinkComponent('/ws', '/../x', fs)).toBe(false);
  });
});
