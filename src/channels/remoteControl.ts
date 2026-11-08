// src/channels/remoteControl.ts
// 手机遥控面（docs/remote-session-control-2026-11.md）：控制词识别 + 附着注册表。
// 第 1 步范围：/sessions（磁盘总览）+ /attach /detach（登记）+ /status（磁盘摘要）。
// 指挥注入（/stop 与附着消息改路由）待 GUI 侧 remoteBridge 接通后替换落点——
// 在那之前 /stop 如实回「未接通」，不假装受理（状态真话红线）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listSessionViews, readSessionTimeline, type SessionView } from '../shared/node/sessionViews';
import type { BridgeSessionState } from '../shared/remoteBridge';
import type { InboundEvent, OutboundMessage } from './types';

// ---------- 控制词解析 ----------

export type ControlCommand =
  | { kind: 'sessions' }
  | { kind: 'attach'; target: string }
  | { kind: 'detach' }
  | { kind: 'status'; target?: string }
  | { kind: 'stop' }
  | { kind: 'help' };

const COMMAND_RE = /^\/(sessions|attach|detach|status|stop|help)(?:\s+(.*))?$/i;

/**
 * 只认这六个词；其余 / 开头的文本（未知命令）原样放行给会话，
 * 不吞不答——网关没有资格替 agent 决定「/xxx 不是给我的」。
 */
export function parseControlCommand(text: string): ControlCommand | null {
  const m = text.trim().match(COMMAND_RE);
  if (!m) return null;
  const arg = (m[2] ?? '').trim();
  switch (m[1].toLowerCase()) {
    case 'sessions':
      return { kind: 'sessions' };
    case 'help':
      return { kind: 'help' };
    case 'attach':
      return { kind: 'attach', target: arg };
    case 'detach':
      return { kind: 'detach' };
    case 'status':
      return { kind: 'status', ...(arg ? { target: arg } : {}) };
    case 'stop':
      return { kind: 'stop' };
    default:
      return null;
  }
}

// ---------- 附着注册表 ----------

interface AttachEntry {
  sessionId: string;
  attachedAt: number;
}

interface SnapshotEntry {
  /** /sessions 列表顺序的 sessionId 快照：编号 → 会话，TTL 内可被 /attach /status 引用。 */
  sessionIds: string[];
  at: number;
}

const SNAPSHOT_TTL_MS = 10 * 60_000;

/**
 * chatKey → sessionId 有向映射（一个 chat 同时附着至多一个会话，换绑即重新
 * attach）；列表快照解决「动态排序下编号漂移」——编号只在最近一次 /sessions
 * 的 10 分钟内有效。附着落盘（重启恢复），快照留内存（过期就该重新看列表）。
 */
export class AttachRegistry {
  private attaches = new Map<string, AttachEntry>();
  private snapshots = new Map<string, SnapshotEntry>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  attach(chatKey: string, sessionId: string): void {
    this.attaches.set(chatKey, { sessionId, attachedAt: this.now() });
    this.persist();
  }

  /** 返回解绑的 sessionId；本来就没附着返回 undefined。 */
  detach(chatKey: string): string | undefined {
    const entry = this.attaches.get(chatKey);
    if (!entry) return undefined;
    this.attaches.delete(chatKey);
    this.persist();
    return entry.sessionId;
  }

  attachedSession(chatKey: string): string | undefined {
    return this.attaches.get(chatKey)?.sessionId;
  }

  /** 同一会话被哪些 chat 附着（投影分发方向：sessionId → chatKeys）。 */
  chatsFor(sessionId: string): string[] {
    const out: string[] = [];
    for (const [chatKey, entry] of this.attaches) {
      if (entry.sessionId === sessionId) out.push(chatKey);
    }
    return out;
  }

  rememberSnapshot(chatKey: string, sessionIds: string[]): void {
    this.snapshots.set(chatKey, { sessionIds, at: this.now() });
  }

  /** 编号（1 起）→ sessionId；过期/越界返回 undefined。 */
  resolveIndex(chatKey: string, index: string): string | undefined {
    const snapshot = this.snapshots.get(chatKey);
    if (!snapshot) return undefined;
    if (this.now() - snapshot.at > SNAPSHOT_TTL_MS) return undefined;
    const n = Number.parseInt(index, 10);
    if (!Number.isInteger(n) || n < 1 || n > snapshot.sessionIds.length) return undefined;
    return snapshot.sessionIds[n - 1];
  }

  private load(): void {
    if (!this.path) return;
    try {
      if (!existsSync(this.path)) return;
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, AttachEntry>;
      for (const [key, value] of Object.entries(raw)) {
        if (value && typeof value.sessionId === 'string') this.attaches.set(key, value);
      }
    } catch {
      this.attaches.clear();
    }
  }

  private persist(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.attaches), null, 2), 'utf8');
    } catch {
      // 写失败只影响重启恢复，不影响当前进程的附着。
    }
  }
}

// ---------- 渲染 ----------

const MAX_LIST_ROWS = 20;

const STATUS_MARK: Record<SessionView['status'], string> = {
  running: '▶',
  settled: '✓',
  failed: '⛔',
  idle: '○',
};

const STATUS_LABEL: Record<SessionView['status'], string> = {
  running: '跑动中',
  settled: '空闲',
  failed: '失败',
  idle: '空闲',
};

function formatAgo(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function workspaceBasename(workspace: string | null | undefined): string | undefined {
  if (!workspace) return undefined;
  const segs = workspace.split(/[/\\]/).filter(Boolean);
  return segs.length > 0 ? segs[segs.length - 1] : undefined;
}

export interface SessionListRow {
  view: SessionView;
  title: string;
}

/** 列表行标题优先级：index.json 标题 > workspace 尾段 > peer > 会话 id。 */
export function titleFor(view: SessionView, titles: Map<string, string>): string {
  return (
    titles.get(view.sessionId) ??
    workspaceBasename(view.workspace) ??
    view.peer ??
    view.sessionId
  );
}

/**
 * 会话列表文本。快照记忆由调用方（RemoteControl）负责——这里只管把
 * views 变成人能读的行，不掺注册表状态。
 */
export function formatSessionList(rows: SessionListRow[], now: number): string {
  if (rows.length === 0) {
    return 'pure 桌面端还没有会话记录。在桌面端跑起来一个对话后，再发 /sessions 查看。';
  }
  const shown = rows.slice(0, MAX_LIST_ROWS);
  const running = rows.filter((r) => r.view.status === 'running').length;
  const lines = shown.map((row, i) => {
    const v = row.view;
    const detail = v.status === 'running' && v.statusDetail ? v.statusDetail : formatAgo(v.lastActivityAt, now);
    const surface = v.surface === 'gui' ? '' : ` · ${v.surface}`;
    return `${i + 1}. ${row.title} · ${STATUS_MARK[v.status]} ${STATUS_LABEL[v.status]} · ${detail}${surface}`;
  });
  const more = rows.length > shown.length ? `\n（共 ${rows.length} 个，只显示最近 ${shown.length} 个）` : '';
  return (
    `pure 会话（共 ${rows.length} 个 · ${running} 个跑动中）\n` +
    lines.join('\n') +
    more +
    '\n/attach <编号> 盯住看 · /status <编号> 看进度 · /help 全部命令'
  );
}

/** 手机端命令总览（冷启动入口：不知道有遥控时，发 /help 即全部可见）。 */
export function renderHelp(): string {
  return [
    'pure 手机遥控——桌面端跑会话，这里看进度、发指挥：',
    '· /sessions　列出桌面端全部会话（▶=跑动中）',
    '· /attach <编号>　盯住一个会话，动态推到这里',
    '· /status <编号>　看它跑到哪一步',
    '· /stop　让附着的会话停下（第一段=暂停，再发一次=硬停）',
    '· /detach　不盯了',
    '· /help　本清单',
    '· 直接发消息　已附着时=指挥那个会话（跑动中=插话，空闲=新回合）',
    '上手三步：/sessions → /attach <编号> → 直接发消息。',
  ].join('\n');
}

/** 单会话状态摘要（磁盘事实：events.jsonl 时间线；没有日志的旧会话如实说没有）。 */
export function formatStatus(view: SessionView | undefined, title: string, timeline: { summary: string }[], now: number, maxEntries = 8): string {
  if (!view) {
    return `会话 ${title}：没有找到运行记录（可能从未运行，或日志已清）。`;
  }
  const statusLine =
    view.status === 'running' && view.statusDetail
      ? `${STATUS_MARK[view.status]} ${view.statusDetail}`
      : `${STATUS_MARK[view.status]} ${STATUS_LABEL[view.status]} · ${formatAgo(view.lastActivityAt, now)}`;
  const lines = [`会话 ${title} · ${statusLine}`];
  if (timeline.length > 0) {
    lines.push('最近动态：');
    for (const entry of timeline.slice(-maxEntries)) {
      lines.push(`· ${entry.summary}`);
    }
  } else if (view.statusDetail && view.status !== 'running') {
    lines.push(`· ${view.statusDetail}`);
  }
  return lines.join('\n');
}

// ---------- 遥控处理器 ----------

export interface RemoteControlDeps {
  /** ~/.pure 根：读 sessions 目录总览、index.json 标题、attach.json 注册表。 */
  pureDir: string;
  /** /stop 与附着消息的指挥落点；GUI 桥接通前缺省（/stop 如实回未接通）。 */
  inject?: (sessionId: string, text: string) => Promise<void>;
  stop?: (sessionId: string) => Promise<void>;
  guiOnline?: () => boolean;
  /** GUI 桥上报的 live 会话状态：跑动行的「正在跑什么」以 GUI 实时事实为准。 */
  guiLive?: () => BridgeSessionState[];
  log?: (message: string) => void;
  now?: () => number;
}

export class RemoteControl {
  readonly registry: AttachRegistry;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly titles = new Map<string, string>();
  private titlesReadAt = 0;

  constructor(private readonly deps: RemoteControlDeps) {
    this.registry = new AttachRegistry(join(deps.pureDir, 'channels', 'attach.json'), deps.now ?? Date.now);
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? Date.now;
  }

  /**
   * 控制词入口。返回 null = 不是控制词，调用方继续原路由；
   * 返回消息 = 已受理，调用方直接投递、不再进 agent 会话。
   * 附着中的 chat：普通消息也在这里截下转指挥（inject 到被附着会话，
   * 不再进 channel 自己的会话——附着即改路由，设计核心概念）。
   */
  async handle(inbound: InboundEvent, sessionKey: string): Promise<OutboundMessage | null> {
    const cmd = parseControlCommand(inbound.text);
    if (!cmd) {
      const attached = this.registry.attachedSession(sessionKey);
      if (!attached || !this.deps.inject) return null;
      try {
        await this.deps.inject(attached, inbound.text);
        this.log(`remote inject → ${attached} from ${sessionKey}`);
        return { kind: 'notice', text: '已送达桌面，等待受理回执与回合开始。', final: true };
      } catch (err) {
        this.log(`inject failed: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: 'notice', text: '指令没能送达桌面（GUI 可能已离线）——附着推送挂起，指令未执行。', final: true };
      }
    }
    const reply = await this.dispatch(cmd, sessionKey);
    if (reply) this.log(`remote control ${cmd.kind} from ${sessionKey}`);
    return reply;
  }

  private async dispatch(cmd: ControlCommand, chatKey: string): Promise<OutboundMessage | null> {
    switch (cmd.kind) {
      case 'sessions':
        return { kind: 'notice', text: this.renderSessionList(chatKey), final: true };
      case 'attach':
        return { kind: 'notice', text: this.attach(chatKey, cmd.target), final: true };
      case 'detach':
        return { kind: 'notice', text: this.detach(chatKey), final: true };
      case 'status':
        return { kind: 'notice', text: await this.status(chatKey, cmd.target), final: true };
      case 'stop':
        return { kind: 'notice', text: await this.stop(chatKey), final: true };
      case 'help':
        return { kind: 'notice', text: renderHelp(), final: true };
      default:
        return null;
    }
  }

  private readTitles(): Map<string, string> {
    // 60s 内复用：列表场景一次读盘足够，/sessions 连发不重复扫。
    if (this.now() - this.titlesReadAt < 60_000) return this.titles;
    this.titlesReadAt = this.now();
    this.titles.clear();
    try {
      const path = join(this.deps.pureDir, 'sessions', 'index.json');
      if (!existsSync(path)) return this.titles;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<{ id?: unknown; title?: unknown }>;
      if (!Array.isArray(raw)) return this.titles;
      for (const meta of raw) {
        if (typeof meta?.id === 'string' && typeof meta?.title === 'string' && meta.title.length > 0) {
          this.titles.set(meta.id, meta.title);
        }
      }
    } catch {
      // 标题读不到就退 workspace/peer，不影响列表主体。
    }
    return this.titles;
  }

  private renderSessionList(chatKey: string): string {
    const views = listSessionViews(this.deps.pureDir);
    const titles = this.readTitles();
    const live = new Map((this.deps.guiLive?.() ?? []).map((s) => [s.sessionId, s]));
    const rows = views.map((view) => {
      const merged: SessionView = { ...view };
      const liveState = live.get(view.sessionId);
      if (merged.status === 'running' && liveState?.toolNow) {
        merged.statusDetail = `跑动中 · ${liveState.toolNow}`;
      } else if (merged.status !== 'running' && liveState?.running) {
        // GUI 实时事实比磁盘事件推导新鲜：刚发起还没落 user_input 时兜住。
        merged.status = 'running';
        merged.statusDetail = liveState.toolNow ? `跑动中 · ${liveState.toolNow}` : '跑动中';
      }
      return { view: merged, title: titleFor(merged, titles) };
    });
    // 记住本次列表顺序：后续 /attach <n> / /status <n> 的编号以此为据。
    this.registry.rememberSnapshot(chatKey, views.map((v) => v.sessionId));
    return formatSessionList(rows, this.now());
  }

  private attach(chatKey: string, target: string): string {
    if (!target) {
      return '用法：/attach <编号>——先发 /sessions 拿到会话列表。';
    }
    // 纯数字只走编号解析（快照），绝不兜底成会话 id——「/attach 99」必须是
    // 无效编号，而不是静默附着一个叫 "99" 的会话。
    const isNumeric = /^\d+$/.test(target);
    let sessionId = this.registry.resolveIndex(chatKey, target);
    if (!sessionId && !isNumeric && /^[A-Za-z0-9_-]+$/.test(target)) {
      // 容忍直接给会话 id（脚本/自动化场景）。
      sessionId = target;
    }
    if (!sessionId) {
      return `编号 ${target} 无效或列表快照已过期（超过 10 分钟）——重新发 /sessions 再试。`;
    }
    const previous = this.registry.attachedSession(chatKey);
    this.registry.attach(chatKey, sessionId);
    const titles = this.readTitles();
    const title = titles.get(sessionId) ?? sessionId;
    const swapped = previous && previous !== sessionId;
    // 附着即回填（磁盘事实）：把最近时间线一并推过去——附着到跑了一半的
    // 会话时，手机端立刻有上下文；GUI 离线也成立。
    const timeline = readSessionTimeline(this.deps.pureDir, sessionId, 6);
    let backfill = '';
    if (timeline.length > 0) {
      backfill = '\n—— 附着回填（最近动态）——\n' + timeline.map((e) => `· ${e.summary}`).join('\n');
    }
    if (swapped) {
      return `已改附到「${title}」（原附着 ${titles.get(previous!) ?? previous} 已解除）。后续动态会推到这里。${backfill}`;
    }
    return `已附着「${title}」。后续动态会推到这里；发消息即指挥它（跑动中=插话，空闲=新回合），/detach 停止。${backfill}`;
  }

  private detach(chatKey: string): string {
    const sessionId = this.registry.detach(chatKey);
    if (!sessionId) {
      return '当前没有附着任何会话。';
    }
    const titles = this.readTitles();
    return `已停止订阅「${titles.get(sessionId) ?? sessionId}」，之后不再推送。`;
  }

  private async status(chatKey: string, target?: string): Promise<string> {
    let sessionId: string | undefined;
    if (target) {
      const isNumeric = /^\d+$/.test(target);
      sessionId = this.registry.resolveIndex(chatKey, target);
      if (!sessionId && !isNumeric && /^[A-Za-z0-9_-]+$/.test(target)) sessionId = target;
      if (!sessionId) return `编号 ${target} 无效或列表快照已过期——重新发 /sessions 再试。`;
    } else {
      sessionId = this.registry.attachedSession(chatKey);
      if (!sessionId) return '用法：/status <编号>（先 /sessions），或先 /attach 一个会话后直接 /status。';
    }
    const views = listSessionViews(this.deps.pureDir);
    const view = views.find((v) => v.sessionId === sessionId);
    const title = this.readTitles().get(sessionId) ?? workspaceBasename(view?.workspace) ?? sessionId;
    const timeline = readSessionTimeline(this.deps.pureDir, sessionId, 8);
    return formatStatus(view, title, timeline, this.now());
  }

  private async stop(chatKey: string): Promise<string> {
    const sessionId = this.registry.attachedSession(chatKey);
    if (!sessionId) {
      return '先 /attach 一个会话，才能远程停止它。';
    }
    if (!this.deps.stop) {
      return '远程停止需要桌面指挥链路（尚未接通）——请在桌面端按 Esc 停止，或稍后再试。';
    }
    try {
      await this.deps.stop(sessionId);
      return '已发送停止指令（第一段=暂停，再发一次 /stop = 硬停）。';
    } catch (err) {
      this.log(`/stop failed: ${err instanceof Error ? err.message : String(err)}`);
      return '停止指令发送失败（桌面端可能已离线）。';
    }
  }
}
