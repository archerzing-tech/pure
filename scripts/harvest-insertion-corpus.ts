// 疑点句收割：把设置页「插话决策日志」的导出（每行一条 JSON，复制按钮给的
// 就是这个格式）里，被事后审计标出疑点的句子，并进插话语料。
//
// 用法：
//   bun scripts/harvest-insertion-corpus.ts tmp/diag.jsonl        收割并写盘
//   bun scripts/harvest-insertion-corpus.ts tmp/diag.jsonl --dry  只看会加什么
//   cat tmp/diag.jsonl | bun scripts/harvest-insertion-corpus.ts -  从 stdin
//
// 写的是生成文件 src/coding-agent/insertionCorpusHarvested.ts：里面每条都标
// expectation: 'suspected'（期望从疑点原因反推，未复核），回归与回放都会带上
// 它们。复核后想升格为断言语料，手工搬到 insertionCorpus.ts 的 CASES。

import { readFileSync, writeFileSync } from 'node:fs';
import { HARVESTED_CASES } from '../src/coding-agent/insertionCorpusHarvested';
import { ALL_CASES } from '../src/coding-agent/insertionCorpus';
import { harvestCasesFromLog, renderHarvestedModule } from '../src/coding-agent/insertionHarvest';
import { parseInputDecisionLog } from '../src/coding-agent/inputDecision';

// 输出路径：默认写生成的语料模块；PURE_HARVEST_OUT 可改道（验证写盘行为时
// 不必真的动仓库里的语料）。
const GENERATED_PATH = process.env.PURE_HARVEST_OUT ?? 'src/coding-agent/insertionCorpusHarvested.ts';

// 产物格式来自共享渲染器（设置页的「收割」按钮用的是同一个函数）——两边给出
// 的文件必须逐字相同，所以这里绝不另写一份模板。
const arg = process.argv[2];
if (!arg) {
  console.error('用法：bun scripts/harvest-insertion-corpus.ts <导出的 JSONL 文件|-> [--dry]');
  process.exit(1);
}
const dry = process.argv.includes('--dry');
const raw = arg === '-' ? readFileSync(0, 'utf8') : readFileSync(arg, 'utf8');
const entries = parseInputDecisionLog(raw);
if (entries.length === 0) {
  console.error('这份导出里没有可解析的决策行（期望每行一条 JSON，见设置页的复制按钮）。');
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
const { added, skipped } = harvestCasesFromLog(entries, ALL_CASES, stamp);
const kept = HARVESTED_CASES;

console.log(`读入 ${entries.length} 条决策；语料现有 ${ALL_CASES.length} 句（其中收割 ${kept.length} 句）。`);
const tally = new Map<string, number>();
for (const s of skipped) tally.set(s.why, (tally.get(s.why) ?? 0) + 1);
console.log(`跳过：${[...tally].map(([k, v]) => `${k} ${v}`).join('，') || '无'}`);

if (added.length === 0) {
  console.log('没有新的疑点句——语料已经覆盖了这一段的疑点。');
  process.exit(0);
}
console.log(`\n新收割 ${added.length} 句（标记 suspected，待复核）：`);
for (const c of added) {
  console.log(`  「${c.text}」  ${c.source}`);
}

if (dry) {
  console.log('\n--dry：没有写盘。');
  process.exit(0);
}
writeFileSync(GENERATED_PATH, renderHarvestedModule([...kept, ...added]));
console.log(`\n已写入 ${GENERATED_PATH}（收割语料共 ${kept.length + added.length} 句）。`);
