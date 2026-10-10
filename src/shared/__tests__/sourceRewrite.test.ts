// src/shared/__tests__/sourceRewrite.test.ts
// S2 单请求 URL 改写的规则集。**零真实网络**：只验证「哪个 URL 被改写成哪个」，
// 以及信任边界（只产出 t0/t1）、只做字节一致改写（不收录 release 二进制等）。

import { describe, expect, it } from 'bun:test';
import {
  downloadAttemptUrls,
  hasAutoRewrite,
  primaryRewrite,
  rewriteDownloadUrl,
  sourceRewriteCandidates,
} from '../sourceRewrite';

const only = (url: string): string | undefined => sourceRewriteCandidates(url)[0]?.url;

describe('sourceRewrite · GitHub 归档 → codeload（T0 官方同源）', () => {
  it('tar.gz 归档改写到 codeload 官方端点', () => {
    const c = sourceRewriteCandidates('https://github.com/QwenLM/Qwen2.5/archive/refs/tags/v0.1.tar.gz');
    expect(c).toHaveLength(1);
    expect(c[0]!.url).toBe('https://codeload.github.com/QwenLM/Qwen2.5/tar.gz/refs/tags/v0.1');
    expect(c[0]!.trust).toBe('t0');
  });

  it('zip 分支归档同理（refs/heads）', () => {
    expect(only('https://github.com/octocat/Hello-World/archive/refs/heads/main.zip'))
      .toBe('https://codeload.github.com/octocat/Hello-World/zip/refs/heads/main');
  });

  it('release 二进制**不**改写：唯一出路是 t2 公益代理，越界', () => {
    expect(sourceRewriteCandidates('https://github.com/o/r/releases/download/v1/app.zip')).toEqual([]);
  });

  it('非归档路径与缺扩展名不改写', () => {
    expect(sourceRewriteCandidates('https://github.com/o/r/archive/refs/heads/main')).toEqual([]);
    expect(sourceRewriteCandidates('https://github.com/o/r')).toEqual([]);
  });

  it('已经指向 codeload 的 URL 不改写自己', () => {
    expect(sourceRewriteCandidates('https://codeload.github.com/o/r/tar.gz/v1')).toEqual([]);
  });
});

describe('sourceRewrite · 包管理器镜像（T1）', () => {
  it('npm tarball → npmmirror，路径不变', () => {
    expect(only('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'))
      .toBe('https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz');
  });

  it('npm 元数据**不**改写：镜像可能改写字段，字节不一致', () => {
    expect(sourceRewriteCandidates('https://registry.npmjs.org/left-pad')).toEqual([]);
  });

  it('PyPI 文件 → 阿里云 /pypi，路径不变', () => {
    expect(only('https://files.pythonhosted.org/packages/aa/bb/ccc/requests-2.0.whl'))
      .toBe('https://mirrors.aliyun.com/pypi/packages/aa/bb/ccc/requests-2.0.whl');
  });

  it('Go module proxy → goproxy.cn，路径不变', () => {
    expect(only('https://proxy.golang.org/github.com/pkg/errors/@v/v0.9.1.zip'))
      .toBe('https://goproxy.cn/github.com/pkg/errors/@v/v0.9.1.zip');
  });

  it('sum.golang.org → goproxy.cn 的 sumdb 反射路径', () => {
    expect(only('https://sum.golang.org/lookup/github.com/pkg/errors@v0.9.1'))
      .toBe('https://goproxy.cn/sumdb/sum.golang.org/lookup/github.com/pkg/errors@v0.9.1');
  });
});

describe('sourceRewrite · raw 与 HuggingFace（T1）', () => {
  it('raw.githubusercontent.com → jsDelivr gh', () => {
    expect(only('https://raw.githubusercontent.com/octocat/Hello-World/main/README'))
      .toBe('https://cdn.jsdelivr.net/gh/octocat/Hello-World@main/README');
  });

  it('HF 模型文件 → ModelScope /models 前缀', () => {
    expect(only('https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/resolve/main/config.json'))
      .toBe('https://www.modelscope.cn/models/Qwen/Qwen2.5-3B-Instruct/resolve/main/config.json');
  });

  it('HF 数据集文件 → ModelScope /datasets 前缀', () => {
    expect(only('https://huggingface.co/datasets/openai/gsm8k/resolve/main/README.md'))
      .toBe('https://www.modelscope.cn/datasets/openai/gsm8k/resolve/main/README.md');
  });

  it('hf-mirror.com 不是源端点，不做改写（且它是 t2，本层不碰）', () => {
    expect(sourceRewriteCandidates('https://hf-mirror.com/Qwen/Qwen2.5/resolve/main/config.json')).toEqual([]);
  });
});

describe('sourceRewrite · Maven / crates / Node 镜像（T1）', () => {
  it('Maven Central → 阿里云 /repository/public（去掉 /maven2 段）', () => {
    expect(only('https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar'))
      .toBe('https://maven.aliyun.com/repository/public/org/apache/commons/commons-lang3/3.14.0/commons-lang3-3.14.0.jar');
  });

  it('Maven 非 /maven2 路径不改写', () => {
    expect(sourceRewriteCandidates('https://repo1.maven.org/foo/bar.jar')).toEqual([]);
  });

  it('crates.io 包文件 → USTC /crates.io 前缀', () => {
    expect(only('https://static.crates.io/crates/serde/serde-1.0.200.crate'))
      .toBe('https://mirrors.ustc.edu.cn/crates.io/crates/serde/serde-1.0.200.crate');
  });

  it('nodejs.org /dist → npmmirror /-/binary/node', () => {
    expect(only('https://nodejs.org/dist/v20.11.0/SHASUMS256.txt'))
      .toBe('https://registry.npmmirror.com/-/binary/node/v20.11.0/SHASUMS256.txt');
  });

  it('nodejs.org /download/release 同样映射', () => {
    expect(only('https://nodejs.org/download/release/v20.11.0/node-v20.11.0-darwin-x64.tar.gz'))
      .toBe('https://registry.npmmirror.com/-/binary/node/v20.11.0/node-v20.11.0-darwin-x64.tar.gz');
  });

  it('nodejs.org 非发行版路径不改写（网站页面不是发行版文件）', () => {
    expect(sourceRewriteCandidates('https://nodejs.org/en/download')).toEqual([]);
    expect(sourceRewriteCandidates('https://nodejs.org/api/index.html')).toEqual([]);
  });
});

describe('sourceRewrite · 信任边界与健壮性', () => {
  it('无关域名与非法协议一律无候选', () => {
    expect(sourceRewriteCandidates('https://example.com/a.tar.gz')).toEqual([]);
    expect(sourceRewriteCandidates('ftp://github.com/o/r/archive/x.zip')).toEqual([]);
    expect(sourceRewriteCandidates('not a url')).toEqual([]);
    expect(sourceRewriteCandidates('')).toEqual([]);
  });

  it('只产出 t0/t1：显式开启 t2/t3 也不会多出任何候选', () => {
    const withT2 = sourceRewriteCandidates('https://huggingface.co/Qwen/Qwen2.5/resolve/main/f.bin', {
      enabledTiers: ['t0', 't1', 't2', 't3'],
    });
    expect(withT2).toHaveLength(1);
    expect(withT2[0]!.trust).toBe('t1');
  });

  it('按信任分层过滤：只允许 t0 时 t1 规则被剔除', () => {
    expect(sourceRewriteCandidates('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', {
      enabledTiers: ['t0'],
    })).toEqual([]);
    // t0 规则不受影响。
    expect(sourceRewriteCandidates('https://github.com/o/r/archive/v1.tar.gz', {
      enabledTiers: ['t0'],
    })).toHaveLength(1);
  });

  it('便捷入口：hasAutoRewrite / primaryRewrite / rewriteDownloadUrl 一致', () => {
    const url = 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz';
    expect(hasAutoRewrite(url)).toBe(true);
    expect(primaryRewrite(url)?.url).toBe('https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz');
    expect(rewriteDownloadUrl(url)).toBe('https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz');
    expect(rewriteDownloadUrl('https://example.com/x.tgz')).toBeNull();
  });

  it('downloadAttemptUrls：原 URL 在前、镜像紧随其后；无镜像只有一项', () => {
    const withMirror = downloadAttemptUrls('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz');
    expect(withMirror.map((a) => a.url)).toEqual([
      'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      'https://registry.npmmirror.com/left-pad/-/left-pad-1.3.0.tgz',
    ]);
    expect(withMirror[0]!.rule).toBeUndefined();
    expect(withMirror[1]!.rule).toBe('npm-tarball-to-npmmirror');
    expect(withMirror[1]!.trust).toBe('t1');
    // 无镜像端点：不凭空造第二项。
    expect(downloadAttemptUrls('https://example.com/x.tgz')).toEqual([{ url: 'https://example.com/x.tgz' }]);
    // 分层过滤同样生效：只允许 t0 时 npm（t1）不再有第二项。
    expect(downloadAttemptUrls('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', { enabledTiers: ['t0'] }))
      .toEqual([{ url: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' }]);
  });
});
