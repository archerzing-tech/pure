// src/shared/thirdPartyScope.ts
// 三方件默认不在理解范围（2026-09-20 用户定）。
//
// 用户让 pure 审计、调研、二次开发、探索、理解一个项目时，依赖安装目录是
// 供应商的产物，不是项目的代码——递归列一个 JS 项目把几万个 node_modules
// 条目灌进上下文，烧的是 token，毁的是注意力。所以列目录 / glob / 文件搜索
// 默认跳过这些目录，理解项目以它自己的代码和清单/锁文件为准。
//
// "默认"不是"禁止"：任务明确指名道姓要进某个三方件目录（path / pattern
// 本身落在里面）时不过滤——比如排查依赖 bug 就是要读 node_modules 里的包。

/** 依赖 / 构建产物目录名（按路径段匹配，不分大小写）。与 code_searcher 的
 *  rg 排除表、pathIndex 的索引排除表保持同一口径。 */
export const THIRD_PARTY_DIR_NAMES: readonly string[] = [
  '.git',
  'node_modules',
  'bower_components',
  'vendor',
  'Pods',
  'site-packages',
  '.venv',
  'venv',
  '.tox',
  '__pycache__',
  'target',
  'dist',
  'build',
];

const THIRD_PARTY_SET = new Set(THIRD_PARTY_DIR_NAMES.map((d) => d.toLowerCase()));

/** 路径里任何一段落在三方件目录下就算：'node_modules/pkg/index.js'、
 *  'project/.venv/lib/x.py' 都命中；'src/target.ts' 是一个文件名不是目录段，
 *  不命中（split 之后没有独立的 'target' 段）。 */
export function isThirdPartyPath(relPath: string): boolean {
  if (!relPath) return false;
  return relPath.split(/[\\/]/).some((segment) => THIRD_PARTY_SET.has(segment.toLowerCase()));
}

/** 英文 persona 的范围约定（code_reviewer / project_auditor）。 */
export const THIRD_PARTY_SCOPE_NOTE_EN =
  '\nScope: third-party dependency directories (node_modules, bower_components, vendor, Pods, venv / site-packages, target, dist, build, …) are OUT of scope by default — understand and judge the project by its own code plus its manifests and lockfiles, never by what sits inside installed dependencies. Listing, globbing and file search skip those directories; step into one only when the task names it explicitly or the user explicitly asks for a dependency-inclusive audit.';

/** 中文 persona 的范围约定（researcher 等）。 */
export const THIRD_PARTY_SCOPE_NOTE_ZH =
  '\n范围约定：三方件目录（node_modules、bower_components、vendor、Pods、venv/site-packages、target、dist、build 等）默认不在审视范围内——理解项目以它自己的代码和清单/锁文件为准，不要钻进依赖安装目录；列目录、glob 和文件搜索都会自动跳过这些目录。只有任务明确指名某个依赖目录、或用户明确要求把三方件纳入审计时，才进去看具体内容。';
