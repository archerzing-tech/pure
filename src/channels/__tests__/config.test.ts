import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultChannelsConfig,
  loadChannelsConfig,
  materializeChannelsConfig,
  resolveBinding,
  validateChannelsConfig,
  writeChannelsConfig,
} from '../config';

describe('channels config', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pure-chcfg-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('defaults to disabled with a read-only policy', () => {
    const config = defaultChannelsConfig();
    expect(config.enabled).toBe(false);
    expect(config.default.permissionMode).toBe('PLAN');
    expect(config.default.toolProfile).toBe('readonly');
  });

  it('reports type errors instead of partially applying', () => {
    const errors = validateChannelsConfig({
      enabled: 'yes',
      gateway: { port: 99999 },
      default: { permissionMode: 'SUPER' },
      bindings: 'nope',
      channels: [],
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.join('\n')).toContain('default.permissionMode');
    expect(errors.join('\n')).toContain('bindings 必须是数组');
  });

  it('rejects the whole file when validation fails', () => {
    const path = join(dir, 'channels.json');
    writeFileSync(path, JSON.stringify({ gateway: { port: -1 } }));
    const result = loadChannelsConfig(path);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.config.enabled).toBe(false);
  });

  it('round-trips a valid config through disk', () => {
    const path = join(dir, 'channels.json');
    const config = defaultChannelsConfig();
    config.enabled = true;
    config.channels = { telegram: { enabled: true } };
    writeChannelsConfig(path, config);
    const loaded = loadChannelsConfig(path);
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.enabled).toBe(true);
    expect(loaded.config.channels.telegram.enabled).toBe(true);
  });

  it('treats a missing file as defaults, not an error', () => {
    const loaded = loadChannelsConfig(join(dir, 'nope.json'));
    expect(loaded.missing).toBe(true);
    expect(loaded.errors).toEqual([]);
  });

  it('materializes partial config over defaults', () => {
    const config = materializeChannelsConfig({ gateway: { port: 1234 } });
    expect(config.gateway.port).toBe(1234);
    expect(config.gateway.host).toBe('127.0.0.1');
    expect(config.limits.maxConcurrentSessions).toBe(4);
  });
});

describe('binding resolution', () => {
  const config = defaultChannelsConfig();
  config.default = { workspace: '/default', permissionMode: 'PLAN', toolProfile: 'readonly', evolutionEnabled: false };
  config.bindings = [
    { match: { channel: 'telegram' }, workspace: '/channel', permissionMode: 'PLAN' },
    { match: { channel: 'telegram', peer: 'alice' }, workspace: '/peer', permissionMode: 'NORMAL' },
    { match: { channel: 'telegram', peer: 'alice', threadId: '7' }, workspace: '/thread', permissionMode: 'NORMAL', evolutionEnabled: true },
  ];

  it('prefers the most specific binding', () => {
    expect(resolveBinding(config, { channelId: 'telegram', peerId: 'alice', peerKind: 'dm', threadId: '7' }).workspace).toBe('/thread');
    expect(resolveBinding(config, { channelId: 'telegram', peerId: 'alice', peerKind: 'dm' }).workspace).toBe('/peer');
    expect(resolveBinding(config, { channelId: 'telegram', peerId: 'bob', peerKind: 'dm' }).workspace).toBe('/channel');
    expect(resolveBinding(config, { channelId: 'feishu', peerId: 'bob', peerKind: 'dm' }).workspace).toBe('/default');
  });

  it('falls back to default and reports it did not match', () => {
    const resolved = resolveBinding(config, { channelId: 'unknown', peerId: 'x', peerKind: 'dm' });
    expect(resolved.matched).toBe(false);
    expect(resolved.permissionMode).toBe('PLAN');
  });

  it('does not let a channel binding match another channel', () => {
    const resolved = resolveBinding(config, { channelId: 'feishu', peerId: 'alice', peerKind: 'dm' });
    expect(resolved.workspace).toBe('/default');
  });
});
