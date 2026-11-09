// src/shared/worldStateRender.ts
// 四期 4b（docs/framework-reform-2026-11.md）：世界状态分区化 diff 渲染。
// user-turn 的事实分区（envFacts / taskScriptFacts / ledgerFacts / plan /
// contract / assessment / buildProtocol）每个用户回合原样重发，长会话里
// 静态分区（项目惯例、运行时清单）被逐字重复几十遍。分区渲染器对每个分区
// 维护内容 hash + 距上次全量渲染的回合计数：内容不变且未超指针期限 →
// 渲染成一行指针（近零 token）；否则全量重发。
// 指针期限（MAX_POINTER_AGE）是历史淘汰的保险丝：引擎内 trim/压缩可能把
// 历史里那份全量拷贝淘汰掉，指针就成了悬空引用。每 3 回合强制一次全量
// 重发，盲窗有界且自愈——最坏情况模型最多 2 个回合看不到该分区全文。
// 分区名与 UserTurnContext 键同名：renderTurn 的返回值可直接展开进上下文
// 对象，调用点不需要二次映射。

/** 指针期限：连续指针的最多回合数。2 = 全量渲染至多隔 2 个回合重现。 */
const MAX_POINTER_AGE = 2;

export type WorldStatePartition =
  | 'envFacts'
  | 'buildProtocol'
  | 'plan'
  | 'clarifications'
  | 'contract'
  | 'taskScriptFacts'
  | 'ledgerFacts'
  | 'assessment';

/** FNV-1a 32-bit。diff 守卫只求「大概率相同」，不抗碰撞攻击；碰撞的后果
 *  也只是改动分区晚 ≤2 回合才被重发（期限保险丝兜着）。 */
function partitionHash(content: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function unchangedNote(part: WorldStatePartition): string {
  return `[${part}] unchanged since the previous task_context — the earlier copy in this conversation still applies; nothing new here.`;
}

export class WorldStateRenderer {
  private last = new Map<WorldStatePartition, { hash: number; age: number }>();

  /** 每个用户回合恰好调用一次（renderTurn 内部已调）：全部账龄 +1。 */
  private tick(): void {
    for (const entry of this.last.values()) entry.age++;
  }

  /** 分区账整体失效时调用（会话切换/冷恢复/历史被压缩替换）：忘记全部
   *  hash，下一回合全量渲染。宁可多渲染，不可让指针引用不在场的历史。 */
  reset(): void {
    this.last.clear();
  }

  /** 一个用户回合的全部分区渲染：先账龄，再逐分区 diff。返回值键与入参
   *  一致，可直接展开进 UserTurnContext；入参为 undefined 的分区不在输出
   *  里产键（与「没传」同形，装配层无需区分）。 */
  renderTurn(partitions: { [K in WorldStatePartition]?: string | undefined }): { [K in WorldStatePartition]?: string } {
    this.tick();
    const out: { [K in WorldStatePartition]?: string } = {};
    for (const key of Object.keys(partitions) as WorldStatePartition[]) {
      const rendered = this.render(key, partitions[key]);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }

  private render(part: WorldStatePartition, content: string | undefined): string | undefined {
    if (!content || !content.trim()) {
      // 分区清空（如账本空了）：忘记旧 hash。空内容不发指针——回来时全量。
      this.last.delete(part);
      return content;
    }
    const hash = partitionHash(content);
    const prev = this.last.get(part);
    // age=0 只可能是本回合刚全量渲染过（renderTurn 每回合先 tick，上一回合
    // 的条目进来时 ≥1）——那时不发指针。
    if (prev && prev.hash === hash && prev.age >= 1 && prev.age <= MAX_POINTER_AGE) {
      return unchangedNote(part);
    }
    this.last.set(part, { hash, age: 0 });
    return content;
  }
}
