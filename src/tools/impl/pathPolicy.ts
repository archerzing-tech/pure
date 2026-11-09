// src/tools/impl/pathPolicy.ts
// 路径解析链 TS 单源（P2-5 第三子刀：path_policy 注入点上移）。
// 此前文件类工具的路径策略只有一份权威实现（src-tauri/src/path_policy.rs，
// GUI 文件命令在 Rust 侧入口 resolve），NodeToolAdapter.resolve 是一份近乎
// 同构的手工镜像——`..` 越过文件系统根时 Rust 报错、Node 的 pathResolve
// 静默吞掉；workspace/path 为空时 Rust 报错、Node 静默落到进程 cwd；参数
// 带前导空格时 Rust trim 后仍展开 `~`、Node 因前缀不匹配把 ` ~/x` 当相对
// 路径。本文件把这条链收进零 node 依赖的单源（WebView 可 import），fs 能
// 力经 PathPolicyFs 原语注入（CLI 侧注 node:fs 同步函数；GUI 若将来要在
// 调用前预解析，注入同一接口的 IPC 版即可，签名零改动）。
// Rust 不能 import TS、WebView 不能 import Rust——resolve 的实现仍是两份
// （Rust 份是 GUI 的 fs 执行者，随模块保留），但行为由行为锁钉住：
// expandTilde/normalizeLexical 的输入输出表在
// src/shared/__fixtures__/pathPolicyFixtures.json，两侧测试同源消费
// （劫持双锁的「真单源不可达，机械锁可达」形态）。
// 契约（与 Rust path_policy.rs 逐条对齐）：workspace 只是相对路径的锚，
// 绝对路径指向盘上任意位置——workspace 边界已移除（用户明确选择全盘可达），
// 剩下的是路径有效性守卫：词法归一（`..` 不得越过文件系统根）+ 拒绝经由
// 悬空 symlink 解析。这些是有效性检查，不是安全边界。

/** fs 原语。全部可同步可异步：CLI 注 node:fs 同步函数，异步调用点
 * await 同步值零开销。symlinkMeta 返回 null 表示路径不存在（lstat 失败），
 * 与 exists:false 区分——爬升循环靠它辨认「悬空 symlink」与「纯缺失段」。 */
export interface PathPolicyFs {
  /** realpath。失败（路径不存在/权限）throw。 */
  canonicalize(p: string): Promise<string> | string;
  exists(p: string): Promise<boolean> | boolean;
  symlinkMeta(p: string): Promise<{ isSymlink: boolean } | null> | { isSymlink: boolean } | null;
  isDir(p: string): Promise<boolean> | boolean;
}

// ── 词法层（纯函数，零 fs 依赖）──

/** 词法归一化的产物：root 是前缀形状（''=相对、'/'=posix 根、'C:/'=绝对
 * 盘符、'C:'=相对盘符、'//server/share'=UNC），parts 是消化掉 `.`/`..`
 * 之后的 normal 分量。相对路径的「越界 `..`」保留在 parts 里（与 Rust
 * normalize_lexical 一致：没锚在前缀上时 `..` 不是错误）。 */
export interface LexicalPath {
  root: string;
  parts: string[];
}

/** 序列化 LexicalPath：统一正斜杠产物（node/Bun/Win32 API 层都接受，
 * 分隔符形状不算行为差异——Rust 份的产物用平台分隔符，行为锁 fixture
 * 用分量断言，两侧各自 join）。 */
export function joinLexical(lp: LexicalPath): string {
  if (!lp.root) return lp.parts.join('/');
  if (/^[A-Za-z]:$/.test(lp.root)) return lp.root + lp.parts.join('/'); // 相对盘符：不带分隔直贴
  if (/[\/\\]$/.test(lp.root)) return lp.root + lp.parts.join('/');
  return lp.root + '/' + lp.parts.join('/');
}

/** Rust `path.is_absolute()` 的跨平台手写等价：盘符带根分隔、UNC 头、
 * posix 根。'C:x'（相对盘符）不算绝对——与 Rust 一致。 */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\/\\]/.test(p) || /^(\/\/|\\\\)/.test(p) || p.startsWith('/');
}

/** 成分带 Prefix（盘符/UNC）时 Rust 的 PathBuf::push 走替换语义——join
 * 不能把 'C:x' 拼到 base 后面（std 会把带 prefix 的成分当替换）。 */
function hasPrefixComponent(p: string): boolean {
  return /^[A-Za-z]:[\/\\]?/.test(p) || p.startsWith('//') || p.startsWith('\\\\');
}

/** Rust `base.join(path)` 的等价（仅用于相对成分；绝对/带 Prefix 成分由
 * 调用点先行替换）。分隔符统一 '/'，base 尾部的分隔符剥掉避免双写。 */
function joinRelative(base: string, rel: string): string {
  return base.replace(/[\/\\]+$/, '') + '/' + rel;
}

/** 词法归一。对齐 Rust normalize_lexical（src-tauri/src/path_policy.rs）：
 * `.` 与空段跳过；`..` 弹掉一个已积累分量，弹无可弹且已锚在前缀上时返回
 * null（越过文件系统根——静默吞掉会把写操作落到模型意图之外的位置）；
 * 没锚在前缀上时 `..` 保留（相对路径合法）。windows 盘符/UNC 形状的识别
 * 是纯字符串逻辑，不依赖宿主平台（Rust 份依赖 std::path::Components，
 * 盘符语义只在 Windows 生效——posix 形状两侧行为由 fixture 锁死）。 */
export function normalizeLexical(p: string): LexicalPath | null {
  let rest = p;
  let root = '';
  let hasPrefix = false;
  // UNC 头：//server/share（正反斜杠都认）
  const unc = rest.match(/^(?:\/\/|\\\\)[^\/\\]+(?:[\/\\][^\/\\]+)/);
  if (unc) {
    root = unc[0].replace(/\\/g, '/');
    rest = rest.slice(unc[0].length);
    hasPrefix = true;
  } else {
    const drive = rest.match(/^[A-Za-z]:/);
    if (drive) {
      rest = rest.slice(2);
      if (rest.startsWith('/') || rest.startsWith('\\')) {
        root = drive[0] + '/';
        rest = rest.slice(1);
      } else {
        root = drive[0]; // 'C:x'：相对盘符，语义保持（不升级成绝对）
      }
      hasPrefix = true;
    } else if (rest.startsWith('/') || rest.startsWith('\\')) {
      root = '/';
      rest = rest.replace(/^[\/\\]+/, '');
      hasPrefix = true;
    }
  }
  const parts: string[] = [];
  let depth = 0; // 只数 Normal 段——字面 `..`（相对越界保留）不进深度，后续 `..` 不弹它
  for (const comp of rest.split(/[\/\\]/)) {
    if (comp === '' || comp === '.') continue;
    if (comp === '..') {
      if (depth > 0) {
        parts.pop();
        depth -= 1;
      } else if (hasPrefix) {
        return null; // 越过文件系统根
      } else {
        parts.push('..');
      }
    } else {
      parts.push(comp);
      depth += 1;
    }
  }
  return { root, parts };
}

/** `~`/`~\`/`$HOME`/`%USERPROFILE%` 前缀展开为真实主目录。与 Rust
 * expand_tilde_with（src-tauri/src/lib.rs）同构互为镜像：`~\` 与
 * `%USERPROFILE%\` 是 Windows 侧惯用写法，光认 `~/` 会漏；`~user`、
 * `$HOMEWORK` 这类非边界前缀按字面不动（展开反而错）。原住
 * NodeToolAdapter（P2-5 path_policy 刀上移），旧导入经 re-export 保持。 */
export function expandTilde(path: string, home = ''): string {
  const trimmedHome = home.replace(/[/\\]+$/, '');
  const joined = (rest: string): string => {
    const restClean = rest.replace(/^[/\\]+/, '');
    return restClean ? `${trimmedHome}/${restClean}` : trimmedHome;
  };
  const atBoundary = (rest: string): boolean => rest === '' || rest.startsWith('/') || rest.startsWith('\\');
  if (path === '~') return trimmedHome;
  if (path.startsWith('~/') || path.startsWith('~\\')) return joined(path.slice(2));
  if (path.startsWith('$HOME') && atBoundary(path.slice(5))) return joined(path.slice(5));
  if (path.startsWith('%USERPROFILE%') && atBoundary(path.slice(13))) return joined(path.slice(13));
  return path;
}

// ── 解析层（fs 原语编排）──

/** workspace + 请求路径 → 盘上真实绝对路径。对齐 Rust
 * resolve_workspace_path：最近存在祖先 canonicalize、悬空 symlink 拒绝、
 * 缺失段补回（新建文件落 symlink 中间目录的守卫）。错误文案以 Rust 份为
 * 权威口径（模型读到的失败信号两侧一致）。 */
export async function resolveWorkspacePath(
  workspace: string,
  path: string,
  fs: PathPolicyFs,
  home = '',
): Promise<string> {
  const ws = workspace.trim();
  if (!ws) throw new Error('workspace is required');
  let base: string;
  try {
    base = await fs.canonicalize(ws);
  } catch (e) {
    throw new Error(`invalid workspace '${ws}': ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!(await fs.isDir(base))) throw new Error(`workspace is not a directory: ${ws}`);

  const requested = expandTilde(path.trim(), home);
  if (!requested) throw new Error('path is required');

  const candidate = isAbsolutePath(requested) || hasPrefixComponent(requested)
    ? requested
    : joinRelative(base, requested);
  const normalized = normalizeLexical(candidate);
  if (!normalized) throw new Error(`path cannot be resolved: ${requested}`);

  let existing = joinLexical(normalized);
  const missing: string[] = [];
  while (!(await fs.exists(existing))) {
    const meta = await fs.symlinkMeta(existing);
    if (meta?.isSymlink) throw new Error(`path uses an unresolved symlink: ${requested}`);
    const name = existing.slice(existing.lastIndexOf('/') + 1);
    if (!name) throw new Error(`path cannot be resolved: ${requested}`);
    missing.push(name);
    const parent = existing.slice(0, existing.lastIndexOf('/')) || '/';
    if (parent === existing) throw new Error(`path cannot be resolved: ${requested}`);
    existing = parent;
  }
  let resolved: string;
  try {
    resolved = await fs.canonicalize(existing);
  } catch (e) {
    throw new Error(`resolve '${requested}': ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const comp of missing.reverse()) {
    resolved = resolved.replace(/[\/\\]+$/, '') + '/' + comp;
  }
  return resolved;
}

/** 路径自身是否含 symlink 组件（workspace 内的相对段逐级检查，抓中间段
 * symlink——workspace/link -> elsewhere 这类）。对齐 Rust
 * has_symlink_component：只对落在 workspace 下的归一化结果检查，落在
 * workspace 外的路径返回 false（消费方是 remove_path 的拒绝守卫与
 * path_info 的 isSymlink 报告字段）。Node 侧暂无消费者，本实现是行为锁
 * 的 TS 锚。 */
export async function hasSymlinkComponent(
  workspace: string,
  path: string,
  fs: PathPolicyFs,
  home = '',
): Promise<boolean> {
  const base = workspace.trim();
  const requested = expandTilde(path.trim(), home);
  const candidate = isAbsolutePath(requested) || hasPrefixComponent(requested)
    ? requested
    : joinRelative(base, requested);
  const normalized = normalizeLexical(candidate);
  if (!normalized) return false;
  const normalizedStr = joinLexical(normalized);
  // workspace 形状也过一遍词法归一，让前缀比对分隔符无关。
  const baseLex = normalizeLexical(base);
  if (!baseLex) return false;
  const baseStr = joinLexical(baseLex);
  const prefix = baseStr.endsWith('/') ? baseStr : baseStr + '/';
  if (normalizedStr === baseStr) return false;
  if (!normalizedStr.startsWith(prefix)) return false;
  let current = baseStr;
  for (const comp of normalizedStr.slice(prefix.length).split('/')) {
    current = current.replace(/[\/\\]+$/, '') + '/' + comp;
    const meta = await fs.symlinkMeta(current);
    if (meta?.isSymlink) return true;
  }
  return false;
}
