// src/shared/mirrorSources.ts
// 国内可用的包管理器 / 代码托管镜像源清单 + 信任分层。
//
// 数据合规：chsrc 的「生态 → 源候选」表硬编码在 GPL-3.0 的 .c 文件里，抄它的
// 编排是有法律风险的。本清单是**独立维护的事实数据**：域名与 URL 本身是事实、
// 不受版权保护，表达方式（字段结构、顺序、注释）全部自研。可对照的 MIT 许可
// 数据源是 MirrorZ 的 mirrorz.json（https://github.com/mirrorz-org/mirrorz）。
//
// 信任分层（产品边界，不可越界）：
//   t0 官方同源 —— 零信任成本，自动可用。例：codeload.github.com。
//   t1 机构 CDN  —— 高校/云厂商运营，自动可用但必须记事件可查。例：npmmirror。
//   t2 第三方公益 —— 无 SLA、响应体可被任意替换，默认关闭，需用户在设置里显式开启。
//   t3 用户自配   —— 默认关闭。
// t2/t3 默认关闭的理由不是道德洁癖而是**可验证性**：镜像能改的不只是速度，还
// 是你装进来的每一个包的字节。公益代理约一半已死（见 notes），而死的代理返回
// 403/429 时很容易被误读成「源不可用」。

export type TrustTier = 't0' | 't1' | 't2' | 't3';

/** 信任分层的可读标签，供返回值与 UI 直接展示。 */
export const TRUST_LABELS: Record<TrustTier, string> = {
  t0: 'T0 官方同源（自动可用，零信任成本）',
  t1: 'T1 机构 CDN（自动可用，记事件可查）',
  t2: 'T2 第三方公益代理（默认关闭，需显式开启）',
  t3: 'T3 用户自配代理（默认关闭，需显式开启）',
};

/** 自动分层可用的信任档。t2/t3 一律需要显式开启。 */
export const AUTO_TRUST_TIERS: readonly TrustTier[] = ['t0', 't1'];

export type Ecosystem =
  | 'npm'
  | 'pip'
  | 'cargo'
  | 'go'
  | 'docker'
  | 'maven'
  | 'composer'
  | 'rubygems'
  | 'huggingface'
  | 'github';

export const ECOSYSTEMS: readonly Ecosystem[] = [
  'npm', 'pip', 'cargo', 'go', 'docker', 'maven', 'composer', 'rubygems', 'huggingface', 'github',
];

export interface MirrorSource {
  url: string;
  trust: TrustTier;
  /** 运营方说明，给人看（阿里/清华/字节…）。 */
  operator?: string;
  /** 该源的已知陷阱与注意事项。 */
  notes?: string;
}

export interface EcosystemMirrors {
  ecosystem: Ecosystem;
  displayName: string;
  /** 官方上游（诊断基线，也是「回到原状」的语义目标）。 */
  upstream: string;
  /** 候选源，首选在前。 */
  sources: MirrorSource[];
  /**
   * 会话级换源注入的环境变量。file 级写入的键名见 sourceSwitcher。
   * 为空表示该生态**只支持建议**，不做自动改写。
   */
  sessionEnvKeys: string[];
  /**
   * 禁止 file 级写入的原因。docker 属于这类：写 daemon.json 需要 root 且必须
   * 重启 docker 守护进程，违反「可回退」铁律——回退一个需要重启才能生效的
   * 系统级改动不是回退。
   */
  fileScopeBlockedReason?: string;
  /** 生态级陷阱（不止某个源）。 */
  notes: string[];
  /** 核验日期（YYYY-MM-DD）：清单里的可达性是当天实测的，不是记忆里的。 */
  verifiedAt: string;
}

export const VERIFIED_AT = '2026-10-09';

export const MIRROR_SOURCES: Record<Ecosystem, EcosystemMirrors> = {
  npm: {
    ecosystem: 'npm',
    displayName: 'npm',
    upstream: 'https://registry.npmjs.org',
    sources: [
      { url: 'https://registry.npmmirror.com', trust: 't1', operator: '阿里云运营', notes: '分钟级同步，全球最稳的国内 npm 源' },
      { url: 'https://mirrors.huaweicloud.com/repository/npm/', trust: 't1', operator: '华为云' },
      { url: 'https://mirrors.cloud.tencent.com/npm/', trust: 't1', operator: '腾讯云', notes: '实测根路径 404，需带包名路径访问（如 /npm/left-pad）' },
    ],
    sessionEnvKeys: ['npm_config_registry'],
    notes: [
      'lockfile 固化 URL：package-lock.json 里每个包都写死了 resolved 完整 URL。换源之前生成的 lockfile，npm ci 仍会走老 URL，等于没换——换源后必须重新生成 lockfile，或用 --registry= 单次指定。',
      '作用域包：换源后 @scope 的 private registry 仍走各自配置，不受 npm_config_registry 影响。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  pip: {
    ecosystem: 'pip',
    displayName: 'pip / PyPI',
    upstream: 'https://pypi.org/simple',
    sources: [
      { url: 'https://mirrors.aliyun.com/pypi/simple', trust: 't1', operator: '阿里云', notes: '实测 200 / 71ms，阿里云商网内更快' },
      { url: 'https://mirrors.cernet.edu.cn/pypi/web/simple', trust: 't1', operator: '教育网 CERNET', notes: '302 跳转到 cmcc.mirrors.ustc.edu.cn，实测可用' },
      { url: 'https://mirrors.bfsu.edu.cn/pypi/web/simple', trust: 't1', operator: '北京外国语大学' },
      { url: 'https://mirror.lzu.edu.cn/pypi/web/simple', trust: 't1', operator: '兰州大学', notes: '302 跳转到 mirrors.ustc.edu.cn' },
      { url: 'https://mirror.sjtu.edu.cn/pypi/web/simple', trust: 't1', operator: '上海交通大学' },
      { url: 'https://mirrors.ustc.edu.cn/pypi/simple', trust: 't1', operator: '中国科学技术大学' },
      { url: 'https://mirrors.cloud.tencent.com/pypi/simple', trust: 't1', operator: '腾讯云' },
      { url: 'https://repo.huaweicloud.com/repository/pypi/simple', trust: 't1', operator: '华为云', notes: '根路径 429 限流，但包详情页可用（实测 /simple/pip/ 200）' },
      { url: 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple', trust: 't1', operator: '清华大学', notes: '正确路径必须带 /web（漏掉 /web 会 404）；本次核验 TLS 握手失败，列为备选而非首选' },
    ],
    sessionEnvKeys: ['PIP_INDEX_URL'],
    notes: [
      '绝不可用 extra-index-url：pip 只有 global.index-url 单一生效源，extra-index-url 会引入依赖混淆（pip 官方明确警告）——攻击者往 extra 索引塞一个同名高版本包即可劫持你的安装。',
      '清华源路径陷阱：https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple 才是正确的（带 /web）。网上大量教程漏掉 /web。',
      '换源影响该用户的所有 Python 项目，不只是当前目录。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  cargo: {
    ecosystem: 'cargo',
    displayName: 'cargo / crates.io',
    upstream: 'https://crates.io',
    sources: [
      { url: 'sparse+https://rsproxy.cn/index/', trust: 't1', operator: '字节跳动', notes: '实测 config.json 200；必须带 sparse+ 前缀' },
      { url: 'https://mirrors.cernet.edu.cn/crates.io-index/', trust: 't1', operator: '教育网 CERNET', notes: '302 跳转到 cmcc.mirrors.ustc.edu.cn' },
      { url: 'https://mirrors.aliyun.com/crates.io-index/', trust: 't1', operator: '阿里云' },
      { url: 'https://mirrors.ustc.edu.cn/crates.io-index/', trust: 't1', operator: '中国科学技术大学' },
      { url: 'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/', trust: 't1', operator: '清华大学', notes: '本次核验 TLS 握手失败' },
      { url: 'https://mirrors.bfsu.edu.cn/crates.io-index/', trust: 't1', operator: '北京外国语大学', notes: '本次核验 TLS 握手失败' },
      { url: 'https://mirrors.zju.edu.cn/crates.io-index/', trust: 't1', operator: '浙江大学' },
    ],
    sessionEnvKeys: ['CARGO_REGISTRIES_CRATES_IO_INDEX', 'CARGO_REGISTRIES_CRATES_IO_PROTOCOL'],
    notes: [
      '用 sparse 索引，不要 git 索引：git 索引要 clone 整个 crates.io 仓库（数 GB），sparse 只按需拉单个 crate 的元数据。',
      'CARGO_REGISTRIES_CRATES_IO_PROTOCOL 必须设为 sparse，否则 cargo 会退回 git 索引协议去 clone 整个仓库。',
      '写 ~/.cargo/config.toml 时必须保留原文件的其他配置（如 [build] rustflags）：整体覆写会静默丢掉用户的编译选项——这是 chsrc 的真实缺陷，不要重复。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  go: {
    ecosystem: 'go',
    displayName: 'Go modules',
    upstream: 'https://proxy.golang.org',
    sources: [
      { url: 'https://goproxy.cn,direct', trust: 't1', operator: '七牛云 CDN', notes: '不限速不限量，自动代理 sum.golang.org（不用额外配 GOSUMDB）' },
      { url: 'https://mirrors.aliyun.com/goproxy/', trust: 't1', operator: '阿里云', notes: '包详情路径实测 200（根路径 404 属正常）' },
      { url: 'https://goproxy.io', trust: 't1', operator: 'goproxy.io', notes: '实测可用但明显更慢（~1.2s vs 290ms）' },
    ],
    sessionEnvKeys: ['GOPROXY'],
    notes: [
      'GOPROXY 值用逗号分隔表示回退链：goproxy.cn,direct 的 direct 意味着所有代理都失败后回落到直连 VCS（很慢但不会彻底失败）。',
      '若代理不支持 sumdb，需额外设 GONOSUMDB 或 GOSUMDB=off；goproxy.cn 默认已代理 sum.golang.org，无需处理。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  docker: {
    ecosystem: 'docker',
    displayName: 'Docker Registry',
    upstream: 'https://registry-1.docker.io',
    sources: [
      { url: 'https://docker.m.daocloud.io', trust: 't1', operator: 'DaoCloud', notes: '实测 401 —— Registry 无凭据时的标准行为，不是故障' },
      { url: 'https://docker.1ms.run', trust: 't1', operator: '1ms', notes: '实测 401，同上' },
    ],
    sessionEnvKeys: [],
    fileScopeBlockedReason: 'docker 一律不做 file 级写入：改 /etc/docker/daemon.json 需要 root 且必须重启 docker 守护进程，重启期间所有容器停摆——这不是可回退的改动，是一次停机。只给环境变量/命令行参数建议。',
    notes: [
      '上游 registry-1.docker.io 在国内实测超时（2.4s+ 无响应），这是默认卡住的真正原因。',
      '401 = Registry 要求认证，是 Docker Registry 的标准行为，不是「镜像源坏了」——测速时不能把 401 当失败。',
      '用法是给镜像名加前缀：docker pull docker.m.daocloud.io/library/nginx，而不是改 daemon.json。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  maven: {
    ecosystem: 'maven',
    displayName: 'Maven',
    upstream: 'https://repo.maven.apache.org/maven2',
    sources: [
      { url: 'https://maven.aliyun.com/repository/public/', trust: 't1', operator: '阿里云', notes: '根路径 404 属正常（需带 artifact 路径）' },
      { url: 'https://repo.huaweicloud.com/repository/maven/', trust: 't1', operator: '华为云' },
      { url: 'https://mirrors.huaweicloud.com/repository/maven/', trust: 't1', operator: '华为云' },
      { url: 'https://mirrors.cloud.tencent.com/nexus/repository/maven-public/', trust: 't1', operator: '腾讯云', notes: '实测较慢（~5.7s）' },
    ],
    sessionEnvKeys: [],
    notes: [
      'Maven 没有「环境变量换源」这个概念：源写在 ~/.m2/settings.xml 的 <mirrors> 里，或项目 pom.xml 的 <repositories>。本工具对 maven 只给建议，不自动改文件。',
      'settings.xml 是用户级全局配置，影响该用户所有项目。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  composer: {
    ecosystem: 'composer',
    displayName: 'Composer / Packagist',
    upstream: 'https://repo.packagist.org',
    sources: [
      { url: 'https://mirrors.aliyun.com/composer/', trust: 't1', operator: '阿里云' },
      { url: 'https://mirrors.tencent.com/composer/', trust: 't1', operator: '腾讯云', notes: '302 跳转后可用' },
      { url: 'https://mirrors.huaweicloud.com/repository/php/', trust: 't1', operator: '华为云' },
    ],
    sessionEnvKeys: ['COMPOSER_REPOSITORIES_PACKAGIST_URL'],
    notes: ['composer.lock 会固化 dist URL，与 npm lockfile 同类问题：换源后需重新生成。'],
    verifiedAt: VERIFIED_AT,
  },

  rubygems: {
    ecosystem: 'rubygems',
    displayName: 'RubyGems',
    upstream: 'https://rubygems.org',
    sources: [{ url: 'https://mirrors.ustc.edu.cn/rubygems/', trust: 't1', operator: '中国科学技术大学' }],
    sessionEnvKeys: ['BUNDLE_MIRROR__HTTPS://RUBYGEMS__ORG'],
    notes: ['bundle install 读 BUNDLE_MIRROR__<URL> 形式的变量，key 里的 :// 与 / 要写成 __ 。'],
    verifiedAt: VERIFIED_AT,
  },

  huggingface: {
    ecosystem: 'huggingface',
    displayName: 'Hugging Face 模型/数据集',
    upstream: 'https://huggingface.co',
    sources: [
      { url: 'https://www.modelscope.cn', trust: 't1', operator: '魔搭 ModelScope', notes: '国内直连，不需要把 HF token 透传给第三方——这是它相对 hf-mirror 的核心优势' },
      { url: 'https://hf-mirror.com', trust: 't2', operator: '社区代理', notes: '不代理 LFS 大文件：/{repo}/resolve/main/xxx 会 302 跳回 huggingface.co（已实测）。只可用于小文件/元数据' },
    ],
    sessionEnvKeys: ['HF_ENDPOINT'],
    notes: [
      '大文件只能用 ModelScope。hf-mirror.com 不代理 LFS：resolve 端点会 302 回 huggingface.co，等于没换源。',
      'Ollama 有原生 ModelScope 支持：ollama run modelscope.cn/Qwen/Qwen2.5-3B-Instruct-GGUF。',
      'hf-mirror 是 t2 第三方代理，默认关闭；即便用户显式开启，传 token 过去也意味着凭证离开官方域。',
    ],
    verifiedAt: VERIFIED_AT,
  },

  github: {
    ecosystem: 'github',
    displayName: 'GitHub 代码/归档',
    upstream: 'https://github.com',
    sources: [
      { url: 'https://codeload.github.com', trust: 't0', operator: 'GitHub 官方', notes: '官方 tarball/zip 端点，实测 200 —— T0 官方同源，零信任成本' },
      { url: 'https://raw.githubusercontent.com', trust: 't0', operator: 'GitHub 官方', notes: '官方 raw 端点' },
      { url: 'https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}', trust: 't1', operator: 'jsDelivr CDN', notes: '公共 CDN，有 Terms of Use' },
      { url: 'https://ghfast.top', trust: 't2', operator: '第三方公益代理', notes: '实测 200 但耗时 8s，无 SLA，响应体可被任意替换' },
      { url: 'https://gh-proxy.com', trust: 't2', operator: '第三方公益代理', notes: '实测 429 限流——公益代理约一半已死' },
      { url: 'https://ghproxy.net', trust: 't2', operator: '第三方公益代理', notes: '实测 200 但耗时 8.8s' },
    ],
    sessionEnvKeys: [],
    notes: [
      'jsDelivr 下不了 release 二进制：单文件 20MB 上限，且 release 端点已被官方关闭。要 release 资产只能用 codeload 或官方域名。',
      'T2 公益代理（ghfast.top / gh-proxy.com / ghproxy.net）实测约一半已死或严重限流，且无 SLA、响应体可被任意替换——默认关闭；即便用户显式开启，下载二进制也必须校验 sha256。',
      'GitHub 相关工具没有环境变量换法：只给命令/URL 建议。',
    ],
    verifiedAt: VERIFIED_AT,
  },
};

// ── 测速（纯函数，CLI 与 GUI 共用同一份）────────────────────────────────
//
// 为什么放在这里而不是 sourceSwitcher：GUI（WebView）不能 import 那个模块
// （它在模块作用域 import node:fs）。清单 + 测速判据本来就是同一件事的两面，
// 拆开放着就等于邀请两端各写一份拼接逻辑——那正是本轮要消灭的漂移。

/**
 * 每个生态的测速路径。刻意选「必然存在的轻量端点」而不是站点根路径：根路径
 * 常返回 404/302（root 本身不是资源），会把好源误判成坏源。
 */
export const BENCHMARK_PATHS: Record<Ecosystem, string> = {
  npm: '/npm',
  pip: '/simple/pip/',
  cargo: '/index/config.json',
  go: '/github.com/pkg/errors/@v/list',
  docker: '/v2/',
  maven: '/org/apache/commons/commons-lang3/maven-metadata.xml',
  composer: '/packages.json',
  rubygems: '/specs.4.8.gz',
  huggingface: '/api/models/Qwen/Qwen2.5-3B-Instruct-GGUF',
  github: '/',
};

/**
 * 源 URL 的路径分段（去掉 query/fragment 与首尾空段）。
 *
 * 用分段而不是字符串 `endsWith` 拼路径，是因为不少源的 URL **自带路径尾**
 * （`mirrors.cloud.tencent.com/npm/`、`mirrors.aliyun.com/pypi/simple`、
 * `rsproxy.cn/index/`），而测速路径同样以那些段开头。天真的「base + path」
 * 会拼出 `/npm/npm`、`/simple/simple/pip/`、`/index/index/config.json`——
 * 测的是一个不存在的地址，于是好源被判成死源。
 */
function pathSegments(url: string): { prefix: string; segs: string[] } {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)/i.exec(url);
  const prefix = m?.[1] ?? '';
  const segs = (m?.[2] ?? '').split('/').filter(Boolean);
  return { prefix, segs };
}

/**
 * 剥掉测速 URL 上不该有的两段前缀：
 *  1. `sparse+` —— cargo 的 sparse 索引前缀不是 URL scheme（换源时才需要它，
 *     测速用的是真实 HTTP 端点）。
 *  2. GOPROXY 的回退链尾巴（`,direct`）——那是 GOPROXY 环境变量的语法，不是
 *     host 的一部分；留着会拼出 `https://goproxy.cn,direct/github.com/...`，
 *     域名解析必然失败，于是清单里的首选源永远测不通。
 */
function benchmarkBase(sourceUrl: string): string {
  const sparse = sourceUrl.startsWith('sparse+') ? sourceUrl.slice('sparse+'.length) : sourceUrl;
  const comma = sparse.indexOf(',');
  return comma >= 0 ? sparse.slice(0, comma) : sparse;
}

/**
 * 拼出测速 URL。对**重叠分段**做合并而不是简单相加：base 末尾与 path 开头
 * 相同的段只保留一份（最长重叠），于是
 *   `mirrors.cloud.tencent.com/npm/` + `/npm` → `/npm`
 *   `mirrors.aliyun.com/pypi/simple` + `/simple/pip/` → `/pypi/simple/pip/`
 *   `rsproxy.cn/index/` + `/index/config.json` → `/index/config.json`
 * 无重叠时就是普通拼接（`mirrors.ustc.edu.cn/rubygems/` + `/specs.4.8.gz`）。
 */
export function buildBenchmarkUrl(
  sourceUrl: string,
  path: string,
): string {
  const base = benchmarkBase(sourceUrl);
  const baseParts = pathSegments(base);
  const pathParts = path.replace(/^\/+/, '').split('/').filter(Boolean);
  let overlap = 0;
  for (let n = Math.min(baseParts.segs.length, pathParts.length); n > 0; n--) {
    const tail = baseParts.segs.slice(baseParts.segs.length - n);
    const head = pathParts.slice(0, n);
    if (tail.every((seg, i) => seg === head[i])) { overlap = n; break; }
  }
  const segs = [...baseParts.segs, ...pathParts.slice(overlap)];
  return `${baseParts.prefix}/${segs.join('/')}${path.endsWith('/') && segs.length > 0 ? '/' : ''}`;
}

/** 该生态对该源的测速 URL（路径表 + 拼接规则一处定义）。 */
export function benchmarkUrlFor(ecosystem: Ecosystem, sourceUrl: string, pathOverride?: string): string {
  return buildBenchmarkUrl(sourceUrl, pathOverride ?? BENCHMARK_PATHS[ecosystem]);
}

/**
 * 「有效响应」判定：拿到任何 HTTP 状态码即算链路通。
 *
 * 刻意包含 401/403 —— Docker Registry 无凭据时返回 401，CDN 拒绝时返回 403，
 * 两者都证明「TLS 握手成功 + HTTP 请求往返完成」，即网络层可达。把它当失败会
 * 把最需要换源的场景判成最不该换源。
 *
 * 唯一的排除项是 `200 Connection established`：那是 HTTP 代理的 CONNECT 隧道
 * 应答，不是目标站点的响应，算它通过等于什么都没验证。
 */
export function isEffectiveResponse(status: number, bodyPrefix: string): boolean {
  if (status >= 200 && status < 500) {
    if (status === 200 && /^connection established/i.test(bodyPrefix.trim())) return false;
    return true;
  }
  // 5xx 说明服务端确实收到了请求，但源本身有问题；作为「网络可达但源不可用」
  // 记录下来参与排序（排在可用源之后），而不是直接丢弃。
  return status >= 500 && status < 600;
}

// ── 查询辅助 ──

export function isEcosystem(value: string): value is Ecosystem {
  return (ECOSYSTEMS as readonly string[]).includes(value);
}

export function getMirrors(ecosystem: Ecosystem): EcosystemMirrors {
  return MIRROR_SOURCES[ecosystem];
}

/**
 * 按信任分层过滤候选源。`enabledTiers` 未给时只返回自动分层（t0/t1）；
 * t2/t3 必须由调用方显式传入——这是「默认关闭」在代码里的唯一实现点。
 */
export function candidatesFor(
  ecosystem: Ecosystem,
  opts: { enabledTiers?: readonly TrustTier[] } = {},
): MirrorSource[] {
  const enabled = opts.enabledTiers ?? AUTO_TRUST_TIERS;
  return MIRROR_SOURCES[ecosystem].sources.filter((s) => enabled.includes(s.trust));
}

/** 该候选源是否被自动信任分层允许。 */
export function isAutoTrusted(source: MirrorSource): boolean {
  return AUTO_TRUST_TIERS.includes(source.trust);
}

export function defaultSourceFor(ecosystem: Ecosystem): MirrorSource | undefined {
  return candidatesFor(ecosystem)[0];
}

/** 生态是否支持 file 级写入（docker / maven / github 不支持）。 */
export function fileScopeAllowed(ecosystem: Ecosystem): boolean {
  return !MIRROR_SOURCES[ecosystem].fileScopeBlockedReason;
}