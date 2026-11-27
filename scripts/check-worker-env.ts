// scripts/check-worker-env.ts
// P0 闸门（engine-worker-migration 方案 2）：确认「引擎静态依赖图」能进 Worker。
//
// 为什么不用 `bun build --target=browser` 当闸门：Bun 会为 node: 内置模块塞一个
// 浏览器 shim（实测 `node:crypto` 打包成功），失败被吞掉。真正的构建闸门是
// Vite（rollup 会直接报 failed to resolve import），但它太重、也不覆盖全部入口。
// 这里做轻量静态图遍历：只跟相对 import，遇到 node:* / @tauri-apps/* 立即失败。
//
// 旁路（--audit）列出图内出现 window./document./localStorage 的文件。这些不一定
// 是错误（错误路径上的 typeof window 守卫是合法的），但每一处都要在迁移清单里
// 有明确归属，不能让「预期极少」变成漏项。
//
// 用法：
//   bun run scripts/check-worker-env.ts            # 闸门
//   bun run scripts/check-worker-env.ts --audit    # 闸门 + 运行时触碰清单

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();

/** 引擎入口。P2 起把 `src/ui/sessionWorker.ts` 加进来，闸门自动覆盖。 */
const ENTRIES = [
  'src/harness/Harness.ts',
  'src/coding-agent/CodingAgent.ts',
];

const FORBIDDEN = [
  { pattern: /^node:/, why: 'node 内置模块（Worker 里没有，Vite 也会拒绝）' },
  { pattern: /^@tauri-apps\//, why: 'Tauri API 不可在 Worker 使用（必须走主线程桥）' },
];

/**
 * 运行时触碰：只报告，不失败——守卫合法的 window 使用不该被闸门误杀。
 * 匹配收紧到具体 API：`window.contextWindowTokens`（局部变量）、prompt 文本里的
 * “document.”、正则变量 `window.match` 都不是 Worker 阻断，不应污染清单。
 */
const RUNTIME_GLOBALS = [
  { name: 'window.event', pattern: /\bwindow\s*\.\s*(?:dispatchEvent|addEventListener|removeEventListener)\b/ },
  { name: 'window.host', pattern: /\bwindow\s*\.\s*(?:location|document|__TAURI_INTERNALS__|localStorage)\b/ },
  { name: 'document.dom', pattern: /\bdocument\s*\.\s*(?:getElementById|querySelector|querySelectorAll|createElement|body|documentElement|baseURI|head|addEventListener|execCommand|visibilityState)\b/ },
  { name: 'localStorage', pattern: /\blocalStorage\s*\./ },
  { name: 'sessionStorage', pattern: /\bsessionStorage\s*\./ },
];

interface ImportEdge {
  spec: string;
  /** 该 import 语句是否为 `import type`（类型导入不产生运行时依赖）。 */
  typeOnly: boolean;
  /**
   * 动态 `import('x')`。仓库里绝大多数 node:/Tauri 依赖都是「惰性 + 浏览器守卫」
   * 写法（fileText / conventions / userHooks / trace 的注释都写明了这一点）。
   * 动态边在 Worker 里只有执行到才失败，不能和静态边一起判死；单列告警、
   * 由状态所有权地图逐项确认。
   */
  dynamic: boolean;
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 提取 import/export-from/动态 import 的字面量 specifier。
 * 不追求完整语法树：静态图里只有相对路径会被跟进，裸包名只用于禁区检查，
 * 因此正则的漏判不会放过 node:（它们一定出现在 `from '...'` 或 `import('...')`）。
 */
function collectImports(source: string): ImportEdge[] {
  const text = stripComments(source);
  const edges: ImportEdge[] = [];

  // import ... from 'x' / export ... from 'x'（跨行：非贪婪到 from）
  const fromRe = /(?:^|[\n;])\s*(import|export)\s+([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(fromRe)) {
    const clause = match[2] ?? '';
    // 兜底：没有 from 的长距离匹配会吞掉整段，长度不合理就跳过。
    if (clause.length > 4000) continue;
    edges.push({
      spec: match[3],
      typeOnly: /^\s*type\b/.test(clause),
      dynamic: false,
    });
  }

  // import 'x'（副作用导入）
  const bareRe = /(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(bareRe)) {
    edges.push({ spec: match[1], typeOnly: false, dynamic: false });
  }

  // import('x')（动态导入）
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(dynamicRe)) {
    edges.push({ spec: match[1], typeOnly: false, dynamic: true });
  }

  return edges;
}

/** 相对 specifier → 磁盘文件（支持无扩展名、.js→.ts 映射、目录 index）。 */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates: string[] = [base];

  const ext = extname(base);
  if (ext === '.js' || ext === '.jsx') {
    candidates.push(base.slice(0, -ext.length) + '.ts');
    candidates.push(base.slice(0, -ext.length) + '.tsx');
  }
  if (!ext) {
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mts`);
    candidates.push(join(base, 'index.ts'), join(base, 'index.tsx'));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function rel(file: string): string {
  return relative(ROOT, file).split('\\').join('/');
}

const visited = new Set<string>();
const queue = ENTRIES.map((entry) => resolve(ROOT, entry));
const violations: Array<{ file: string; spec: string; why: string }> = [];
const deferred: Array<{ file: string; spec: string; why: string }> = [];
const unresolvedRelative: Array<{ file: string; spec: string }> = [];

while (queue.length > 0) {
  const file = queue.pop()!;
  if (visited.has(file)) continue;
  visited.add(file);

  let source: string;
  try {
    source = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }

  for (const edge of collectImports(source)) {
    const forbidden = FORBIDDEN.find((rule) => rule.pattern.test(edge.spec));
    // 类型导入在运行时不产生依赖：它不会把 node: 或 Tauri API 带进 Worker。
    if (forbidden && !edge.typeOnly) {
      (edge.dynamic ? deferred : violations).push({ file: rel(file), spec: edge.spec, why: forbidden.why });
      continue;
    }
    if (!edge.spec.startsWith('.')) continue;
    const resolved = resolveRelative(file, edge.spec);
    if (!resolved) {
      if (!edge.typeOnly) unresolvedRelative.push({ file: rel(file), spec: edge.spec });
      continue;
    }
    queue.push(resolved);
  }
}

const audit = process.argv.includes('--audit');
console.log(`worker-env: ${ENTRIES.join(', ')} → ${visited.size} 个模块`);

if (unresolvedRelative.length > 0) {
  console.warn(`\n相对导入未解析（${unresolvedRelative.length}）：`);
  for (const item of unresolvedRelative.slice(0, 20)) {
    console.warn(`  ${item.file} → ${item.spec}`);
  }
}

if (audit) {
  console.log('\n运行时触碰（需在状态所有权地图里定归属）：');
  const hits: Array<{ file: string; globals: string[] }> = [];
  for (const file of visited) {
    let source: string;
    try {
      source = stripComments(readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const globals = RUNTIME_GLOBALS.filter((g) => g.pattern.test(source)).map((g) => g.name);
    if (globals.length > 0) hits.push({ file: rel(file), globals });
  }
  if (hits.length === 0) {
    console.log('  （无）');
  } else {
    for (const hit of hits) console.log(`  ${hit.file}: ${hit.globals.join(', ')}`);
  }
}

if (deferred.length > 0) {
  console.log(`\n惰性依赖（${deferred.length}，执行到才失败；需逐项确认守卫）：`);
  const seen = new Set<string>();
  for (const item of deferred) {
    const key = `${item.file}→${item.spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${item.file} → ${item.spec}`);
  }
}

if (violations.length > 0) {
  console.error(`\n静态依赖（${violations.length}）：Worker 环境不可用，必须改惰性导入或注入宿主实现。`);
  const seen = new Set<string>();
  for (const v of violations) {
    const key = `${v.file}→${v.spec}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  ${v.file} → ${v.spec}  [${v.why}]`);
  }
  process.exit(1);
}

console.log('OK：引擎静态图不含 node:* / @tauri-apps/*（运行时触碰见 --audit）');
