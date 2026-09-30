// src/channels/config.ts
// ~/.pure/channels.json 的读写、schema 校验与 binding 链解析（设计文档 §5.1 / §9）。
// 校验不过的配置整体拒绝加载并给出行号级错误，不做「部分生效」。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PermissionMode } from '../coding-agent/types';
import type { ChannelId, ChannelToolProfile, PeerKind, ResolvedBinding } from './types';

export interface ChannelAccountConfig {
  [key: string]: unknown;
}

export interface ChannelEntryConfig {
  enabled: boolean;
  dmPolicy?: 'pairing' | 'allowlist' | 'open';
  groupPolicy?: 'mention' | 'all' | 'off';
  accounts?: Record<string, ChannelAccountConfig>;
}

export interface BindingMatch {
  channel?: ChannelId;
  peer?: string;
  threadId?: string;
}

export interface ChannelBinding {
  match: BindingMatch;
  /** null = 无工作区会话（只聊天、不碰文件）。 */
  workspace?: string | null;
  permissionMode?: PermissionMode;
  toolProfile?: ChannelToolProfile;
  evolutionEnabled?: boolean;
}

export interface ChannelsConfig {
  enabled: boolean;
  gateway: { host: string; port: number; wsEnabled: boolean };
  limits: { maxConcurrentSessions: number; perPeerPerMinute: number; dailyTokens: number };
  streaming: { throttleMs: number; ackPlaceholder: boolean; cardFallbackToText: boolean };
  groupPolicy: { mentionRequired: boolean };
  default: { workspace: string | null; permissionMode: PermissionMode; toolProfile: ChannelToolProfile; evolutionEnabled: boolean };
  channels: Record<ChannelId, ChannelEntryConfig>;
  bindings: ChannelBinding[];
}

export interface BindingQuery {
  channelId: ChannelId;
  peerId: string;
  peerKind: PeerKind;
  threadId?: string;
}

const PERMISSION_MODES: PermissionMode[] = ['NORMAL', 'PLAN', 'YOLO', 'DONT_ASK'];

export function defaultChannelsConfig(): ChannelsConfig {
  return {
    enabled: false,
    gateway: { host: '127.0.0.1', port: 18790, wsEnabled: true },
    limits: { maxConcurrentSessions: 4, perPeerPerMinute: 5, dailyTokens: 500_000 },
    streaming: { throttleMs: 1000, ackPlaceholder: true, cardFallbackToText: true },
    groupPolicy: { mentionRequired: true },
    // D4：渠道来源默认 PLAN（只读）。无人值守时绝不能默认全自动。
    default: { workspace: null, permissionMode: 'PLAN', toolProfile: 'readonly', evolutionEnabled: false },
    channels: {},
    bindings: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验用户配置；返回错误列表（空 = 通过）。未知字段忽略，类型错误报出。 */
export function validateChannelsConfig(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ['配置根必须是 JSON 对象'];

  if ('enabled' in raw && typeof raw.enabled !== 'boolean') errors.push('enabled 必须是布尔值');
  if ('gateway' in raw) {
    if (!isRecord(raw.gateway)) errors.push('gateway 必须是对象');
    else {
      const g = raw.gateway;
      if ('host' in g && typeof g.host !== 'string') errors.push('gateway.host 必须是字符串');
      if ('port' in g && (typeof g.port !== 'number' || g.port <= 0 || g.port > 65535)) errors.push('gateway.port 必须是 1-65535 的数字');
    }
  }
  if ('default' in raw && isRecord(raw.default) && 'permissionMode' in (raw.default as Record<string, unknown>)) {
    const mode = (raw.default as Record<string, unknown>).permissionMode;
    if (typeof mode !== 'string' || !PERMISSION_MODES.includes(mode as PermissionMode)) {
      errors.push(`default.permissionMode 必须是 ${PERMISSION_MODES.join(' / ')} 之一`);
    }
  } else if ('default' in raw && !isRecord(raw.default)) {
    errors.push('default 必须是对象');
  }
  if ('bindings' in raw) {
    if (!Array.isArray(raw.bindings)) errors.push('bindings 必须是数组');
    else raw.bindings.forEach((entry, i) => {
      if (!isRecord(entry)) { errors.push(`bindings[${i}] 必须是对象`); return; }
      if (!isRecord(entry.match)) { errors.push(`bindings[${i}].match 必须是对象`); return; }
      if ('permissionMode' in entry && !PERMISSION_MODES.includes(entry.permissionMode as PermissionMode)) {
        errors.push(`bindings[${i}].permissionMode 必须是 ${PERMISSION_MODES.join(' / ')} 之一`);
      }
    });
  }
  if ('channels' in raw && !isRecord(raw.channels)) errors.push('channels 必须是对象');
  return errors;
}

/** 把校验通过的原始 JSON 与默认值合并成完整配置。 */
export function materializeChannelsConfig(raw: unknown): ChannelsConfig {
  const base = defaultChannelsConfig();
  if (!isRecord(raw)) return base;
  const gateway = isRecord(raw.gateway) ? raw.gateway : {};
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const streaming = isRecord(raw.streaming) ? raw.streaming : {};
  const groupPolicy = isRecord(raw.groupPolicy) ? raw.groupPolicy : {};
  const def = isRecord(raw.default) ? raw.default : {};
  const channels: Record<ChannelId, ChannelEntryConfig> = {};
  if (isRecord(raw.channels)) {
    for (const [id, value] of Object.entries(raw.channels)) {
      if (!isRecord(value)) continue;
      channels[id] = {
        enabled: value.enabled !== false,
        dmPolicy: value.dmPolicy as ChannelEntryConfig['dmPolicy'],
        groupPolicy: value.groupPolicy as ChannelEntryConfig['groupPolicy'],
        accounts: isRecord(value.accounts) ? (value.accounts as Record<string, ChannelAccountConfig>) : undefined,
      };
    }
  }
  return {
    enabled: raw.enabled === true,
    gateway: {
      host: typeof gateway.host === 'string' ? gateway.host : base.gateway.host,
      port: typeof gateway.port === 'number' ? gateway.port : base.gateway.port,
      wsEnabled: gateway.wsEnabled !== false,
    },
    limits: {
      maxConcurrentSessions: typeof limits.maxConcurrentSessions === 'number' ? limits.maxConcurrentSessions : base.limits.maxConcurrentSessions,
      perPeerPerMinute: typeof limits.perPeerPerMinute === 'number' ? limits.perPeerPerMinute : base.limits.perPeerPerMinute,
      dailyTokens: typeof limits.dailyTokens === 'number' ? limits.dailyTokens : base.limits.dailyTokens,
    },
    streaming: {
      throttleMs: typeof streaming.throttleMs === 'number' ? streaming.throttleMs : base.streaming.throttleMs,
      ackPlaceholder: streaming.ackPlaceholder !== false,
      cardFallbackToText: streaming.cardFallbackToText !== false,
    },
    groupPolicy: { mentionRequired: groupPolicy.mentionRequired !== false },
    default: {
      workspace: typeof def.workspace === 'string' ? def.workspace : null,
      permissionMode: PERMISSION_MODES.includes(def.permissionMode as PermissionMode) ? (def.permissionMode as PermissionMode) : base.default.permissionMode,
      toolProfile: def.toolProfile === 'coding' ? 'coding' : base.default.toolProfile,
      evolutionEnabled: def.evolutionEnabled === true,
    },
    channels,
    bindings: Array.isArray(raw.bindings) ? (raw.bindings as ChannelBinding[]) : [],
  };
}

export interface LoadChannelsResult {
  config: ChannelsConfig;
  errors: string[];
  /** 文件不存在（回落到默认配置，不算错误）。 */
  missing: boolean;
}

export function loadChannelsConfig(path: string): LoadChannelsResult {
  if (!existsSync(path)) return { config: defaultChannelsConfig(), errors: [], missing: true };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { config: defaultChannelsConfig(), errors: [`无法解析 ${path}: ${err instanceof Error ? err.message : String(err)}`], missing: false };
  }
  const errors = validateChannelsConfig(raw);
  if (errors.length > 0) return { config: defaultChannelsConfig(), errors, missing: false };
  return { config: materializeChannelsConfig(raw), errors: [], missing: false };
}

export function writeChannelsConfig(path: string, config: ChannelsConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
}

/** binding 链优先级：群/主题级 > 单聊级 > 通道级 > default（§5.1）。 */
export function resolveBinding(config: ChannelsConfig, query: BindingQuery): ResolvedBinding {
  const score = (b: ChannelBinding): number => {
    const m = b.match ?? {};
    if (m.channel && m.channel !== query.channelId) return -1;
    let s = m.channel ? 10 : 0;
    if (m.peer !== undefined) {
      if (m.peer !== query.peerId) return -1;
      s += 100;
    }
    if (m.threadId !== undefined) {
      if (m.threadId !== query.threadId) return -1;
      s += 1000;
    }
    return s;
  };
  let best: ChannelBinding | undefined;
  let bestScore = -1;
  for (const binding of config.bindings) {
    const s = score(binding);
    if (s > bestScore) { best = binding; bestScore = s; }
  }
  if (!best) {
    return { ...config.default, matched: false };
  }
  return {
    workspace: best.workspace !== undefined ? best.workspace : config.default.workspace,
    permissionMode: best.permissionMode ?? config.default.permissionMode,
    toolProfile: best.toolProfile ?? config.default.toolProfile,
    evolutionEnabled: best.evolutionEnabled ?? config.default.evolutionEnabled,
    matched: true,
  };
}
