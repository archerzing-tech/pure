// src/channels/approvals.ts
// 渠道版 PermissionRequestHandler（设计文档 §6.3）。复用 PermissionManager 的
// 接口，不改 PermissionManager —— GUI 弹窗 / CLI 终端 / IM 卡片是同一个接口
// 的三个表面，语义统一为 y / a / n。
//
// 双轨（必做）：卡片按钮有失效场景（模板未发布、旧卡片回调不支持长连接、
// 群里点不了按钮），所以审批永远同时给出文字指令；卡片下发失败自动降级为纯文字。
import type { PermissionDecision, PermissionRequestHandler, PermissionRequestInfo } from '../coding-agent/types';
import type { ChannelTarget, OutboundMessage } from './types';

export interface ApprovalSender {
  (target: ChannelTarget, message: OutboundMessage): Promise<void>;
}

export interface ChannelApprovalBrokerOptions {
  /** 超时默认拒绝（无人值守的安全默认值）。 */
  timeoutMs?: number;
  capabilities?: { buttons?: boolean };
  log?: (message: string) => void;
  /** 审计钩子：每次批准/拒绝（含超时拒绝）都过它。 */
  onDecision?: (target: ChannelTarget, info: PermissionRequestInfo, decision: PermissionDecision) => void;
}

interface PendingApproval {
  id: string;
  sessionKey: string;
  resolve: (decision: PermissionDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ApprovalAnswer = 'allow' | 'always' | 'deny';

/** y/yes/是/允许=批准；a/always/始终允许=本次会话总是允许；n/no/否/拒绝=拒绝。 */
export function parseApprovalAnswer(raw: string): ApprovalAnswer | null {
  const a = raw.trim().toLowerCase();
  if (a === 'y' || a === 'yes' || a === '是' || a === '允许') return 'allow';
  if (a === 'a' || a === 'always' || a === '始终允许') return 'always';
  if (a === 'n' || a === 'no' || a === '否' || a === '拒绝') return 'deny';
  return null;
}

/** 按钮决定 → 双轨文字回复（所有通道共用同一套 y/a/n 语义）。 */
export function decisionToReplyText(decision: ApprovalAnswer): string {
  return decision === 'allow' ? 'y' : decision === 'always' ? 'a' : 'n';
}

export function formatApprovalText(info: PermissionRequestInfo, id: string): string {
  const lines = [
    `🔐 需要批准（#${id}）`,
    `工具：${info.tool}`,
    `风险：${info.dangerLevel} / ${info.riskLevel}`,
    `说明：${info.description}`,
  ];
  if (info.command) lines.push(`命令：${info.command}`);
  if (info.path) lines.push(`路径：${info.path}`);
  lines.push('', '回复 y 批准 / n 拒绝 / a 本次会话总是允许（超时自动拒绝）');
  return lines.join('\n');
}

export class ChannelApprovalBroker {
  private pending = new Map<string, PendingApproval>();
  private seq = 0;
  private readonly timeoutMs: number;
  private readonly log: (message: string) => void;
  private readonly onDecision?: ChannelApprovalBrokerOptions['onDecision'];
  private readonly targets = new Map<string, ChannelTarget>();
  private readonly infos = new Map<string, PermissionRequestInfo>();

  constructor(private readonly send: ApprovalSender, options: ChannelApprovalBrokerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.log = options.log ?? ((m) => console.warn(`[channels] ${m}`));
    this.onDecision = options.onDecision;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async request(target: ChannelTarget, sessionKey: string, info: PermissionRequestInfo): Promise<PermissionDecision> {
    if (info.signal?.aborted) return { allowed: false, reason: 'aborted by user' };
    const id = `ap${++this.seq}`;

    const decision = new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const decision: PermissionDecision = { allowed: false, reason: '审批超时（无人确认），默认拒绝' };
        this.emitDecision(id, decision);
        resolve(decision);
      }, this.timeoutMs);
      // 超时计时器不应阻止进程退出。
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { id, sessionKey, resolve, timer });
      this.targets.set(id, target);
      this.infos.set(id, info);
    });

    try {
      await this.send(target, { kind: 'approval', text: formatApprovalText(info, id), approvalId: id });
    } catch (err) {
      // 卡片/消息下发失败：不放弃请求，改为文本降级已经包含 y/n/a，继续等待。
      this.log(`approval card delivery failed (${err instanceof Error ? err.message : String(err)}); awaiting text reply`);
    }
    this.log(`审批请求 #${id} 已发往 ${sessionKey}（工具 ${info.tool}）`);
    return decision;
  }

  /** 处理聊天回复。返回 true 表示该消息被当作审批答案消费掉了。 */
  handleReply(sessionKey: string, text: string, approvalId?: string): boolean {
    const answer = parseApprovalAnswer(text);
    if (!answer) return false;
    const entry = approvalId
      ? this.pending.get(approvalId)
      : [...this.pending.values()].find((p) => p.sessionKey === sessionKey);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(entry.id);
    const decision: PermissionDecision = answer === 'allow'
      ? { allowed: true }
      : answer === 'always'
        ? { allowed: true, remember: true }
        : { allowed: false, reason: '用户在通道中拒绝了该操作' };
    this.emitDecision(entry.id, decision);
    entry.resolve(decision);
    return true;
  }

  private emitDecision(id: string, decision: PermissionDecision): void {
    const info = this.infos.get(id);
    const target = this.targets.get(id);
    this.infos.delete(id);
    this.targets.delete(id);
    if (!info || !target || !this.onDecision) return;
    this.onDecision(target, info, decision);
  }

  /** 会话结束/中止时清空待决请求，避免悬挂 promise。 */
  cancelSession(sessionKey: string, reason = '会话已结束'): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionKey !== sessionKey) continue;
      clearTimeout(entry.timer);
      this.pending.delete(entry.id);
      entry.resolve({ allowed: false, reason });
    }
  }
}

export function createChannelApprovalHandler(
  broker: ChannelApprovalBroker,
  target: ChannelTarget,
  sessionKey: string,
): PermissionRequestHandler {
  return (info: PermissionRequestInfo) => broker.request(target, sessionKey, info);
}
