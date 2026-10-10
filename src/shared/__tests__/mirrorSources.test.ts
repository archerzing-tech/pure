// src/shared/__tests__/mirrorSources.test.ts
// 镜像源清单的自洽性。这些断言的价值在于**清单是数据不是记忆**：域名写错、
// 重复、信任层级标错都会在这条 ratchet 上炸掉，而不是等到用户换源失败。

import { describe, expect, it } from 'bun:test';
import {
  AUTO_TRUST_TIERS,
  BENCHMARK_PATHS,
  ECOSYSTEMS,
  MIRROR_SOURCES,
  TRUST_LABELS,
  benchmarkUrlFor,
  buildBenchmarkUrl,
  candidatesFor,
  defaultSourceFor,
  fileScopeAllowed,
  getMirrors,
  isAutoTrusted,
  isEcosystem,
  type Ecosystem,
  type MirrorSource,
  type TrustTier,
} from '../mirrorSources';

const ALL_ENTRIES: Array<[Ecosystem, MirrorSource]> = Object.values(MIRROR_SOURCES)
  .flatMap((m) => m.sources.map((s): [Ecosystem, MirrorSource] => [m.ecosystem, s]));

describe('镜像源清单：URL 合法性', () => {
  it('每个 URL 都是合法 https URL（占位符模板除外）', () => {
    for (const [eco, src] of ALL_ENTRIES) {
      const raw = src.url.startsWith('sparse+') ? src.url.slice('sparse+'.length) : src.url;
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error(`${eco}: 非法 URL ${src.url}`);
      }
      expect(parsed.protocol).toBe('https:');
      expect(parsed.hostname).toContain('.');
    }
  });

  it('sparse+ 前缀只出现在 cargo，且 cargo 首选源带前缀', () => {
    for (const [eco, src] of ALL_ENTRIES) {
      if (eco !== 'cargo') expect(src.url.startsWith('sparse+')).toBe(false);
    }
    // 首选源必须自带前缀：不带就意味着默认换源会退回 git 索引协议去 clone
    // 整个 crates.io 仓库。备选源由 sessionEnvFor 统一补前缀。
    expect(MIRROR_SOURCES.cargo.sources[0].url.startsWith('sparse+')).toBe(true);
  });

  it('无重复 URL', () => {
    const seen = new Map<string, Ecosystem>();
    for (const [eco, src] of ALL_ENTRIES) {
      const key = src.url;
      expect(seen.has(key)).toBe(false);
      seen.set(key, eco);
    }
  });

  it('每个生态都有上游，且上游是合法 https URL', () => {
    for (const eco of ECOSYSTEMS) {
      const m = getMirrors(eco);
      expect(m.upstream).toMatch(/^https:\/\//);
      expect(m.upstream.length).toBeGreaterThan(0);
    }
  });

  it('候选源不得等于上游（换源要换到别处）', () => {
    for (const eco of ECOSYSTEMS) {
      const m = getMirrors(eco);
      for (const s of m.sources) {
        const raw = s.url.startsWith('sparse+') ? s.url.slice(7) : s.url;
        expect(raw.replace(/\/$/, '')).not.toBe(m.upstream.replace(/\/$/, ''));
      }
    }
  });
});

describe('镜像源清单：枚举与信任分层', () => {
  it('ecosystem 是受控枚举', () => {
    for (const eco of ECOSYSTEMS) expect(isEcosystem(eco)).toBe(true);
    for (const bad of ['apt', 'yum', 'nuget', 'brew', 'nix', '', 'NPM']) {
      expect(isEcosystem(bad)).toBe(false);
    }
  });

  it('trust 是受控枚举，且每档都有可读标签', () => {
    const tiers: TrustTier[] = ['t0', 't1', 't2', 't3'];
    for (const [eco, src] of ALL_ENTRIES) {
      expect(tiers).toContain(src.trust);
      expect(TRUST_LABELS[src.trust]).toBeTruthy();
      expect(eco).toBeTruthy();
    }
  });

  it('t2/t3 默认不出现在自动候选里', () => {
    for (const eco of ECOSYSTEMS) {
      const auto = candidatesFor(eco);
      expect(auto.length).toBeGreaterThan(0);
      expect(auto.every((s) => AUTO_TRUST_TIERS.includes(s.trust))).toBe(true);
    }
  });

  it('显式开启 t2/t3 后才出现', () => {
    const hf = candidatesFor('huggingface', { enabledTiers: ['t0', 't1', 't2', 't3'] });
    expect(hf.some((s) => s.trust === 't2')).toBe(true);
    // 默认开启时 hf-mirror（t2）不在列表内。
    expect(candidatesFor('huggingface').some((s) => s.url.includes('hf-mirror'))).toBe(false);
  });

  it('isAutoTrusted 与默认筛选一致', () => {
    for (const [, src] of ALL_ENTRIES) {
      expect(isAutoTrusted(src)).toBe(AUTO_TRUST_TIERS.includes(src.trust));
    }
  });

  it('首选源就是列表第一项（顺序即优先级）', () => {
    for (const eco of ECOSYSTEMS) {
      const first = getMirrors(eco).sources[0];
      expect(defaultSourceFor(eco)?.url).toBe(first.url);
    }
  });
});

describe('镜像源清单：陷阱记录（产品边界固化）', () => {
  it('pip 记录了 extra-index-url 依赖混淆警告与清华 /web 路径陷阱', () => {
    const notes = MIRROR_SOURCES.pip.notes.join(' ');
    expect(notes).toContain('extra-index-url');
    expect(notes).toContain('依赖混淆');
    expect(notes).toContain('/web');
  });

  it('npm 记录了 lockfile 固化 URL 陷阱', () => {
    expect(MIRROR_SOURCES.npm.notes.join(' ')).toContain('lockfile');
  });

  it('cargo 记录了 sparse 索引与整体覆写丢配置的风险', () => {
    const notes = MIRROR_SOURCES.cargo.notes.join(' ');
    expect(notes).toContain('sparse');
    expect(notes).toContain('rustflags');
  });

  it('huggingface 记录了 hf-mirror 不代理 LFS 大文件（302 跳回官方）', () => {
    const notes = MIRROR_SOURCES.huggingface.notes.join(' ');
    expect(notes).toContain('LFS');
    expect(notes).toContain('302');
    // ModelScope 是大文件的唯一可用方案。
    expect(MIRROR_SOURCES.huggingface.sources[0].url).toBe('https://www.modelscope.cn');
  });

  it('github 记录了 jsDelivr 20MB 上限与公益代理已死', () => {
    const notes = MIRROR_SOURCES.github.notes.join(' ');
    expect(notes).toContain('20MB');
    expect(notes).toContain('sha256');
  });

  it('docker 禁止 file 级写入并说明原因', () => {
    expect(fileScopeAllowed('docker')).toBe(false);
    expect(MIRROR_SOURCES.docker.fileScopeBlockedReason).toContain('/etc/docker/daemon.json');
  });

  it('npm/pip/cargo/go/composer/rubygems/huggingface 允许 file 级写入', () => {
    for (const eco of ['npm', 'pip', 'cargo', 'go', 'composer', 'rubygems', 'huggingface'] as Ecosystem[]) {
      expect(fileScopeAllowed(eco)).toBe(true);
    }
  });

  it('github 的官方端点是 t0（零信任成本）', () => {
    const gh = MIRROR_SOURCES.github.sources;
    expect(gh.filter((s) => s.url === 'https://codeload.github.com' || s.url === 'https://raw.githubusercontent.com')
      .every((s) => s.trust === 't0')).toBe(true);
  });
});

describe('镜像源清单：核验日期', () => {
  it('每个生态都带 ISO 核验日期', () => {
    for (const eco of ECOSYSTEMS) {
      expect(getMirrors(eco).verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
describe('测速拼接（CLI 与 GUI 共用的唯一一份）', () => {
  it('清单里每个源都能拼出一个合法的测速 URL', () => {
    // 为什么这条值得写：拼不出合法 URL 就会在测速时静默失败，而测速
    // 失败会让候选回落到首选——用户看不出任何差异。
    for (const [eco, src] of ALL_ENTRIES) {
      if (eco === 'github' && src.url.includes('{')) continue; // jsDelivr 是模板 URL
      const url = benchmarkUrlFor(eco, src.url);
      expect(() => new URL(url)).not.toThrow();
      expect(url.startsWith('http')).toBe(true);
    }
  });

  it('重叠分段合并，不拼出 /npm/npm 这类不存在的地址', () => {
    expect(buildBenchmarkUrl('https://mirrors.cloud.tencent.com/npm/', '/npm')).toBe('https://mirrors.cloud.tencent.com/npm');
    expect(buildBenchmarkUrl('https://mirrors.aliyun.com/pypi/simple', '/simple/pip/')).toBe('https://mirrors.aliyun.com/pypi/simple/pip/');
    expect(buildBenchmarkUrl('https://rsproxy.cn/index/', '/index/config.json')).toBe('https://rsproxy.cn/index/config.json');
    // 无重叠时就是普通拼接。
    expect(buildBenchmarkUrl('https://mirrors.ustc.edu.cn/rubygems/', '/specs.4.8.gz')).toBe('https://mirrors.ustc.edu.cn/rubygems/specs.4.8.gz');
  });

  it('刷掉 sparse+ 前缀与 GOPROXY 的 ,direct 回退链尾', () => {
    expect(buildBenchmarkUrl('sparse+https://rsproxy.cn/index/', '/index/config.json')).toBe('https://rsproxy.cn/index/config.json');
    expect(buildBenchmarkUrl('https://goproxy.cn,direct', '/github.com/pkg/errors/@v/list')).toBe('https://goproxy.cn/github.com/pkg/errors/@v/list');
  });

  it('测速路径表覆盖每个生态', () => {
    for (const eco of ECOSYSTEMS) {
      expect(BENCHMARK_PATHS[eco]).toMatch(/^\//);
    }
  });
});
