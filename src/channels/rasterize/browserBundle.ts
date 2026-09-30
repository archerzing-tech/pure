// src/channels/rasterize/browserBundle.ts
// 把 mermaid / @plantuml/core 按需打成一个自包含的浏览器 IIFE，好让 headless
// Chrome 直接 `Runtime.evaluate` 执行 —— 不写文件、不起 HTTP 服务、不碰 CDN。
//
// 打包用 Bun.build（内置，零新增依赖）。入口写成绝对路径 import，所以临时入口
// 文件放系统临时目录也能从项目的 node_modules 里解析依赖。
//
// 只有真的要渲染 mermaid/puml 时才会走到这里：一次打包 + 一次注入，之后按
// 进程缓存复用。没装 Chrome、打包失败都只是让调用方返回 null（降级为文本）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/** 解析一个包到绝对路径（入口用的是它，而不是裸模块名）。 */
export function resolveModuleEntry(specifier: string): string {
  return requireFromHere.resolve(specifier);
}

const bundleCache = new Map<string, Promise<string>>();

/**
 * 打包一段入口源码成浏览器 IIFE，返回代码文本（进程内缓存）。
 * `key` 只用于缓存去重，调用方给稳定的标识即可。
 */
export function buildBrowserBundle(key: string, entrySource: string): Promise<string> {
  const cached = bundleCache.get(key);
  if (cached) return cached;
  const task = build(entrySource).catch((err: unknown) => {
    bundleCache.delete(key);
    throw err;
  });
  bundleCache.set(key, task);
  return task;
}

async function build(entrySource: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'pure-browser-bundle-'));
  const entry = join(dir, 'entry.ts');
  try {
    writeFileSync(entry, entrySource, 'utf8');
    const result = await Bun.build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
      minify: true,
      outdir: dir,
    });
    if (!result.success || result.outputs.length === 0) {
      throw new Error(`browser bundle failed: ${result.logs.map((l) => String(l)).join('; ').slice(0, 500)}`);
    }
    return readFileSync(result.outputs[0].path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
