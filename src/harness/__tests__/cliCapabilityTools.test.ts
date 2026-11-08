// src/harness/__tests__/cliCapabilityTools.test.ts
// configure_channel（Bun 侧实现）的编排纪律：探活先行（拒绝不落盘）、
// channels.json 保真直改（bindings 不丢）、gateway 死活决定生效文案。
// 落盘根与探活 fetch 走构造注入——改 HOME/模块常量在 bun test 单进程里会
// 固化进缓存（顺序地雷判例），这里只碰自己的临时目录。
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCapabilityToolAdapter } from '../cliCapabilityTools';
import type { ToolAdapter, ToolCall } from '../../shared/types';

const QQ_URL = 'https://bots.qq.com/app/getAppAccessToken';
const TG_URL = 'https://api.telegram.org/bot111222333:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK/getMe';

function fetchStub(status: number, text: string, match: (url: string) => boolean = (u) => u === QQ_URL): typeof fetch {
  return (async (url: string) => {
    if (!match(url)) throw new Error(`fetchStub: no route for ${url}`);
    return new Response(text, { status });
  }) as typeof fetch;
}

const innerStub = { getTools: () => [], execute: async () => { throw new Error('inner stub'); } } as unknown as ToolAdapter;
const hostStub = { connectMcp: async () => ({ tools: [], persisted: false }) };

function call(args: Record<string, unknown>): ToolCall {
  return { id: 't1', index: 0, function: { name: 'configure_channel', arguments: JSON.stringify(args) } };
}

describe('configure_channel (CLI adapter)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pure-cfgch-'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('凭据解析不完整时报错且不落盘', async () => {
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{"access_token":"t"}'));
    const res = await adapter.execute(call({ channel: 'qq', credentials: 'AppID: 1903065122' }));
    expect(res.success).toBe(false);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
    expect(existsSync(join(dir, 'channels.json'))).toBe(false);
  });

  it('平台拒绝凭据时一个字节都不落盘', async () => {
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{"code":111,"message":"invalid appid"}'));
    const res = await adapter.execute(call({ channel: 'qq', credentials: 'AppID: 1903065122\nAppSecret: bad' }));
    expect(res.success).toBe(false);
    expect(res.error).toContain('被平台拒绝');
    expect(res.error).toContain('invalid appid');
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });

  it('网络不通归为网络族文案，不落盘', async () => {
    const fail = (async () => { throw new Error('connect timeout'); }) as unknown as typeof fetch;
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fail);
    const res = await adapter.execute(call({ channel: 'qq', credentials: '1903065122 sec999' }));
    expect(res.success).toBe(false);
    expect(res.error).toContain('网络');
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });

  it('探活通过后落盘：secrets 键在位、channels.json 启用且指针齐全', async () => {
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{"access_token":"tok"}'));
    const res = await adapter.execute(call({ channel: 'qq', credentials: 'AppID: 1903065122\nAppSecret: goodsecret' }));
    expect(res.success).toBe(true);
    // 安全约束：断言只看键存在与长度为正，不回显值。
    const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, unknown>;
    expect(typeof secrets['qq.appSecret']).toBe('string');
    expect((secrets['qq.appSecret'] as string).length).toBeGreaterThan(0);
    const cfg = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8')) as Record<string, unknown>;
    expect(cfg.enabled).toBe(true);
    const qq = (cfg.channels as Record<string, Record<string, unknown>>).qq;
    expect(qq.enabled).toBe(true);
    const acc = (qq.accounts as Record<string, Record<string, unknown>>).main;
    expect(acc.appId).toBe('1903065122');
    expect(acc.appSecretRef).toBe('qq.appSecret');
  });

  it('保真直改：已有 bindings 与其它通道原样保留', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'channels.json'), JSON.stringify({
      enabled: true,
      channels: { feishu: { enabled: true, accounts: { main: { appId: 'cli_x' } } } },
      bindings: [{ match: { channel: 'feishu' }, workspace: '/tmp/ws' }],
    }, null, 2), 'utf8');
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{"access_token":"tok"}'));
    const res = await adapter.execute(call({ channel: 'qq', credentials: '{"appId":"1903065122","appSecret":"goodsecret"}' }));
    expect(res.success).toBe(true);
    const cfg = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8')) as {
      bindings: unknown[];
      channels: Record<string, Record<string, unknown>>;
    };
    expect(cfg.bindings).toHaveLength(1);
    expect(cfg.channels.feishu.enabled).toBe(true);
    expect(cfg.channels.qq.enabled).toBe(true);
  });

  it('网关在跑（lock 活 pid）时文案说热载，没跑时说下次启动生效', async () => {
    const alive = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{"access_token":"tok"}'));
    mkdirSync(join(dir, 'channels'), { recursive: true });
    writeFileSync(join(dir, 'channels', 'gateway.lock'), JSON.stringify({ pid: process.pid }), 'utf8');
    const resAlive = await alive.execute(call({ channel: 'qq', credentials: 'AppID: 1\nAppSecret: secretvalue' }));
    expect(resAlive.result).toContain('热载');

    const dir2 = mkdtempSync(join(tmpdir(), 'pure-cfgch2-'));
    try {
      const stopped = new CliCapabilityToolAdapter(innerStub, hostStub, dir2, fetchStub(200, '{"access_token":"tok"}'));
      const resStopped = await stopped.execute(call({ channel: 'qq', credentials: 'AppID: 1\nAppSecret: secretvalue' }));
      expect(resStopped.result).toContain('下次启动');
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('未知通道名直接拒绝', async () => {
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{}'));
    const res = await adapter.execute(call({ channel: 'unknownchat', credentials: 'x y' }));
    expect(res.success).toBe(false);
    expect(res.error).toContain('feishu');
  });

  it('telegram：解析不完整（无 token 形状）报错不落盘，提示指 @BotFather', async () => {
    const adapter = new CliCapabilityToolAdapter(innerStub, hostStub, dir, fetchStub(200, '{"ok":true}'));
    const res = await adapter.execute(call({ channel: 'telegram', credentials: '一段没有 token 的话' }));
    expect(res.success).toBe(false);
    expect(res.error).toContain('BotFather');
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
    expect(existsSync(join(dir, 'channels.json'))).toBe(false);
  });

  it('telegram：探活通过后 token 进 secrets、channels.json 只落 tokenRef 不落明文', async () => {
    const adapter = new CliCapabilityToolAdapter(
      innerStub, hostStub, dir,
      fetchStub(200, '{"ok":true,"result":{"id":111222333}}', (u) => u === TG_URL),
    );
    const res = await adapter.execute(call({
      channel: 'telegram',
      credentials: 'Use this token:\n111222333:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK\nKeep it safe.',
    }));
    expect(res.success).toBe(true);
    // 安全约束：断言只看键存在与长度为正，不回显值。
    const secrets = JSON.parse(readFileSync(join(dir, 'secrets.json'), 'utf8')) as Record<string, unknown>;
    expect(typeof secrets['telegram.botToken']).toBe('string');
    expect((secrets['telegram.botToken'] as string).length).toBeGreaterThan(0);
    const cfg = JSON.parse(readFileSync(join(dir, 'channels.json'), 'utf8')) as Record<string, unknown>;
    expect(cfg.enabled).toBe(true);
    const tg = (cfg.channels as Record<string, Record<string, unknown>>).telegram;
    expect(tg.enabled).toBe(true);
    const acc = (tg.accounts as Record<string, Record<string, unknown>>).main;
    expect(acc.tokenRef).toBe('telegram.botToken');
    // 明文 token 不进通道配置：account 上没有任何值为完整 token 形状（含冒号串）的键。
    expect(acc.token).toBeUndefined();
    for (const value of Object.values(acc)) {
      if (typeof value === 'string') expect(value.includes(':')).toBe(false);
    }
  });

  it('telegram：平台拒绝时不落盘，文案指 @BotFather', async () => {
    const adapter = new CliCapabilityToolAdapter(
      innerStub, hostStub, dir,
      fetchStub(200, '{"ok":false,"description":"Unauthorized"}', (u) => u === TG_URL),
    );
    const res = await adapter.execute(call({
      channel: 'telegram',
      credentials: '111222333:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK',
    }));
    expect(res.success).toBe(false);
    expect(res.error).toContain('被平台拒绝');
    expect(res.error).toContain('BotFather');
    expect(existsSync(join(dir, 'secrets.json'))).toBe(false);
  });
});
