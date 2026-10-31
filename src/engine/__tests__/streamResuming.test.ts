// src/engine/__tests__/streamResuming.test.ts
// 流式偶发中断的引擎层两修(2026-10-18):静默续跑过去零提示(缺口是一次
// 完整请求往返,几十秒,UI 读作「输出停住了」),已完成的回复会被「全文 ```
// 奇偶数」启发式误判截断而强制续写。钉住:行首 fence 判定的行为、两处
// StreamResuming yield、GUI 侧的开卡文案。源码钉为主——引擎行为测试需要
// 整条 mock 流,回报不成比例。
import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (url: URL): string => readFileSync(url, 'utf8').replace(/\r\n/g, '\n');

describe('silentlyTruncated 的行首 fence 判定', () => {
  // 与 AgentLoopEngine.ts 内联正则保持同一形状(CommonMark:fence 允许 ≤3 个
  // 前导空格)。
  const oddLineInitialFences = (content: string): boolean =>
    (content.match(/^[ \t]{0,3}```/gm) ?? []).length % 2 === 1;

  it('行内提到 ``` 不再误判为截断(旧行为的全文本计数会)', () => {
    expect(oddLineInitialFences('用 ``` 包代码是 markdown 语法,这一个回复就完了。')).toBe(false);
    expect('用 ``` 包代码是 markdown 语法。'.match(/```/g) ?? []).toHaveLength(1); // 旧判定会误伤
  });

  it('行首未闭合 fence 仍然命中(真截断)', () => {
    expect(oddLineInitialFences('前言\n```html\n<div>未闭合')).toBe(true);
  });

  it('≤3 空格缩进的 fence 算行首,4 空格不算(CommonMark)', () => {
    expect(oddLineInitialFences('前言\n ```js\ncode')).toBe(true);
    expect(oddLineInitialFences('前言\n    ```js\ncode')).toBe(false);
  });

  it('闭合的 fence 对不触发', () => {
    expect(oddLineInitialFences('看:\n```js\ncode()\n```\n完了。')).toBe(false);
  });
});

describe('StreamResuming:静默续跑必须自己开口', () => {
  const engine = readSource(new URL('../AgentLoopEngine.ts', import.meta.url));

  it('截断续跑与超时续跑两处都 yield StreamResuming(attempt/max/reason)', () => {
    const yields = engine.match(/yield \{ type: 'StreamResuming', payload: \{ attempt: streamResumes, max: MAX_STREAM_RESUMES, reason: '[a-z]+' \}, timestamp: Date\.now\(\) \}/g) ?? [];
    expect(yields).toHaveLength(2);
    expect(yields[0]).toContain("reason: 'stall'");
    expect(yields[1]).toContain("reason: 'timeout'");
    // yield 先于 continue——事件在重新发起请求之前到达 UI。
    for (const y of yields) {
      const after = engine.slice(engine.indexOf(y));
      expect(after.indexOf('continue;')).toBeGreaterThan(after.indexOf('messages.push'));
    }
  });

  it('事件类型带 max 上沿,GUI 文案带次数', () => {
    const types = readSource(new URL('../../../src/shared/types.ts', import.meta.url));
    expect(types).toContain("| { type: 'StreamResuming'; payload: { attempt: number; max: number; reason: 'stall' | 'timeout' }; timestamp: number }");
    const chat = readSource(new URL('../../../src/ui/chat.ts', import.meta.url));
    expect(chat).toContain("case 'StreamResuming':");
    expect(chat).toContain('回复断了一下，正在接着生成（第 ${event.payload.attempt}/${event.payload.max} 次）…');
    // 开卡守卫与 TransportStatus 同款:工具行在场上时不重复开卡。
    const caseAt = chat.indexOf("case 'StreamResuming':");
    const body = chat.slice(caseAt, caseAt + 700);
    expect(body).toContain('pendingRows.size === 0 && pendingByName.size === 0');
  });
});

describe('空正文流超时的专属短阶梯(2026-10-30 判例)', () => {
  const engine = readSource(new URL('../AgentLoopEngine.ts', import.meta.url));

  it('上限 2 次而不是 5 级 identical-call 阶梯(白等 10 分钟判例)', () => {
    expect(engine).toContain('let streamTimeoutRepeats = 0;');
    expect(engine).toContain('const MAX_STREAM_TIMEOUT_RETRIES = 2;');
    // 空正文超时不 push 进通用 failures 阶梯:短阶梯分支先于 failures.push 生效。
    const ladderAt = engine.indexOf('        if (isTimeout) {');
    expect(ladderAt).toBeGreaterThan(-1);
    expect(engine.slice(ladderAt, ladderAt + 1400)).toContain('streamTimeoutRepeats++');
  });

  it('第 2 次停时说真话:链路卡住不是用户网络问题,可直接重发', () => {
    expect(engine).toContain('服务端或中转链路在流中卡住了，不是你的网络问题');
    expect(engine).toContain('本回合已停止；可直接重新发送，或稍后再试。');
    // 散文不再写死分钟数——首块超时上限(300s)与流中 idle(120s)不同,写死「2 分钟」曾是错的。
    expect(engine).toContain('每次等满超时上限后放弃');
  });

  it('停时不做收尾轮:刚连卡两次,handover 大概率再卡满 2 分钟', () => {
    const stopAt = engine.indexOf('const stopReason = `模型的流式连接连续 ${streamTimeoutRepeats} 次');
    const tail = engine.slice(stopAt, engine.indexOf('interrupted = true; break;', stopAt));
    expect(tail).not.toContain('emitHandover');
    expect(tail).toContain('salvageStopMessages');
    expect(tail).toContain("type: 'Interrupted'");
  });

  it('第 1 次重试也开口(StreamResuming,attempt 计短阶梯自己的数)', () => {
    expect(engine).toContain("yield { type: 'StreamResuming', payload: { attempt: streamTimeoutRepeats, max: MAX_STREAM_TIMEOUT_RETRIES, reason: 'timeout' }, timestamp: Date.now() };");
  });

  it('打击预算随干净工具轮清零(长任务放大器修正,2026-10-31)', () => {
    // 原缺陷:streamTimeoutRepeats/streamResumes 跨整回合累计、成功不清零,
    // 几十个 THINK 轮的长回合先后撞上互不相干的瞬时流超时就在无关位置被杀。
    const resetAt = engine.indexOf('toolErrors.length === 0) {');
    expect(resetAt).toBeGreaterThan(-1);
    const block = engine.slice(resetAt, resetAt + 500);
    expect(block).toContain('streamResumes = 0;');
    expect(block).toContain('streamTimeoutRepeats = 0;');
    expect(block).toContain('toolCallResumes = 0;');
  });

  it('流超时重试带退避(t=0 立即重发对拥塞服务端是确定性重败)', () => {
    expect(engine).toContain('streamRetryBackoffMs');
    // 两处重发点(有正文续跑 + 空正文短阶梯)都先退避再 continue。
    expect((engine.match(/setTimeout\(resolve, streamRetryBackoffMs\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('半截工具调用的流超时借 TOOL_CALL_RESUME_HINT 重发而非 2 次即停', () => {
    // 中转对大块 JSON 参数的缓冲攒批足以制造超 idle 上限的静默;此刻无工具
    // 执行过,从头重发幂等安全——与 done 未至的同类场景同通道。
    expect(engine).toContain('if (isTimeout && sawToolCall && !sawDone && toolCallResumes < MAX_TOOL_CALL_RESUMES)');
  });

  it('停时 Interrupted 带结构化 reasonCode(UI 分类第一依据,prose 只是回退)', () => {
    expect(engine).toContain("reasonCode: 'stream_timeout'");
    expect(engine).toContain("reasonCode: 'failure_policy_stop'");
  });
});
