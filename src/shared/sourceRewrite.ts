// src/shared/sourceRewrite.ts
// S2 单请求 URL 改写层：把**一次**请求的 URL 换到一个可达镜像上，无痕、可自回退
// ——进程退出即消失，不落盘、不 spawn、不改任何配置。
//
// 为什么要有这一层：F4 之前，诊断出「被墙 / SYN 被丢」之后能给的只有「去配代理」
// 或「换源」（file/session 级）。但大量失败其实发生在**单个 URL** 上，而那个
// URL 往往有一个字节一致的官方/机构镜像端点：GitHub 归档在 codeload、npm 包在
// npmmirror、PyPI 文件在阿里云、Go module 在 goproxy.cn。把请求改写到这些端点，
// 是成本最低的开路手段——不需要信任一个第三方代理，也不需要动用户环境。
//
// 信任边界（与 mirrorSources 同一套政策）：**只产出 t0/t1 的改写**。t0（官方
// 同源，如 codeload）零信任成本；t1（机构 CDN）自动可用。t2（第三方公益代理）
// 一律不在这里出现——它默认关闭、约一半已死、响应体可被任意替换，不该由一次
// 静默改写把用户带过去。开启 t2 也不改变这个结果（本模块没有 t2 规则）。
//
// 只做「字节一致」的改写：每条规则的镜像端点与源端点在内容上必须等价，否则
// 「开路」就变成了「悄悄换了你的输入」。因此只收录：
//   - GitHub archive → codeload（官方同源，字节一致）
//   - npm tarball   → npmmirror（镜像同步，字节一致）
//   - PyPI 文件     → 阿里云 /pypi（镜像同步，字节一致）
//   - Go module     → goproxy.cn（转发，字节一致）
//   - raw 文件      → jsDelivr gh（CDN 回源，字节一致；有 20MB 上限）
//   - HF 模型文件   → ModelScope（LFS 镜像，字节一致；未镜像的仓库会 404）
// 刻意不收录的：GitHub release 二进制（jsDelivr 官方关闭了 release 端点，唯一的
// 出路是 t2 公益代理，越界）。

import { AUTO_TRUST_TIERS, type TrustTier } from './mirrorSources';

export interface RewriteCandidate {
  /** 改写后的完整 URL。 */
  url: string;
  /** 目标源的信任分层（本模块只产出 t0/t1）。 */
  trust: TrustTier;
  /** 运营方，给人看。 */
  operator: string;
  /** 规则标识（日志/去重/测试锚点用）。 */
  rule: string;
  /** 一句话：为什么这条改写存在，以及它的边界。 */
  why: string;
}

export interface RewriteOptions {
  /** 允许的信任分层；缺省 = 自动分层（t0/t1）。t2 不产出任何规则。 */
  enabledTiers?: readonly TrustTier[];
}

const NPM_TARBALL_RE = /^\/[^/]+\/-\/[^/]+\.tgz$/;

function parseUrl(rawUrl: string): URL | null {
  try {
    const u = new URL(String(rawUrl ?? '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** GitHub 归档 → codeload 官方端点（T0，字节一致）。 */
function githubArchiveRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'github.com') return null;
  const m = /^\/([^/]+)\/([^/]+)\/archive\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  const [, owner, repo, rest] = m;
  const ext = rest.endsWith('.tar.gz') ? 'tar.gz' : rest.endsWith('.zip') ? 'zip' : null;
  if (!ext) return null;
  const ref = rest.slice(0, rest.length - (ext.length + 1));
  // ref 为空（`/archive/.zip`）不是有效归档，放行会拼出一个必 404 的地址。
  if (!ref) return null;
  // 归档端点不吃 query；带上反而可能被当成未知参数。
  return {
    url: `https://codeload.github.com/${owner}/${repo}/${ext}/${ref}`,
    trust: 't0',
    operator: 'GitHub 官方',
    rule: 'github-archive-to-codeload',
    why: 'github.com/archive 与 codeload.github.com 是同一份字节的官方归档端点，codeload 直连通常更稳。',
  };
}

/** npm tarball → npmmirror（T1，镜像同步，字节一致）。只改 tarball，不动元数据。 */
function npmTarballRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'registry.npmjs.org') return null;
  // 只改 `/{pkg}/-/{file}.tgz`：元数据 JSON 各镜像可能改写字段，字节不一致，
  // 不该由本层静默替换；tarball 才是下载面，且各镜像承诺同步。
  if (!NPM_TARBALL_RE.test(u.pathname)) return null;
  const mirrored = new URL(u.toString());
  mirrored.hostname = 'registry.npmmirror.com';
  return {
    url: mirrored.toString(),
    trust: 't1',
    operator: '阿里云 npmmirror',
    rule: 'npm-tarball-to-npmmirror',
    why: 'npmmirror 分钟级同步 npm，tarball 字节一致；只改单次请求，不写 .npmrc。',
  };
}

/** PyPI 文件 → 阿里云 /pypi（T1，镜像同步，字节一致）。 */
function pypiFileRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'files.pythonhosted.org') return null;
  if (!u.pathname.startsWith('/packages/')) return null;
  const mirrored = new URL(u.toString());
  mirrored.hostname = 'mirrors.aliyun.com';
  mirrored.pathname = `/pypi${u.pathname}`;
  return {
    url: mirrored.toString(),
    trust: 't1',
    operator: '阿里云',
    rule: 'pypi-file-to-aliyun',
    why: '阿里云 pypi 镜像按相同 /packages 路径同步 PyPI 文件，字节一致。',
  };
}

/** proxy.golang.org → goproxy.cn（T1，转发，字节一致）。 */
function goProxyRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'proxy.golang.org') return null;
  const mirrored = new URL(u.toString());
  mirrored.hostname = 'goproxy.cn';
  return {
    url: mirrored.toString(),
    trust: 't1',
    operator: 'goproxy.cn',
    rule: 'goproxy-to-goproxy.cn',
    why: 'goproxy.cn 按相同路径转发 Go module proxy，字节一致。',
  };
}

/** sum.golang.org → goproxy.cn 的 sumdb 反射路径（T1，字节一致）。 */
function goSumdbRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'sum.golang.org') return null;
  const mirrored = new URL(u.toString());
  // goproxy.cn 用 `/sumdb/sum.golang.org/<原 path>` 反射校验和数据库。
  mirrored.hostname = 'goproxy.cn';
  mirrored.pathname = `/sumdb/sum.golang.org${u.pathname}`;
  return {
    url: mirrored.toString(),
    trust: 't1',
    operator: 'goproxy.cn',
    rule: 'gosumdb-to-goproxy.cn',
    why: '校验和数据库经 goproxy.cn 反射，字节一致；不改 GOFLAGS/GONOSUMCHECK。',
  };
}

/** raw.githubusercontent.com → jsDelivr gh（T1，CDN 回源，字节一致）。 */
function rawGithubRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'raw.githubusercontent.com') return null;
  const m = /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  const [, owner, repo, ref, rest] = m;
  return {
    url: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`,
    trust: 't1',
    operator: 'jsDelivr CDN',
    rule: 'raw-github-to-jsdelivr',
    why: 'jsDelivr 按 gh 回源 GitHub raw，字节一致；单文件 20MB 上限，超出会失败并回退。',
  };
}

/** huggingface.co 模型/数据集文件 → ModelScope（T1，LFS 镜像，字节一致）。 */
function huggingfaceRule(u: URL): RewriteCandidate | null {
  if (u.hostname.toLowerCase() !== 'huggingface.co') return null;
  const m = /^\/(datasets\/)?([^/]+)\/([^/]+)\/resolve\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  const [, datasetPrefix, ns, name, rest] = m;
  const prefix = datasetPrefix ? 'datasets/' : `models/`;
  const mirrored = new URL(u.toString());
  mirrored.hostname = 'www.modelscope.cn';
  // ModelScope 把模型放在 /models/<ns>/<name>/...、数据集放在 /datasets/<ns>/<name>/...
  mirrored.pathname = `/${prefix}${ns}/${name}/resolve/${rest}`;
  return {
    url: mirrored.toString(),
    trust: 't1',
    operator: '魔搭 ModelScope',
    rule: 'huggingface-to-modelscope',
    why: 'ModelScope 镜像 HF 的 LFS 文件，字节一致，且不把 HF token 透传给第三方；未被镜像的仓库会 404 并回退。',
  };
}

/**
 * 返回该 URL 的**全部**自动信任（t0/t1）改写候选，按「官方/t0 优先」排序。
 * 无改写返回空数组。调用方据此决定「首选失败后试哪一个」。
 *
 * 纯函数、零 node 依赖：CLI 与 GUI 共用同一份规则，避免两端漂移。
 */
export function sourceRewriteCandidates(rawUrl: string, opts: RewriteOptions = {}): RewriteCandidate[] {
  const enabled = opts.enabledTiers ?? AUTO_TRUST_TIERS;
  const u = parseUrl(rawUrl);
  if (!u) return [];
  const all = [
    githubArchiveRule(u),
    npmTarballRule(u),
    pypiFileRule(u),
    goProxyRule(u),
    goSumdbRule(u),
    rawGithubRule(u),
    huggingfaceRule(u),
  ].filter((c): c is RewriteCandidate => c !== null);

  // 去重：同一目标 URL 只保留一条（理论上规则集内不会重复，防御性收口）。
  const seen = new Set<string>();
  return all
    .filter((c) => enabled.includes(c.trust))
    .filter((c) => {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      return true;
    })
    .sort((a, b) => (a.trust === b.trust ? 0 : a.trust === 't0' ? -1 : 1));
}

/** 该 URL 是否有可用的自动改写（供调用方在失败前判断要不要预置回退路径）。 */
export function hasAutoRewrite(rawUrl: string, opts: RewriteOptions = {}): boolean {
  return sourceRewriteCandidates(rawUrl, opts).length > 0;
}

/** 首选改写（无则 null），顺序即 sourceRewriteCandidates 的首项。 */
export function primaryRewrite(rawUrl: string, opts: RewriteOptions = {}): RewriteCandidate | null {
  return sourceRewriteCandidates(rawUrl, opts)[0] ?? null;
}

/** 下载面用的便捷入口：给出该下载 URL 的首选改写 URL（无则 null）。 */
export function rewriteDownloadUrl(rawUrl: string, opts: RewriteOptions = {}): string | null {
  return primaryRewrite(rawUrl, opts)?.url ?? null;
}

/** 下载面的尝试序列：首选原 URL 在前，字节一致的镜像端点紧随其后（无镜像
 *  则只有一项）。
 *
 *  为什么把「试哪些 URL」做成纯函数：宿主在首选失败后要不要换镜像，还取决于
 *  失败是不是网络类（404 换端点没意义）；但「换到哪个 URL」这一半不该在 CLI 与
 *  GUI 各写一遍。两端共用本函数，规则集只有一份。 */
export function downloadAttemptUrls(
  rawUrl: string,
  opts: RewriteOptions = {},
): Array<{ url: string; rule?: string; trust?: TrustTier }> {
  const rw = primaryRewrite(rawUrl, opts);
  return rw
    ? [{ url: rawUrl }, { url: rw.url, rule: rw.rule, trust: rw.trust }]
    : [{ url: rawUrl }];
}
