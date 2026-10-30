// src/ui/__tests__/proxyProbe.test.ts
// 代理健康探测调度（期2 路由脑）的锚测试。调度模块薄（~80 行状态机），
// 逻辑行为已由 netRoute 侧的 recordProxyProbe/proxyHealthInfo 单测钉住，
// 这里用源码锚钉「何时探、如何防抖」的纪律——删掉任何一条，发现的是
// 调度契约被拆，而不是某个函数坏掉。不引入 mock.module（单进程顺序地
// 雷，见 bun-test-cross-file-mock-pollution 判例）。
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const readSource = (url: URL): string => readFileSync(url, 'utf8');

describe('proxyProbe 调度纪律', () => {
  const src = readSource(new URL('../proxyProbe.ts', import.meta.url));

  it('探测写路由脑：结论只经 recordProxyProbe 落表，不私藏状态', () => {
    expect(src).toContain('recordProxyProbe(raw, r?.ok === true, Date.now(), r?.latencyMs)');
    // 命令不可用（旧后端）按死处理：如实落失败行，5 分钟后重探自愈。
    expect(src).toContain('recordProxyProbe(raw, false, Date.now())');
  });

  it('幂等：进行中不重复发（failure 风暴下不会打出探测洪水）', () => {
    expect(src).toContain('if (!raw || inFlight) return;');
    expect(src).toContain('inFlight = true;');
    expect(src).toContain('inFlight = false;');
  });

  it('failure 触发有 30s 节流：撞墙是每请求级的，探测不能跟着走', () => {
    expect(src).toContain("reason === 'failure' && now - lastProbeAt < PROXY_PROBE_MIN_GAP_MS");
    expect(src).toMatch(/PROXY_PROBE_MIN_GAP_MS = 30_000/);
    // manual / reprobe 不受节流约束：用户显式动作立即生效。
    expect(src).toContain('lastProbeAt = 0; // 手动动作不受节流约束');
  });

  it('常态循环：启动一次 + 每 5 分钟，幂等可多处调用', () => {
    expect(src).toMatch(/PROXY_PROBE_INTERVAL_MS = 5 \* 60_000/);
    expect(src).toContain("void probeProxyNow('startup');");
    expect(src).toContain("void probeProxyNow('periodic')");
    expect(src).toContain('if (loopStarted) return;');
  });

  it('无代理不探：没有可探的东西就不发网络请求', () => {
    expect(src).toContain("const raw = cfg ? effectiveProxyUrl(cfg.proxy) : '';");
    expect(src).toContain('if (!raw || inFlight) return;');
    // 设置页快照同样按「未配置」短路（badge 整行隐藏由 settings 侧执行）。
    expect(src).toContain('if (!raw) return { state: \'unknown\', configured: false };');
  });

  it('对话内零打扰：调度模块不碰任何上屏面', () => {
    expect(src).not.toContain('thinkingCard');
    expect(src).not.toContain('showToast');
    expect(src).not.toContain('setThinkingNetDiagnosis');
  });

  it('chat 侧只在真实撞墙时触发重探，结论不出设置页', () => {
    const chat = readSource(new URL('../chat.ts', import.meta.url));
    // 两个真实撞墙点：web/工具面 + LLM 主路。
    expect(chat).toContain("if (!outcome.ok && outcome.route === 'proxy') notifyProxyFailure();");
    expect(chat).toContain('if (llmProxy.proxyUrl) notifyProxyFailure();');
    expect(chat).toContain('startProxyProbeLoop();');
  });

  it('settings 侧：徽标三态渲染 + 打开代理页补探 + 保存后重探', () => {
    const settings = readSource(new URL('../settings.ts', import.meta.url));
    expect(settings).toContain('private renderProxyHealthBadge(): void {');
    expect(settings).toContain("const state = snap.state === 'unknown' && isProbeInFlight() ? 'checking' : snap.state;");
    // 三态文案键齐全（zh/en 都有，t() 查 en 兜底）。
    for (const key of ['proxy.health.alive', 'proxy.health.dead', 'proxy.health.unknown', 'proxy.health.checking']) {
      expect(settings).toContain(`t('${key}')`);
    }
    // 打开代理页：先按已有结论重绘，再补一次探测，完成后重绘。
    expect(settings).toContain("void probeProxyNow('manual').then(() => this.renderProxyHealthBadge());");
    // 保存代理配置：解节流重探 + 完成后重绘。
    expect(settings).toContain('void reprobeProxyAfterConfigChange().then(() => this.renderProxyHealthBadge());');
    // 未配置代理整行隐藏。
    expect(settings).toContain('row.hidden = true;');
  });

  it('i18n：zh/en 两份键族对齐，dead 文案如实说「已自动改走直连」', () => {
    const i18n = readSource(new URL('../../shared/i18n.ts', import.meta.url));
    for (const key of ['proxy.health', 'proxy.health.hint', 'proxy.health.alive', 'proxy.health.dead', 'proxy.health.unknown', 'proxy.health.checking']) {
      // 两份语言表各出现一次。
      expect(i18n.split(`'${key}':`).length - 1).toBe(2);
    }
    expect(i18n).toContain('不可达（自 {time}）— 已自动改走直连');
    expect(i18n).toContain('Unreachable (since {time}) — routed direct automatically');
  });
});
