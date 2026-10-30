// src/ui/__tests__/llmWarm.test.ts
// LLM 预热循环（期3 路由脑）的锚测试。调度模块薄（~100 行状态机），
// 预热的传输层行为由 Rust 侧 warm_llm_routes 单测钉住，这里用源码锚钉
// 「何时暖、如何防抖、失败如何静默」的纪律——删掉任何一条，发现的是
// 调度契约被拆，而不是某个函数坏掉。不引入 mock.module（单进程顺序地
// 雷，见 bun-test-cross-file-mock-pollution 判例）。
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (url: URL): string => readFileSync(url, 'utf8');

describe('llmWarm 预热调度纪律', () => {
  const src = readSource(new URL('../llmWarm.ts', import.meta.url));

  it('常态循环：启动一次 + 每 30s，幂等可多处调用', () => {
    expect(src).toMatch(/WARM_INTERVAL_MS = 30_000/);
    expect(src).toContain('void warmLlmRoutesNow();');
    expect(src).toContain('void warmLlmRoutesNow()');
    expect(src).toContain('if (loopStarted) return;');
  });

  it('幂等：进行中不重复发（慢 tick 不会叠出预热洪水）', () => {
    expect(src).toContain('if (warmInFlight) return;');
    expect(src).toContain('warmInFlight = true;');
    expect(src).toContain('warmInFlight = false;');
  });

  it('无端点不预热：初始化早期不发网络请求', () => {
    // 端点解析与 chat_stream 同一套（customBaseURL），且必须是 http(s) URL。
    expect(src).toContain('return customBaseURL(customs, config.provider, config.providerOverrides);');
    expect(src).toContain("if (!baseUrl || !/^https?:\\/\\//.test(baseUrl)) return;");
  });

  it('失败静默：预热是尽力而为，不进学习表不上屏', () => {
    expect(src).toContain('} catch {');
    expect(src).not.toContain('recordProxyProbe');
    expect(src).not.toContain('recordNetOutcome');
    expect(src).not.toContain('showToast');
    expect(src).not.toContain('thinkingCard');
  });

  it('busy 让路交给 Rust 在飞计数，TS 侧不自己判流式状态', () => {
    const rust = readSource(new URL('../../../src-tauri/src/lib.rs', import.meta.url));
    // busy 判定纯函数 + chat_stream 的 RAII 计数守卫。
    expect(rust).toContain('fn warm_skip_reason(inflight: usize, base_url: &str)');
    expect(rust).toContain('LLM_INFLIGHT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);\n    let _inflight = LlmInflightGuard;');
    // 预热 GET 5s 封顶：慢路不许占着预热通道。
    expect(rust).toContain('timeout(std::time::Duration::from_secs(5))');
  });

  it('chat 侧接线：预热循环随会话控制器启动，与代理探测同点', () => {
    const chat = readSource(new URL('../chat.ts', import.meta.url));
    expect(chat).toContain('startLlmWarmLoop();');
    expect(chat).toContain("import { startLlmWarmLoop } from './llmWarm';");
  });
});
