// 设置 → 网络代理 →「校验 TLS 证书」的接线（2026-10-26）：这个开关的语义
// 与直觉相反（默认不勾 = 不校验，内网拦截网关环境靠它连通），所以这里锁四件
// 事：控件在网络代理页、保存真的把值读进 config、persistConfig 把值同步给
// Rust（set_tls_verify）、启动时也同步一次（否则重启后 Rust 又回到默认）。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('设置页 · TLS 证书校验开关', () => {
  it('控件放在网络代理页，「启用代理」行之后', () => {
    const html = read('../../../index.html');
    const proxyPage = html.indexOf('data-page="proxy"');
    const skillsPage = html.indexOf('data-page="skills"');
    const block = html.indexOf('data-i18n="proxy.tlsVerify"');
    expect(proxyPage).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(proxyPage);
    expect(block).toBeLessThan(skillsPage);
    expect(html).toContain('id="cfg-tls-verify"');
    // 文案写明默认不校验的语义与风险，不让用户误以为勾选是默认态。
    expect(html).toContain('data-i18n="proxy.tlsVerify.hint"');
  });

  it('autoSave 读取开关值并写进 config.tlsVerify', () => {
    const src = read('../settings.ts');
    expect(src).toContain("'#cfg-tls-verify'");
    expect(src).toContain("document.getElementById('cfg-tls-verify') as HTMLInputElement | null)?.checked ?? false");
    // 打开设置时从 config 回填（undefined = 不勾选）。
    expect(src).toContain('tlsVerifyEl.checked = cfg.tlsVerify === true');
  });

  it('persistConfig 与启动路径都把开关同步给 Rust', () => {
    const src = read('../config.ts');
    expect(src).toContain("core?.invoke('set_tls_verify'");
    // 单一收口：每次持久化都同步。
    expect(src).toContain('syncTlsVerifyToRust(cfg);');
    // 启动时 config.json/localStorage 恢复完成后同步一次。
    expect(src).toContain('syncTlsVerifyToRust(loadConfig() ?? defaults())');
  });
});
