// 设置 → 通用 →「GitHub 加速」的接线（2026-10-26）：这一层的价值全在
// 「开关没开就一次镜像请求都不发」和「开了以后回退链真的接进了下载」。所以这里
// 锁三件事：控件在通用页、状态只有一个来源（mirror !== 'direct'）、回退链接到
// download_file / Skill Hub 两条真实下载路。

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('设置页 · GitHub 加速', () => {
  it('控件放在通用页，而不是单独的分类页', () => {
    const html = read('../../../index.html');
    const general = html.indexOf('data-page="general"');
    const llm = html.indexOf('data-page="llm"');
    const block = html.indexOf('data-i18n="ghAccel.title"');
    expect(general).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(general);
    expect(block).toBeLessThan(llm);
    for (const id of [
      'cfg-github-accel',
      'cfg-github-mirror',
      'cfg-github-mirror-custom',
      'cfg-github-mirror-test',
      'gh-accel-latency',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('开关没有独立的布尔字段：mirror !== direct 就是开', () => {
    const src = read('../settings.ts');
    expect(src).toContain('toggle.checked = current !== \'direct\'');
    expect(src).toContain(": 'direct',");
    // 关掉再打开要恢复上次的节点，而不是回到空白。
    expect(src).toContain('if (current !== \'direct\') select.value = current;');
    expect(src).toContain('else if (!select.value) select.value = entries[0]?.key');
  });

  it('节点下拉与测速都从共享注册表来，UI 不另写一份地址清单', () => {
    const src = read('../settings.ts');
    expect(src).toContain('githubMirrorDropdownEntries');
    expect(src).toContain('githubProbeEntries(customPrefix)');
    expect(src).toContain("'github_mirror_probe'");
    expect(src).toContain('probeGithubMirrorLatency(entry.prefix)');
    expect(src).toContain('latencyBucket(result.latencyMs, result.ok)');
    expect(src).toContain('GITHUB_MIRROR_PROBE_URL');
  });

  it('Skill Hub 浏览 / 安装把回退链传下去（否则开关只改了设置页的外观）', () => {
    const src = read('../settings.ts');
    expect(src).toContain('githubFallbackPrefixes(mirrorCfg.githubMirror, mirrorCfg.customGithubMirror)');
    expect(src).toContain('fetchHubIndex(repo, \'\', mirrorPrefixes)');
    expect(src).toContain('fetchSkillBody(repo, skill, \'\', mirrorPrefixes)');
  });

  it('download_file 开了加速就镜像先行（直连退居链尾），并标注实际来源', () => {
    const src = read('../TauriToolAdapter.ts');
    expect(src).toContain('githubDownloadAttempts(url, this.githubMirror, this.githubCustomMirror)');
    expect(src).toContain('github-mirror:${attempt.mirrorKey}');
    // 链尾直连不在这里重复打——它就是后面的常规路径本身。
    expect(src).toContain(".filter((attempt) => attempt.prefix !== '')");
    // 递归回到镜像 URL 时必须停（镜像地址不在 GitHub 名单里 → 不再展开）。
    expect(src).toContain('!isAlreadyMirrored(url, this.githubAccelPrefixes())');
    // 镜像链全灭后，直连的失败兜底不再重打整条链。
    expect(src).toContain('mirrorChainTried ? null : await this.retryDownloadViaMirror');
  });

  it('默认关闭，配置字段进模型', () => {
    const cfg = read('../config.ts');
    expect(cfg).toContain('githubMirror: DEFAULT_GITHUB_MIRROR');
    expect(cfg).toContain('customGithubMirror: \'\'');
    expect(cfg).toContain('githubMirror: string;');
  });

  it('文案两种语言都在（中文缺键会静默回落到英文，所以逐字查）', () => {
    const i18n = read('../../shared/i18n.ts');
    const keys = [
      'ghAccel.title',
      'ghAccel.enabled',
      'ghAccel.enabled.hint',
      'ghAccel.mirror',
      'ghAccel.custom',
      'ghAccel.test',
      'ghAccel.testBtn',
      'ghAccel.unreachable',
      'ghAccel.customNeeded',
    ];
    for (const key of keys) {
      const hits = i18n.split(`'${key}':`).length - 1;
      expect(hits).toBeGreaterThanOrEqual(2);
      const line = i18n.slice(i18n.indexOf(`'${key}':`)).split('\n')[0];
      expect(/[\u4e00-\u9fff]/.test(line)).toBe(true);
    }
    // 纯格式串（无中文）仍要两种语言都在。
    expect(i18n.split("'ghAccel.ms':").length - 1).toBe(2);
  });

  it('延迟标签的样式齐备（面板画出来的类必须在样式表里）', () => {
    const css = read('../styles.css');
    for (const cls of [
      'gh-accel-latency',
      'gh-accel-latency-row',
      'gh-accel-latency-tag',
      'gh-accel-custom-row',
    ]) {
      expect(css).toContain(`.${cls}`);
    }
    for (const bucket of ['good', 'warn', 'bad', 'dead']) {
      expect(css).toContain(`.gh-accel-latency-tag.${bucket}`);
    }
  });
});
