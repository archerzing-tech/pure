// 常备排查工具（2026-09-28）：给裁决请求注入 `thinking: {type:'disabled'}`
// （bigmodel 端点认这个参数，见 shared/providers.ts 的 planThinkingOffExtraBody
// 实测注），其余一切不变——同一批句子、同一提示词、同一超时预算，只差这一个
// 开关。
//
// 什么时候用它：「某句插话总是走兜底」这类怀疑——先分清是模型的判断质量还是
// 度量方式。**首字 90s+ 而 stream 无异常、裸文本为空**就是暗推理被透明丢弃的
// 特征（适配器只透传 text_delta，思考那几十秒在调用方看来是字节级静默），
// 与句子语义无关；极简 system 下同一句 8.5s 就回来了。
//
// 用法：bun scripts/probe-insertion-thinking.ts [超时ms]
// 期望：开着一列大量「兜底（25s 预算内不出字）」，关掉一列全部判出。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyInsertion } from '../src/coding-agent/Planner';
import { DeepSeekAnthropicAdapter } from '../src/adapter/deepseek/DeepSeekAnthropicAdapter';
import type { LLMAdapter, LLMChunk, Message, ToolDefinition } from '../src/shared/types';

function resolveKey(): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), '.pure', 'config.json'), 'utf8')) as {
      apiKey?: string;
      providerOverrides?: Record<string, { apiKey?: string }>;
    };
    const k = raw.providerOverrides?.glm?.apiKey ?? raw.apiKey;
    if (k) return k;
  } catch {
    /* fallthrough */
  }
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.pure', 'secrets.json'), 'utf8')) as Record<string, string>;
    return s['llm.apiKey.glm'] ?? s['llm.apiKey'] ?? null;
  } catch {
    return null;
  }
}

const KEY = resolveKey();
if (!KEY) {
  console.error('没有 GLM key');
  process.exit(1);
}
const TIMEOUT = Number(process.argv[2] ?? '') || 20_000;
const CTX = [
  '用户当前诉求：帮我调研 B站/腾讯/优酷 三个平台的会员价格，最后出一份对比汇总',
  '并行委派：共 3 个，在飞 3 个',
].join('\n');

const SENTENCES = [
  '不要只查均价，把区间也查了',
  '记得跑测试',
  'X 就不调研了',
  'B站那支别查了，再加一个爱奇艺',
  '把区间也查了',
];

function makeAdapter(thinkingOff: boolean): LLMAdapter {
  const adapter = new DeepSeekAnthropicAdapter({
    apiKey: KEY!,
    model: 'glm-5.3-flash',
    baseURL: 'https://open.bigmodel.cn/api/anthropic',
    maxTokens: 8192,
  });
  if (thinkingOff) {
    const client = (adapter as unknown as { client: { messages: { stream: (p: unknown, o?: unknown) => unknown } } }).client;
    const orig = client.messages.stream.bind(client.messages);
    client.messages.stream = (params: unknown, opts?: unknown) =>
      orig({ ...(params as Record<string, unknown>), thinking: { type: 'disabled' } }, opts);
  }
  return adapter as unknown as LLMAdapter;
}

async function run(thinkingOff: boolean): Promise<void> {
  console.log(`\n════ thinking: ${thinkingOff ? 'disabled（注入）' : '默认（开着）'}  超时 ${TIMEOUT}ms ════`);
  const real = makeAdapter(thinkingOff);
  let ok = 0;
  for (const text of SENTENCES) {
    let ttft: number | null = null;
    const t0 = Date.now();
    const wrapped = {
      stream: async function* (m: Message[], t: ToolDefinition[], s?: AbortSignal): AsyncGenerator<LLMChunk, void, void> {
        for await (const c of real.stream(m, t, s)) {
          if (ttft === null) ttft = Date.now() - t0;
          yield c;
        }
      },
      complete: real.complete.bind(real),
    } as unknown as LLMAdapter;
    const v = await classifyInsertion(wrapped, CTX, text, undefined, undefined, TIMEOUT);
    const wall = Date.now() - t0;
    if (!v.fallbackUsed) ok++;
    console.log(
      `  「${text}」 TTFT=${ttft === null ? '—' : ttft + 'ms'} wall=${wall}ms ⇒ ` +
      (v.fallbackUsed ? '兜底' : `kind=${v.kind} conf=${v.confidence} cancels=${v.cancelsPart === true} adds=${v.addsAlong === true}`),
    );
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log(`  有效裁决 ${ok}/${SENTENCES.length}`);
}

await run(false);
await run(true);
