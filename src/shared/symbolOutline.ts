// src/shared/symbolOutline.ts
// read_file(outline:true) 的纯函数面（2026-11-17）：中大型仓库里「先看结构、
// 再决定读哪一段」应当是**一次调用**，而不是逐页翻。这里只做机械的声明行
// 抽取（函数/类/方法/类型 + 行号），不解析 AST、不做语义判断——判据按语言
// 族收得很窄，宁可漏一个局部函数，也不要把正文行当符号塞给模型。
//
// Rust 侧（src-tauri/src/lib.rs 的 symbol_outline）是同一套判据的镜像：GUI 与
// CLI 输出形状必须一致，改规则要两边同步。

export type OutlineFamily = 'js' | 'python' | 'rust' | 'go' | 'jvm' | 'ruby' | 'php' | 'none';

/** 大纲符号上限：再多就不是「结构」而是第二份正文。 */
export const OUTLINE_MAX_SYMBOLS = 120;
/** 单条符号的展示上限（压缩成一行的 minified 代码不该把大纲撑爆）。 */
export const OUTLINE_MAX_LINE_CHARS = 160;

const FAMILY_BY_EXT: Record<string, OutlineFamily> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
  py: 'python', pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'jvm', kt: 'jvm', kts: 'jvm', scala: 'jvm', cs: 'jvm', swift: 'jvm',
  rb: 'ruby',
  php: 'php',
};

export function outlineFamilyFor(path: string): OutlineFamily {
  const base = path.split(/[\\/]/).pop() ?? path;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
  return FAMILY_BY_EXT[ext] ?? 'none';
}

/** 控制流关键字 + 常见非声明词：方法正则按「标识符 + 圆括号」匹配，不收
 *  这些词就会把 `if (x) {`、`for (...) {` 当成方法行。 */
const NON_DECLARATIONS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'with',
  'new', 'await', 'yield', 'throw', 'typeof', 'delete', 'void', 'super', 'this',
]);

interface FamilyPatterns {
  /** 整行匹配即算一条声明。 */
  declarations: RegExp[];
  /** 方法形态额外抽一次标识符，用来排除控制流关键字。 */
  methods: RegExp[];
}

const PATTERNS: Record<Exclude<OutlineFamily, 'none'>, FamilyPatterns> = {
  js: {
    declarations: [
      /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|namespace)\s+[A-Za-z_$]/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::\s*[^=]+)?=>|function\b)/,
    ],
    methods: [
      /^\s{2,}(?:(?:public|private|protected|static|readonly|abstract|async|override|get|set|\*)\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\s*\{/,
    ],
  },
  python: {
    declarations: [/^\s*(?:async\s+)?def\s+\w+/, /^\s*class\s+\w+/],
    methods: [],
  },
  rust: {
    declarations: [
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+/,
      /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl|mod|type|const|static|union|macro_rules!)\b/,
    ],
    methods: [],
  },
  go: {
    declarations: [/^func\s+(?:\([^)]*\)\s*)?\w+/, /^type\s+\w+/],
    methods: [],
  },
  jvm: {
    declarations: [/^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|data|open|internal|override|partial)\s+)*(?:class|interface|enum|record|object|struct)\s+\w+/],
    methods: [/^\s*(?:public|private|protected|internal|static|final|abstract|synchronized|async|open|override|sealed)\s+[\w<>[\],.? ]+\s+\w+\s*\(/],
  },
  ruby: {
    declarations: [/^\s*(?:def|class|module)\s+\w+/, /^\s*def\s+self\.\w+/],
    methods: [],
  },
  php: {
    declarations: [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+\w+/, /^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+\w+/],
    methods: [],
  },
};

function declarationName(line: string): string {
  const trimmed = line.trimStart();
  const match = trimmed.match(/[A-Za-z_$][\w$]*/);
  return match ? match[0] : '';
}

/** 抽符号：返回行号 + 原行（去掉行尾空白、压到 OUTLINE_MAX_LINE_CHARS）。 */
export function extractSymbolOutline(text: string, path: string): Array<{ line: number; text: string }> {
  const family = outlineFamilyFor(path);
  if (family === 'none') return [];
  const patterns = PATTERNS[family];
  const symbols: Array<{ line: number; text: string }> = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const matched = patterns.declarations.some((re) => re.test(line));
    const isMethod = !matched && patterns.methods.some((re) => re.test(line));
    if (!matched && !isMethod) continue;
    if (isMethod && NON_DECLARATIONS.has(declarationName(line))) continue;
    symbols.push({
      line: index + 1,
      text: line.trimEnd().slice(0, OUTLINE_MAX_LINE_CHARS),
    });
    if (symbols.length >= OUTLINE_MAX_SYMBOLS) break;
  }
  return symbols;
}

/** 给模型看的成稿。头部带行数与符号数，让模型知道这份大纲相对于全文有多小；
 *  没有大纲的文件类型如实说没有，而不是回一份空串让它以为文件是空的。 */
export function formatSymbolOutline(path: string, text: string): string {
  // 末尾空行不算行：与 Rust 的 text.lines().count() 对齐，同一文件两个面
  // 必须报同一个行数。
  const normalized = text.replace(/\n+$/, '');
  const totalLines = normalized.trim() ? normalized.split('\n').length : 0;
  const family = outlineFamilyFor(path);
  if (family === 'none') {
    return `[outline: ${path} — ${totalLines} lines; no symbol outline for this file type, read a range with startLine/endLine]`;
  }
  const symbols = extractSymbolOutline(text, path);
  if (symbols.length === 0) {
    return `[outline: ${path} — ${totalLines} lines; no declaration lines matched, read a range with startLine/endLine]`;
  }
  const body = symbols.map((symbol) => `${symbol.line}: ${symbol.text}`).join('\n');
  const capNote = symbols.length >= OUTLINE_MAX_SYMBOLS
    ? `\n[outline capped at ${OUTLINE_MAX_SYMBOLS} symbols — read a range for the rest]`
    : '';
  return `[outline: ${path} — ${totalLines} lines, ${symbols.length} symbols]\n${body}${capNote}`;
}
