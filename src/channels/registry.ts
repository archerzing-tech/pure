// src/channels/registry.ts
// 通道插件注册表（设计文档 §4.1）。内置适配器由 gateway 显式装入；用户插件
// 从 ~/.pure/channels/<id>/index.(ts|js) 动态加载。一个通道加载失败只影响它自己。
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChannelAdapter, ChannelId } from './types';

export interface ChannelRegistryOptions {
  log?: (message: string) => void;
}

export class ChannelRegistry {
  private adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly log: (message: string) => void;

  constructor(options: ChannelRegistryOptions = {}) {
    this.log = options.log ?? ((message) => console.warn(`[channels] ${message}`));
  }

  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.id)) this.log(`duplicate adapter id "${adapter.id}" — replacing`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ChannelId): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  has(id: ChannelId): boolean {
    return this.adapters.has(id);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  listIds(): ChannelId[] {
    return [...this.adapters.keys()];
  }

  /**
   * 动态加载用户插件：~/.pure/channels/<id>/index.ts|js，默认导出工厂。
   * 单个插件坏了只 warn 跳过，绝不影响其它通道或 gateway 启动。
   */
  async loadPlugins(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const loaded: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const candidates = ['index.ts', 'index.js', 'index.mjs'];
      const file = candidates.map((f) => join(dir, entry.name, f)).find((p) => existsSync(p));
      if (!file) continue;
      try {
        const mod = await import(pathToFileURL(resolve(file)).href);
        const factory = mod.default ?? mod.createAdapter;
        if (typeof factory !== 'function') {
          this.log(`plugin "${id}" has no default adapter factory — skipped`);
          continue;
        }
        const adapter = await factory();
        if (!adapter || typeof adapter.id !== 'string' || typeof adapter.send !== 'function') {
          this.log(`plugin "${id}" returned an invalid adapter — skipped`);
          continue;
        }
        this.register(adapter as ChannelAdapter);
        loaded.push(adapter.id);
      } catch (err) {
        this.log(`plugin "${id}" failed to load: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return loaded;
  }
}
