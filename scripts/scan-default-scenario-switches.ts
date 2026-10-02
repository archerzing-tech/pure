// scripts/scan-default-scenario-switches.ts
// 静默场景开关扫描器（2026-10-01）。
//
// 判据（见 改进进度记录.md 续十五）：一个形参是「场景开关」——取消/追加、
// 委派/单任务、停/暂停、构建/非构建、已批/待批——却带着默认值，于是调用点
// 忘传时不会报错，只会静默挑一个分支；而正确分支取决于调用现场，没有全局
// 安全的默认。2026-09-24 的「收掉一项被反向执行成先补这项」与 2026-09-26 的
// 「取消被引导成计划照旧」，都是这类静默兜底。
//
// 脚本不判定对错——它只把「布尔默认值」与「字符串字面量联合（枚举式）默认
// 值」的参数捞出来，按可疑度排序，供人工逐条追问「忘传会滑到哪个分支，那是
// 安全侧吗」。命中数量本身不是目标：清单里每一条都值得一次独立判断。
//
// 用法：
//   bun run scripts/scan-default-scenario-switches.ts          # 只扫生产源码
//   bun run scripts/scan-default-scenario-switches.ts --all    # 连测试一起扫
//   bun run scripts/scan-default-scenario-switches.ts --json   # 机器可读输出

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
const SOURCE_ROOT = join(ROOT, 'src');

interface Finding {
  file: string;
  line: number;
  fn: string;
  param: string;
  kind: 'boolean' | 'enum';
  defaultText: string;
  typeText: string;
  reason: string;
  score: number;
}

/** 场景词根——命中说明这个开关大概率在切换「说哪种话/走哪条路」。 */
const SCENARIO_WORDS =
  /(cancel|append|adds?along|mode|kind|type|target|scope|stage|phase|approved|enabled|silent|strict|force|delegat|suppress|simulate|dry|abort|pause|destructive|legacy|verbose|interactive|confirm|resume|continue|follow\s?up|fold|mechanical|historical|retry)/i;

function collectFiles(dir: string, includeTests: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      if (!includeTests && entry === '__tests__') continue;
      out.push(...collectFiles(full, includeTests));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    if (!includeTests && entry.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** 把类型节点解析成字符串字面量联合的取值集合；解析不出返回 null。 */
function unionLiterals(typeNode: ts.TypeNode | undefined, aliases: Map<string, ts.TypeNode>): string[] | null {
  if (!typeNode) return null;
  if (ts.isUnionTypeNode(typeNode)) {
    const values: string[] = [];
    for (const member of typeNode.types) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) values.push(member.literal.text);
      else return null;
    }
    return values;
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const target = aliases.get(typeNode.typeName.text);
    if (target) return unionLiterals(target, aliases);
  }
  return null;
}

function functionNameOf(node: ts.Node, sf: ts.SourceFile): string {
  const named = node as ts.Node & { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent)) return `${parent.name.getText(sf)}`;
  return '(anonymous)';
}

function scanFile(file: string): Finding[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const aliases = new Map<string, ts.TypeNode>();
  const collectAliases = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node.type);
    ts.forEachChild(node, collectAliases);
  };
  ts.forEachChild(sf, collectAliases);

  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    const hasParameters =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
    if (hasParameters) {
      const params = (node as ts.SignatureDeclaration).parameters;
      for (const param of params) {
        if (!param.initializer) continue;
        if (param.name && ts.isBindingPattern(param.name)) continue; // 解构默认值归配置对象，不在此列
        const named = param.name as ts.Node;
        const paramName = ts.isIdentifier(named) ? named.text : named.getText(sf);
        const init = param.initializer;

        const isBooleanLiteral = init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword;
        const isBooleanType = param.type?.kind === ts.SyntaxKind.BooleanKeyword;
        const literals = unionLiterals(param.type, aliases);

        let kind: Finding['kind'] | null = null;
        if (isBooleanLiteral || isBooleanType) kind = 'boolean';
        else if (literals && literals.length > 0) kind = 'enum';
        if (!kind) continue;

        const scenarioName = SCENARIO_WORDS.test(paramName);
        const reason = scenarioName
          ? '名字含场景词根'
          : kind === 'enum'
            ? '枚举式开关（各取值是不同场景）'
            : '布尔开关';
        const score = scenarioName ? 3 : kind === 'enum' ? 3 : 1;
        findings.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line: sf.getLineAndCharacterOfPosition(param.getStart(sf)).line + 1,
          fn: functionNameOf(node, sf),
          param: paramName,
          kind,
          defaultText: init.getText(sf),
          typeText: param.type ? param.type.getText(sf) : '(inferred)',
          reason,
          score,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return findings;
}

const includeTests = process.argv.includes('--all');
const asJson = process.argv.includes('--json');

const findings = collectFiles(SOURCE_ROOT, includeTests).flatMap(scanFile).sort((a, b) => {
  if (b.score !== a.score) return b.score - a.score;
  return `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
});

if (asJson) {
  console.log(JSON.stringify({ scanned: includeTests ? 'all' : 'production', count: findings.length, findings }, null, 2));
  process.exit(0);
}

console.log(
  `疑似静默场景开关清单（扫描范围：${includeTests ? 'src（含测试）' : 'src（仅生产）'}，命中 ${findings.length} 条）`,
);
console.log('判据：形参是场景开关却带默认值——忘传即静默选错分支。逐条追问「忘传会滑到哪」。\n');
if (findings.length === 0) {
  console.log('（无命中）');
} else {
  for (const f of findings) {
    console.log(`[${f.score}] ${f.file}:${f.line}  ${f.fn}(${f.param} = ${f.defaultText})`);
    console.log(`     类型 ${f.typeText} · ${f.kind} · ${f.reason}`);
  }
}
console.log('\n提示：枚举式开关与含场景词的布尔开关（score 3）优先排查。');
