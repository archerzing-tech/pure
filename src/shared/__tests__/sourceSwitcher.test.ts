// src/shared/__tests__/sourceSwitcher.test.ts
// 换源逻辑：选源 / 并发测速 / 会话级环境变量 / file 级 journal 与回滚。
// 文件读写与 fetch 全部打桩，不碰真实网络与真实 HOME。

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BENCHMARK_TIMEOUT_MS,
  benchmarkSources,
  buildCargoConfig,
  commandAdviceFor,
  fileTargetFor,
  isEffectiveResponse,
  journalPath,
  pickBest,
  readConfigValue,
  readJournal,
  sessionEnvFor,
  switchPackageSource,
  type JournalEntry,
} from '../node/sourceSwitcher';
import { ECOSYSTEMS, candidatesFor, type Ecosystem } from '../mirrorSources';

const stubFetch = (
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch => (async (input: any, init?: RequestInit) => handler(String(input), init ?? {})) as unknown as typeof fetch;

const ok200 = () => new Response('ok', { status: 200 });
const unauthorized = () => new Response('', { status: 401 });
const notFound = () => new Response('', { status: 404 });
const alwaysFail = () => { throw new Error('connect ETIMEDOUT'); };

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'pure-src-switch-'));
}

describe('会话级环境变量映射', () => {
  it('npm → npm_config_registry', () => {
    expect(sessionEnvFor('npm', 'https://registry.npmmirror.com')).toEqual({
      npm_config_registry: 'https://registry.npmmirror.com',
    });
  });

  it('pip → PIP_INDEX_URL，且绝不出现 extra-index-url', () => {
    const env = sessionEnvFor('pip', 'https://mirrors.aliyun.com/pypi/simple');
    expect(env).toEqual({ PIP_INDEX_URL: 'https://mirrors.aliyun.com/pypi/simple' });
    expect(Object.keys(env).some((k) => k.includes('extra'))).toBe(false);
  });

  it('cargo → INDEX + PROTOCOL=sparse，缺前缀时补 sparse+', () => {
    expect(sessionEnvFor('cargo', 'sparse+https://rsproxy.cn/index/')).toEqual({
      CARGO_REGISTRIES_CRATES_IO_INDEX: 'sparse+https://rsproxy.cn/index/',
      CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse',
    });
    const bare = sessionEnvFor('cargo', 'https://mirrors.ustc.edu.cn/crates.io-index/');
    expect(bare.CARGO_REGISTRIES_CRATES_IO_INDEX).toBe('sparse+https://mirrors.ustc.edu.cn/crates.io-index/');
    expect(bare.CARGO_REGISTRIES_CRATES_IO_PROTOCOL).toBe('sparse');
  });

  it('go → GOPROXY 且补 ,direct 回退', () => {
    expect(sessionEnvFor('go', 'https://goproxy.cn').GOPROXY).toBe('https://goproxy.cn,direct');
    // 已含逗号的回退链不重复追加。
    expect(sessionEnvFor('go', 'https://goproxy.cn,direct').GOPROXY).toBe('https://goproxy.cn,direct');
  });

  it('docker / maven / github 没有环境变量换法，返回空映射而非假映射', () => {
    for (const eco of ['docker', 'maven', 'github'] as Ecosystem[]) {
      expect(sessionEnvFor(eco, 'https://example.com')).toEqual({});
    }
    // 但必须给出可执行建议，不能只是「不支持」。
    expect(commandAdviceFor('docker', 'https://docker.m.daocloud.io')[0]).toContain('docker pull');
    expect(commandAdviceFor('maven', 'https://maven.aliyun.com/repository/public/').join()).toContain('settings.xml');
  });

  it('rubygems 的 bundle 变量名按 URL 编码规则转换', () => {
    expect(sessionEnvFor('rubygems', 'https://mirrors.ustc.edu.cn/rubygems/')).toEqual({
      'BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG': 'https://mirrors.ustc.edu.cn/rubygems/',
    });
  });
});

describe('测速判据', () => {
  it('401/403/404 都算有效响应（证明链路通），只有 CONNECT 隧道不算', () => {
    expect(isEffectiveResponse(200, '<html>')).toBe(true);
    expect(isEffectiveResponse(401, '')).toBe(true);
    expect(isEffectiveResponse(403, '')).toBe(true);
    expect(isEffectiveResponse(404, '')).toBe(true);
    expect(isEffectiveResponse(500, '')).toBe(true);
    // CONNECT 隧道应答：200 但不是目标站点的响应。
    expect(isEffectiveResponse(200, 'Connection established')).toBe(false);
  });

  it('并发探测：所有候选都在同一个 8s 预算内跑完', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = stubFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok200();
    });
    const results = await benchmarkSources('npm', candidatesFor('npm'), { fetchImpl });
    expect(results.length).toBe(candidatesFor('npm').length);
    expect(peak).toBeGreaterThan(1);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(BENCHMARK_TIMEOUT_MS).toBe(8000);
  });

  it('t2 候选即使进入测速列表也会被跳过，并说明原因', async () => {
    const fetchImpl = stubFetch(() => ok200());
    // 直接传含 t2 的完整清单：默认分层下 hf-mirror（t2）必须被跳过而不是被测速，
    // 「默认关闭」是这里唯一的行为闸门。
    const all = [...candidatesFor('huggingface'), ...candidatesFor('huggingface', { enabledTiers: ['t2'] })];
    const results = await benchmarkSources('huggingface', all, { fetchImpl });
    const t2 = results.find((r) => r.url.includes('hf-mirror'));
    expect(t2?.skipped).toContain('默认关闭');
    expect(t2?.ok).toBe(false);
    // 默认候选（ModelScope）仍应被正常测速。
    expect(results.find((r) => r.url.includes('modelscope'))?.ok).toBe(true);
  });

  it('docker 的 401 不算失败（Registry 无凭据是标准行为）', async () => {
    const fetchImpl = stubFetch(() => unauthorized());
    const results = await benchmarkSources('docker', candidatesFor('docker'), { fetchImpl });
    expect(results.every((r) => r.ok && r.status === 401)).toBe(true);
  });

  it('测速 URL 合并重叠分段，不再拼出 /npm/npm', async () => {
    // 旧行为是无条件 base + path：自带路径尾的源（mirrors.cloud.tencent.com/npm/、
    // aliyun /pypi/simple、rsproxy /index/）会被拼成一个不存在的地址，于是好源被判成死源。
    const seen: string[] = [];
    const fetchImpl = stubFetch((url) => {
      seen.push(url);
      return ok200();
    });
    await benchmarkSources('npm', candidatesFor('npm'), { fetchImpl });
    expect(seen).toContain('https://mirrors.cloud.tencent.com/npm');
    expect(seen.some((u) => u.includes('/npm/npm'))).toBe(false);

    const pipSeen: string[] = [];
    await benchmarkSources('pip', candidatesFor('pip'), {
      fetchImpl: stubFetch((url) => { pipSeen.push(url); return ok200(); }),
    });
    expect(pipSeen).toContain('https://mirrors.aliyun.com/pypi/simple/pip/');

    const cargoSeen: string[] = [];
    await benchmarkSources('cargo', candidatesFor('cargo'), {
      fetchImpl: stubFetch((url) => { cargoSeen.push(url); return ok200(); }),
    });
    // sparse+ 前缀与 `,direct` 回退链尾都不是 URL 的一部分。
    expect(cargoSeen).toContain('https://rsproxy.cn/index/config.json');

    const goSeen: string[] = [];
    await benchmarkSources('go', candidatesFor('go'), {
      fetchImpl: stubFetch((url) => { goSeen.push(url); return ok200(); }),
    });
    expect(goSeen).toContain('https://goproxy.cn/github.com/pkg/errors/@v/list');
    expect(goSeen.some((u) => u.includes(','))).toBe(false);
  });

  it('选优：有效响应优先，其次延迟', () => {
    const best = pickBest(
      [
        { url: 'a', trust: 't1', ok: false, ms: 10 },
        { url: 'b', trust: 't1', ok: true, ms: 300 },
        { url: 'c', trust: 't1', ok: true, ms: 120 },
      ],
      [],
    );
    expect(best?.url).toBe('c');
    // 全挂时退回第一项，让上层如实报告失败而不是静默返回 undefined。
    expect(pickBest([{ url: 'a', trust: 't1', ok: false, ms: 10 }], [])?.url).toBe('a');
  });
});

describe('switchPackageSource：默认档 = 会话级 + dry-run', () => {
  it('默认不写文件、不 spawn 命令，只给环境变量映射', async () => {
    const home = makeHome();
    try {
      const writes: string[] = [];
      const r = await switchPackageSource(
        { ecosystem: 'npm', source: 'https://registry.npmmirror.com' },
        {
          homeDir: home,
          writeFile: (p) => { writes.push(p); },
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(true);
      expect(r.scope).toBe('session');
      expect(r.dryRun).toBe(true);
      expect(r.sessionEnv).toEqual({ npm_config_registry: 'https://registry.npmmirror.com' });
      expect(writes).toHaveLength(0);
      expect(r.files).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('返回值里明确写出 npm lockfile 陷阱', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'npm', source: 'https://registry.npmmirror.com' },
        { homeDir: home, fetchImpl: stubFetch(() => ok200()) },
      );
      const all = [...r.warnings, r.summary ?? ''].join('\n');
      expect(all).toContain('lockfile');
      expect(all).toContain('--registry=');
      expect(commandAdviceFor('npm', 'https://registry.npmmirror.com').join()).toContain('--registry=');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('docker 会话级给镜像名前缀建议，并说明为何不做 file 级写入', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'docker', source: 'https://docker.m.daocloud.io' },
        { homeDir: home, fetchImpl: stubFetch(() => unauthorized()) },
      );
      expect(r.ok).toBe(true);
      expect(r.sessionEnv).toEqual({});
      const all = [...r.warnings, r.summary ?? ''].join('\n');
      expect(all).toContain('/etc/docker/daemon.json');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('docker 拒绝 file 级写入', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'docker', scope: 'file', dryRun: false, confirm: true },
        { homeDir: home, fetchImpl: stubFetch(() => unauthorized()) },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('/etc/docker/daemon.json');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('auto 模式并发测速：只有拿到有效响应的候选参与选优', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'npm', source: 'auto' },
        {
          homeDir: home,
          // 腾讯源根路径实测 404（根不是资源），华为源可用 —— 只有拿到有效
          // 响应的候选才该胜出，这正是与 chsrc「不看状态码」的关键差别。
          fetchImpl: stubFetch((url) => (url.includes('npmmirror') ? ok200() : url.includes('huaweicloud') ? ok200() : notFound())),
        },
      );
      expect(r.ok).toBe(true);
      expect(['https://registry.npmmirror.com', 'https://mirrors.huaweicloud.com/repository/npm/']).toContain(String(r.source?.url));
      expect(r.benchmark?.length).toBeGreaterThan(0);
      expect(r.benchmark?.every((b) => b.ok)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('所有候选都测不通时如实回落并在 warnings 里说明', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'npm', source: 'auto' },
        { homeDir: home, fetchImpl: stubFetch(() => alwaysFail()) },
      );
      expect(r.ok).toBe(true);
      expect(r.source?.url).toBe('https://registry.npmmirror.com');
      expect(r.warnings.join()).toContain('回落');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('未知生态与非法 URL 直接拒绝', async () => {
    const home = makeHome();
    try {
      const bad = await switchPackageSource({ ecosystem: 'apt' }, { homeDir: home, fetchImpl: stubFetch(() => ok200()) });
      expect(bad.ok).toBe(false);
      expect(bad.error).toContain('未知生态');
      const badUrl = await switchPackageSource({ ecosystem: 'npm', source: 'not a url' }, { homeDir: home, fetchImpl: stubFetch(() => ok200()) });
      expect(badUrl.ok).toBe(false);
      expect(badUrl.error).toContain('合法 URL');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('手工指定的清单外 URL 按 t3 处理并警告', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'npm', source: 'https://mirror.example.com/npm' },
        { homeDir: home, fetchImpl: stubFetch(() => ok200()) },
      );
      expect(r.ok).toBe(true);
      expect(r.source?.trust).toBe('t3');
      expect(r.warnings.join()).toContain('不在受信任清单内');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('t2 源未显式开启时拒绝', async () => {
    const home = makeHome();
    try {
      const r = await switchPackageSource(
        { ecosystem: 'huggingface', source: 'https://hf-mirror.com' },
        { homeDir: home, fetchImpl: stubFetch(() => ok200()) },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('默认关闭');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('switchPackageSource：file 级写入与 journal', () => {
  it('未确认时拒绝，且不写任何东西', async () => {
    const home = makeHome();
    try {
      const writes: string[] = [];
      const r = await switchPackageSource(
        { ecosystem: 'npm', scope: 'file', dryRun: false, source: 'https://registry.npmmirror.com' },
        { homeDir: home, writeFile: (p) => { writes.push(p); }, fetchImpl: stubFetch(() => ok200()) },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('confirm');
      expect(writes).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('读旧值 → 记 journal → 才写；回滚语义是删键而非写回上游', async () => {
    const home = makeHome();
    try {
      const target = fileTargetFor('npm', 'https://registry.npmmirror.com', home);
      const entries: JournalEntry[] = [];
      const written: Array<[string, string]> = [];
      const r = await switchPackageSource(
        { ecosystem: 'npm', scope: 'file', dryRun: false, confirm: true, source: 'https://registry.npmmirror.com' },
        {
          homeDir: home,
          readFile: () => 'registry=https://registry.npmjs.org\n@scope:registry=https://npm.example.com\n',
          writeFile: (p, c) => { written.push([p, c]); },
          journal: (e) => { entries.push(e); return { ok: true, path: '/tmp/j.jsonl' }; },
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(true);
      expect(r.reversible).toBe(true);
      expect(r.files?.[0].previousContent).toContain('@scope:registry');
      // journal 先于写入：entries 在 written 之前 push，顺序即断言。
      expect(entries).toHaveLength(1);
      expect(entries[0].previousValue).toBe('https://registry.npmjs.org');
      expect(entries[0].undo).toEqual({ kind: 'delete-key', key: 'registry' });
      expect(entries[0].undoCommand).toContain('sed');
      // 写入保留原有其他行（作用域 registry 不该被抹掉）。
      expect(written[0][1]).toContain('@scope:registry');
      expect(written[0][1]).toContain('registry=https://registry.npmmirror.com');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('文件此前不存在 → 回滚语义是删文件', async () => {
    const home = makeHome();
    try {
      const entries: JournalEntry[] = [];
      const r = await switchPackageSource(
        { ecosystem: 'pip', scope: 'file', dryRun: false, confirm: true, source: 'https://mirrors.aliyun.com/pypi/simple' },
        {
          homeDir: home,
          readFile: () => null,
          writeFile: () => {},
          journal: (e) => { entries.push(e); return { ok: true, path: '/tmp/j.jsonl' }; },
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(true);
      expect(entries[0].fileExisted).toBe(false);
      expect(entries[0].undo).toEqual({ kind: 'delete-file' });
      expect(entries[0].previousValue).toBeNull();
      expect(entries[0].undoCommand).toContain('rm ');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('journal 写不进去时放弃写入（没有回滚依据就不许改配置）', async () => {
    const home = makeHome();
    try {
      const writes: string[] = [];
      const r = await switchPackageSource(
        { ecosystem: 'npm', scope: 'file', dryRun: false, confirm: true, source: 'https://registry.npmmirror.com' },
        {
          homeDir: home,
          readFile: () => null,
          writeFile: (p) => { writes.push(p); },
          journal: () => ({ ok: false, path: '/tmp/j.jsonl', error: 'disk full' }),
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain('journal');
      expect(writes).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('dry_run 的 file 级也返回旧值与回滚命令，但不写盘', async () => {
    const home = makeHome();
    try {
      const writes: string[] = [];
      const r = await switchPackageSource(
        { ecosystem: 'npm', scope: 'file', dryRun: true, confirm: true, source: 'https://registry.npmmirror.com' },
        {
          homeDir: home,
          readFile: () => 'registry=https://registry.npmjs.org\n',
          writeFile: (p) => { writes.push(p); },
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(true);
      expect(r.dryRun).toBe(true);
      expect(r.files?.[0].previousValue).toBe('https://registry.npmjs.org');
      expect(r.files?.[0].previousContent).toContain('registry.npmjs.org');
      expect(r.undoCommand).toContain('sed');
      expect(writes).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('cargo config.toml 改写：必须保留原文件其他配置', () => {
  it('不丢 [build] rustflags（chsrc 的真实缺陷，不能重复）', () => {
    const existing = [
      '[build]',
      'rustflags = ["-C", "target-cpu=native"]',
      '',
      '[source.crates-io]',
      'replace-with = "mirror"',
      '',
      '[source.mirror]',
      'registry = "sparse+https://old.example.com/index/"',
    ].join('\n');
    const out = buildCargoConfig(existing, 'sparse+https://rsproxy.cn/index/');
    expect(out.next).toContain('-C", "target-cpu=native');
    expect(out.next).toContain('registry = "sparse+https://rsproxy.cn/index/"');
    expect(out.next).not.toContain('old.example.com');
    expect(out.changed).toBe(true);
  });

  it('空文件也能正确生成', () => {
    const out = buildCargoConfig('', 'https://mirrors.ustc.edu.cn/crates.io-index/');
    expect(out.next).toContain('[source.crates-io]');
    expect(out.next).toContain('replace-with = "mirror"');
    // 缺前缀时补上，否则 cargo 会退回 git 索引。
    expect(out.next).toContain('sparse+https://mirrors.ustc.edu.cn/crates.io-index/');
  });

  it('cargo 的 file 级写入保留其余段', async () => {
    const home = makeHome();
    try {
      const existing = '[build]\nrustflags = ["-C","link-arg=-s"]\n';
      let written = '';
      const r = await switchPackageSource(
        { ecosystem: 'cargo', scope: 'file', dryRun: false, confirm: true, source: 'sparse+https://rsproxy.cn/index/' },
        {
          homeDir: home,
          readFile: () => existing,
          writeFile: (_p, c) => { written = c; },
          journal: () => ({ ok: true, path: '/tmp/j.jsonl' }),
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(true);
      expect(written).toContain('rustflags');
      expect(written).toContain('rsproxy.cn');
      expect(r.warnings.join()).toContain('rustflags');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('journal 文件格式', () => {
  it('落在 ~/.pure/source-switch-journal.jsonl，且坏行不拖垮回放', async () => {
    const home = makeHome();
    try {
      expect(journalPath(home)).toBe(join(home, '.pure', 'source-switch-journal.jsonl'));
      const r = await switchPackageSource(
        { ecosystem: 'npm', scope: 'file', dryRun: false, confirm: true, source: 'https://registry.npmmirror.com' },
        {
          homeDir: home,
          readFile: () => 'registry=https://registry.npmjs.org\n',
          writeFile: () => {},
          fetchImpl: stubFetch(() => ok200()),
        },
      );
      expect(r.ok).toBe(true);
      const raw = readFileSync(journalPath(home), 'utf8');
      // JSONL：一行一个事件。
      const lines = raw.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      const entries = readJournal(home);
      expect(entries).toHaveLength(lines.length);
      expect(entries[0].kind).toBe('source_switch');
      expect(entries[0].dryRun).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('坏行留档不读', () => {
    const home = makeHome();
    try {
      const r = readJournal(home);
      expect(Array.isArray(r)).toBe(true);
      expect(r).toHaveLength(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('配置键读取', () => {
  it('跳过注释与空行，找不到返回 null', () => {
    const content = '# comment\n; other\n\nregistry = https://x\nfoo=bar\n';
    expect(readConfigValue(content, 'registry')).toBe('https://x');
    expect(readConfigValue(content, 'foo')).toBe('bar');
    expect(readConfigValue(content, 'missing')).toBeNull();
  });
});

describe('生态全覆盖冒烟：每个生态的 file 目标都可解析', () => {
  it('允许 file 写入的生态都有确定的目标路径', () => {
    for (const eco of ECOSYSTEMS) {
      if (eco === 'docker' || eco === 'maven' || eco === 'github') {
        expect(() => fileTargetFor(eco, 'https://x.example.com/', '/home/u')).toThrow();
        continue;
      }
      const t = fileTargetFor(eco, 'https://x.example.com/', '/home/u');
      expect(t.path.startsWith('/home/u')).toBe(true);
      expect(t.key.length).toBeGreaterThan(0);
    }
  });
});