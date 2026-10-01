// src/cliChannels.ts
// `pure gateway`（常驻守护进程）与 `pure channels <list|...>` 的实现。
// 与 cli.ts 分开，避免入口文件继续膨胀；依赖 cliHarness / channels 层。
import { bold, cyan, dim, green, red, yellow } from './termcolors';
import { PURE_DIR } from './cliConfig';
import type { CliArgs } from './cliConfig';
import { loadChannelsConfig, resolveBinding, validateChannelsConfig } from './channels/config';
import { ChannelRegistry } from './channels/registry';
import { ChannelSessionIndex } from './channels/sessionIndex';
import { Gateway } from './channels/gateway';
import { createCliChannelHarnessFactory } from './channels/harnessFactory';
import { createWebChatAdapter } from './adapter/channels/webchat';
import { createFeishuAdapter } from './adapter/channels/feishu';
import { createDingTalkAdapter } from './adapter/channels/dingtalk';
import { PairingGate } from './channels/pairing';
import { ChannelAuditLog } from './channels/audit';
import { DailyTokenBudget, PeerRateLimiter } from './channels/limits';
import { isCustomProviderId } from './shared/providers';
import { existsSync, readFileSync } from 'node:fs';

const CHANNELS_CONFIG_PATH = `${PURE_DIR}/channels.json`;
const CHANNELS_LOCK_PATH = `${PURE_DIR}/channels/gateway.lock`;
const SESSIONS_INDEX_PATH = `${PURE_DIR}/channels/sessions.json`;
const PENDING_PAIRINGS_PATH = `${PURE_DIR}/channels/pending-pairings.json`;
const PEERS_PATH = `${PURE_DIR}/channels/peers.json`;

/** 密钥解析：*Ref 指向 ~/.pure/secrets.json 的同名槽位，不把 token 明文写进 channels.json。 */
function resolveChannelSecret(ref: unknown): string {
  if (typeof ref !== 'string' || !ref) return '';
  try {
    const path = `${PURE_DIR}/secrets.json`;
    if (!existsSync(path)) return '';
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    return typeof raw[ref] === 'string' ? (raw[ref] as string) : '';
  } catch {
    return '';
  }
}

function makePairingGate(): PairingGate {
  return new PairingGate({ pendingPath: PENDING_PAIRINGS_PATH, peersPath: PEERS_PATH, log: channelsLog });
}

function channelsLog(message: string): void {
  process.stdout.write(`${dim('[channels]')} ${message}\n`);
}

function ensureProviderConfigured(args: CliArgs): boolean {
  if (args.provider === 'mock') return true;
  if (isCustomProviderId(args.customProviders, args.provider)) return true;
  if (args.apiKey) return true;
  process.stderr.write(`  ${red('❌')} 没有可用的 API key（provider ${cyan(args.provider)}）。\n`);
  process.stderr.write(`  ${dim('先跑')} ${bold('pure config')} ${dim('配置 provider 与 key，再启动 gateway。')}\n`);
  return false;
}

export async function runGateway(args: CliArgs): Promise<void> {
  const loaded = loadChannelsConfig(CHANNELS_CONFIG_PATH);
  if (loaded.errors.length > 0) {
    process.stderr.write(`  ${red('❌')} ${CHANNELS_CONFIG_PATH} 校验失败，已拒绝加载（不做部分生效）：\n`);
    for (const line of loaded.errors) process.stderr.write(`    ${dim('·')} ${line}\n`);
    process.exit(1);
  }
  if (loaded.missing) {
    process.stderr.write(`  ${yellow('⚠')} 未找到 ${CHANNELS_CONFIG_PATH}。\n`);
    process.stderr.write(`  ${dim('打开 gateway 需要在配置里显式启用通道（enabled: true）。')}\n`);
    process.exit(1);
  }
  const config = loaded.config;
  if (!config.enabled) {
    process.stderr.write(`  ${yellow('⚠')} channels.enabled 为 false —— 未启动任何通道。\n`);
    return;
  }
  if (!ensureProviderConfigured(args)) process.exit(1);

  const registry = new ChannelRegistry({ log: channelsLog });
  registry.register(createWebChatAdapter({ host: config.gateway.host, port: config.gateway.port }));
  await registerConfiguredFeishu(registry, config);
  await registerConfiguredDingTalk(registry, config);
  await registerConfiguredQQ(registry, config);

  // 2026-10-01 真机：探活打 gateway.host:port，而端口唯一的绑定者是 webchat
  // 适配器——webchat 禁用时网关本身健康（飞书长连接已建立）但探针无门可敲，
  // 设置页报「端口未就绪/连通性失败」。端口契约改为「网关在跑就必答
  // /healthz」：webchat 启用时由它的服务器答（adapter 内同款路由）；显式
  // 禁用时由这里的极简应答器答。这也是将来 daemon 控制面的第一粒种子。
  let healthServer: ReturnType<typeof Bun.serve> | undefined;
  if (config.channels.webchat?.enabled === false) {
    try {
      healthServer = Bun.serve({
        hostname: config.gateway.host,
        port: config.gateway.port,
        fetch(req) {
          return new URL(req.url).pathname === '/healthz'
            ? new Response('ok', { headers: { 'content-type': 'text/plain' } })
            : new Response('not found', { status: 404 });
        },
      });
      channelsLog(`health endpoint on http://${config.gateway.host}:${config.gateway.port}/healthz（webchat 已禁用，端口由网关应答）`);
    } catch (err) {
      // 端口被占（残留实例等）不是致命伤：网关主职能（通道长连接）不受影响，
      // 探活退化为锁文件 + pid 判定。如实记录。
      channelsLog(`health endpoint 绑定失败（${err instanceof Error ? err.message : String(err)}）——探活退化为进程判定`);
    }
  }
  const plugins = await registry.loadPlugins(`${PURE_DIR}/channels`);
  if (plugins.length > 0) channelsLog(`loaded plugins: ${plugins.join(', ')}`);

  const index = new ChannelSessionIndex(SESSIONS_INDEX_PATH);
  const factory = createCliChannelHarnessFactory({ baseArgs: args, log: channelsLog });
  const gateway = new Gateway({
    config,
    registry,
    factory,
    lockPath: CHANNELS_LOCK_PATH,
    index,
    outboxPath: `${PURE_DIR}/channels/outbox.jsonl`,
    pairing: makePairingGate(),
    audit: new ChannelAuditLog({ path: `${PURE_DIR}/channels/audit.jsonl`, log: channelsLog }),
    limiter: new PeerRateLimiter({ perMinute: config.limits.perPeerPerMinute }),
    budget: new DailyTokenBudget({ dailyTokens: config.limits.dailyTokens }),
    log: channelsLog,
  });

  try {
    await gateway.start();
  } catch (err) {
    process.stderr.write(`  ${red('❌')} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  process.stdout.write(`  ${green('✅')} gateway running — ${dim('Ctrl+C 停止')}\n`);
  for (const adapter of registry.list()) {
    const entry = config.channels[adapter.id];
    const state = entry?.enabled === false ? dim('disabled') : cyan('enabled');
    process.stdout.write(`    ${dim('·')} ${adapter.id} ${state}${adapter.id === 'webchat' ? dim(` http://${config.gateway.host}:${config.gateway.port}`) : ''}\n`);
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    channelsLog(`收到 ${signal}，正在停止…`);
    try { healthServer?.stop(true); } catch { /* already down */ }
    await gateway.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise<void>(() => { /* keep the process alive until a signal */ });
}

/** 按配置注册飞书：缺 SDK / 缺凭据只 warn 跳过，不影响其它通道。 */
async function registerConfiguredFeishu(registry: ChannelRegistry, config: ReturnType<typeof loadChannelsConfig>['config']): Promise<void> {
  const entry = config.channels.feishu;
  if (!entry || entry.enabled === false) return;
  const first = Object.entries(entry.accounts ?? {})[0];
  const accountId = first?.[0] ?? 'main';
  const account = (first?.[1] ?? {}) as Record<string, unknown>;
  const appId = typeof account.appId === 'string' ? account.appId : '';
  const appSecret = typeof account.appSecret === 'string' ? account.appSecret : resolveChannelSecret(account.appSecretRef);
  if (!appId || !appSecret) {
    channelsLog('feishu 已启用但缺少 appId / appSecret（或 appSecretRef），已跳过该通道');
    return;
  }
  try {
    const { createFeishuSdkTransport } = await import('./adapter/channels/feishu/sdkTransport');
    const transport = await createFeishuSdkTransport({
      appId,
      appSecret,
      botOpenId: typeof account.botOpenId === 'string' ? account.botOpenId : undefined,
      log: channelsLog,
    });
    registry.register(createFeishuAdapter({ accountId, transport }));
  } catch (err) {
    channelsLog(`feishu 通道不可用：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 按配置注册 QQ：原生 WS transport（无 SDK 依赖），缺凭据只 warn 跳过。 */
async function registerConfiguredQQ(registry: ChannelRegistry, config: ReturnType<typeof loadChannelsConfig>['config']): Promise<void> {
  const entry = config.channels.qq;
  if (!entry || entry.enabled === false) return;
  const first = Object.entries(entry.accounts ?? {})[0];
  const accountId = first?.[0] ?? 'main';
  const account = (first?.[1] ?? {}) as Record<string, unknown>;
  const appId = typeof account.appId === 'string' ? account.appId : '';
  const appSecret = typeof account.appSecret === 'string' ? account.appSecret : resolveChannelSecret(account.appSecretRef);
  if (!appId || !appSecret) {
    channelsLog('qq 已启用但缺少 appId / appSecret（或 appSecretRef），已跳过该通道');
    return;
  }
  try {
    const { createQQWsTransport } = await import('./adapter/channels/qq/wsTransport');
    const transport = await createQQWsTransport({ appId, appSecret, log: channelsLog });
    const { createQQAdapter } = await import('./adapter/channels/qq');
    registry.register(createQQAdapter({ accountId, transport }));
  } catch (err) {
    channelsLog(`qq 通道不可用：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 按配置注册钉钉：缺 SDK / 缺凭据只 warn 跳过。 */
async function registerConfiguredDingTalk(registry: ChannelRegistry, config: ReturnType<typeof loadChannelsConfig>['config']): Promise<void> {
  const entry = config.channels.dingtalk;
  if (!entry || entry.enabled === false) return;
  const first = Object.entries(entry.accounts ?? {})[0];
  const accountId = first?.[0] ?? 'main';
  const account = (first?.[1] ?? {}) as Record<string, unknown>;
  const clientId = typeof account.clientId === 'string' ? account.clientId : '';
  const clientSecret = typeof account.clientSecret === 'string' ? account.clientSecret : resolveChannelSecret(account.clientSecretRef);
  if (!clientId || !clientSecret) {
    channelsLog('dingtalk 已启用但缺少 clientId / clientSecret（或 clientSecretRef），已跳过该通道');
    return;
  }
  try {
    const { createDingTalkSdkTransport } = await import('./adapter/channels/dingtalk/sdkTransport');
    const transport = await createDingTalkSdkTransport({
      clientId,
      clientSecret,
      cardTemplateId: typeof account.cardTemplateId === 'string' ? account.cardTemplateId : undefined,
      robotCode: typeof account.robotCode === 'string' ? account.robotCode : undefined,
      log: channelsLog,
    });
    registry.register(createDingTalkAdapter({ accountId, transport }));
  } catch (err) {
    channelsLog(`dingtalk 通道不可用：${err instanceof Error ? err.message : String(err)}`);
  }
}

function printChannels(args: CliArgs): void {
  const loaded = loadChannelsConfig(CHANNELS_CONFIG_PATH);
  if (loaded.errors.length > 0) {
    process.stderr.write(`  ${red('❌')} ${CHANNELS_CONFIG_PATH} 校验失败：\n`);
    for (const line of loaded.errors) process.stderr.write(`    ${dim('·')} ${line}\n`);
    return;
  }
  const config = loaded.config;
  process.stdout.write(`  ${bold('channels')} ${dim(CHANNELS_CONFIG_PATH)}${loaded.missing ? dim('（不存在，回落到默认）') : ''}\n`);
  process.stdout.write(`    ${dim('enabled:')} ${config.enabled ? green('true') : dim('false')}\n`);
  const entries = Object.entries(config.channels);
  if (entries.length === 0) {
    process.stdout.write(`    ${dim('（未配置任何通道）')}\n`);
  } else {
    for (const [id, entry] of entries) {
      const accounts = entry.accounts ? Object.keys(entry.accounts).join(', ') : 'default';
      process.stdout.write(`    ${cyan(id)} ${entry.enabled === false ? dim('disabled') : green('enabled')} ${dim(`dm=${entry.dmPolicy ?? 'pairing'} group=${entry.groupPolicy ?? 'mention'} accounts=${accounts}`)}\n`);
    }
  }
  process.stdout.write(`    ${dim('default:')} workspace=${config.default.workspace ?? '(none)'} mode=${config.default.permissionMode} profile=${config.default.toolProfile}\n`);
  process.stdout.write(`    ${dim('limits:')} ${config.limits.perPeerPerMinute}/分钟/peer，每日 ${config.limits.dailyTokens} tokens\n`);
  for (const binding of config.bindings) {
    const m = binding.match ?? {};
    const scope = [m.channel, m.peer, m.threadId].filter(Boolean).join('/') || '*';
    const target = resolveBinding(config, { channelId: m.channel ?? 'any', peerId: m.peer ?? 'any', peerKind: 'dm', threadId: m.threadId });
    process.stdout.write(`    ${dim('binding')} ${scope} → workspace=${binding.workspace ?? target.workspace ?? '(none)'} mode=${binding.permissionMode ?? target.permissionMode}\n`);
  }
  const pendingPath = `${PURE_DIR}/channels/pending-pairings.json`;
  if (existsSync(pendingPath)) {
    try {
      const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as unknown[];
      if (Array.isArray(pending) && pending.length > 0) {
        process.stdout.write(`    ${yellow(`待配对 ${pending.length} 条`)} ${dim(pendingPath)}\n`);
      }
    } catch {
      // ignore malformed pending file in a listing command
    }
  }
}

export async function runChannelsCommand(args: CliArgs): Promise<void> {
  const sub = (args.prompt || 'list').trim();
  if (sub === 'list' || sub === '') {
    printChannels(args);
    return;
  }
  if (sub === 'test') {
    const loaded = loadChannelsConfig(CHANNELS_CONFIG_PATH);
    const errors = validateChannelsConfig(loaded.config);
    process.stdout.write(errors.length === 0
      ? `  ${green('✅')} channels.json 通过校验\n`
      : `  ${red('❌')} ${errors.join('; ')}\n`);
    return;
  }
  if (sub === 'pending') {
    const gate = makePairingGate();
    const pending = gate.listPending();
    if (pending.length === 0) {
      process.stdout.write(`  ${dim('没有待批准的配对请求。')}\n`);
      return;
    }
    for (const entry of pending) {
      process.stdout.write(`    ${cyan(entry.code)} ${entry.channelId}:${entry.peerId}${entry.name ? dim(`（${entry.name}）`) : ''}\n`);
    }
    return;
  }
  if (sub.startsWith('approve')) {
    const code = sub.split(/\s+/)[1] ?? '';
    if (!code) {
      process.stdout.write(`  ${dim('用法:')} pure channels approve <code>\n`);
      return;
    }
    const peer = makePairingGate().approve(code);
    if (!peer) {
      process.stdout.write(`  ${red('❌')} 找不到配对码 ${cyan(code)}（可能已批准或已过期）。\n`);
      return;
    }
    process.stdout.write(`  ${green('✅')} 已批准 ${peer.channelId}:${peer.peerId}${peer.name ? dim(`（${peer.name}）`) : ''}\n`);
    return;
  }
  process.stdout.write(`  ${dim('用法:')} pure channels [list|test|pending|approve <code>]\n`);
}
