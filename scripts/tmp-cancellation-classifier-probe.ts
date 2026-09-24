// 一次性探针（2026-09-24 取消案例修复验证）：真 GLM + 真分类提示词。
// ① 原案例句 "jev 这个就不调研了" 必须被 CANCEL_PART_RE 快路径直判
//   steer+cancelsPart（不发一次网络请求）；
// ② 正则覆盖不到的改写（无动词的"第二个就不要了"、取消动词无否定标记的
//   "jev 那个取消掉吧"）走 LLM 路径，必须给出 steer + cancels_part；
// ③ 加活对照不受影响（task，不带 cancelsPart）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DeepSeekAnthropicAdapter } from '../src/adapter/deepseek/DeepSeekAnthropicAdapter';
import { classifyInsertion } from '../src/coding-agent/Planner';
import { DynamicInsertionCoordinator } from '../src/coding-agent/DynamicInsertionCoordinator';

function loadKey(): string {
  const raw = JSON.parse(readFileSync(join(homedir(), '.pure', 'config.json'), 'utf8')) as Record<string, unknown>;
  const overrides = raw.providerOverrides as Record<string, { apiKey?: string }> | undefined;
  const key = overrides?.glm?.apiKey ?? (raw.apiKey as string | undefined);
  if (key) return key;
  const secrets = JSON.parse(readFileSync(join(homedir(), '.pure', 'secrets.json'), 'utf8')) as Record<string, string>;
  const sk = secrets['llm.apiKey.glm'] ?? secrets['llm.apiKey'];
  if (!sk) throw new Error('No GLM API key found');
  return sk;
}

const adapter = new DeepSeekAnthropicAdapter({
  apiKey: loadKey(),
  model: 'glm-5.3-flash',
  baseURL: 'https://open.bigmodel.cn/api/anthropic',
  maxTokens: 1024,
});

const CONTEXT = '用户主任务：研一下当前 AI 领域的三个热点：1. RSIAgent 2. jev 不聊天的模型 3. LLM 的未来趋势。已并行派出三个调研子代理（RSIAgent 调研中、jev 不聊天的模型调研中、LLM 未来趋势调研中），等全部返回后合并输出一份汇总。';

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
}

// ① 原案例句：快路径直判，零网络。
{
  const coordinator = new DynamicInsertionCoordinator();
  const d = await coordinator.decide(adapter, CONTEXT, { text: 'jev 这个就不调研了' });
  check('fast-path', d.kind === 'steer' && d.signals.rule === 'CANCEL_PART_RE' && d.signals.cancelsPart === true,
    `kind=${d.kind} rule=${String(d.signals.rule)} cancelsPart=${String(d.signals.cancelsPart)}`);
}

// ②③ LLM 路径：改写句 + 加活对照。失败重试一次再判。
async function probe(text: string): Promise<{ kind: string; confidence: number; cancelsPart?: boolean; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await classifyInsertion(adapter, CONTEXT, text);
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  throw new Error('unreachable');
}

for (const c of [
  { text: '第二个就不要了', want: 'steer', wantCancel: true },
  { text: 'jev 那个取消掉吧', want: 'steer', wantCancel: true },
  { text: '帮我看看竞品的定价策略', want: 'task', wantCancel: false },
]) {
  const r = await probe(c.text);
  const ok = r.kind === c.want && (c.wantCancel ? r.cancelsPart === true : r.cancelsPart === undefined);
  check(c.text, ok, `want=${c.want}${c.wantCancel ? '+cancel' : ''} got=${r.kind}${r.cancelsPart ? '+cancel' : ''} conf=${r.confidence} reason=${r.reason}`);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
