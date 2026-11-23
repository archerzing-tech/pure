// src/shared/parallelNudge.ts
// 生产侧并行提醒（2026-11-18 大屏复测判例）：fan-out 教学（2767157）让模型
// 「知情」，但 flash 档模型的 solo 决策依旧保守——run3 主线直写 114.9KB 仍
// 零委派，78 分钟到全绿（run1 到绿只要 24 分钟）。这一层做感知手脚：主线
// 整体写入越过阈值且本回合零委派时，记一条一次性处方（读即清）注入
// user-turn——把「你已经直写了多少、剩余工作值不值得批量委派」摆到模型眼前。
// 裁决权仍在模型：紧耦合就继续 solo，处方不构成指令（决策边界：机制只做
// 感知，何时拆归模型）。阈值 24KB≈两三个中等模块（2026-11-20 用户判例：
// 「多 agent 激发不够果断」——60KB 时往往已经连写四五个模块，拆分窗口过去
// 了；提前到第二三个模块，让模型在还有活可拆时抬头看一眼）。单回合至多一条
// （sticky，读过即清）。
// shared 层不碰存储，也不读 i18n（providerSelfHeal 同构）。

const THRESHOLD_BYTES = 24_000;

let pending: string | null = null;

/** 回合中途记账：主线 write_file 每次成功后调用。累计越过阈值且本回合尚未
 *  记过提醒时落一条处方（之后同回合的写入不再触发）。 */
export function recordMainThreadWriteBytes(bytes: number, files: number): void {
  if (pending !== null) return;
  if (!(bytes >= THRESHOLD_BYTES)) return;
  const kb = Math.round(bytes / 1024);
  pending = `Main-thread write volume this turn: ${files} whole-file write(s), ~${kb} KB generated code in YOUR OWN transcript — every future round re-reads it. Make the split decision now, before the next module: if the remaining work still has independent modules, pin their shared contract (schema / class names / entry API) in one message, then batch code_editor delegations in the SAME message so big files are written in worker sessions. If what is left is tightly coupled or small, continuing solo is fine — this is a volume fact, not an order.`;
}

/**
 * 回合写入账（2026-11-23 收口）：引擎是唯一的记账人，宿主只回答「这次调用
 * 是不是委派」。此前 GUI 在事件流里按 args 记、CLI 在 execute 层包一层记，
 * 同一个事实两套实现，各自的阈值口径还容易漂。现在两边都删掉，引擎按 run
 * 建一个 tracker，工具结果配平时 observe 一次。
 */
export interface TurnWriteTracker {
  /** 每个真实执行的工具结果调一次。委派现身即封口（模型已经自己拆过路）。 */
  observe(toolName: string, args: string | undefined, success: boolean, delegated: boolean): void;
}

export function createTurnWriteTracker(): TurnWriteTracker {
  let bytes = 0;
  let files = 0;
  let delegationSeen = false;
  return {
    observe(toolName: string, args: string | undefined, success: boolean, delegated: boolean): void {
      if (delegated) {
        delegationSeen = true;
        return;
      }
      if (!success || delegationSeen) return;
      const base = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
      if (base !== 'write_file' || !args) return;
      let chars = 0;
      try {
        const parsed: unknown = JSON.parse(args);
        if (parsed && typeof parsed === 'object') {
          const content = (parsed as { content?: unknown }).content;
          if (typeof content === 'string') chars = content.length;
        }
      } catch {
        // 参数残缺不记账：那条走失败/截断救援路径，自有对应文案。
        return;
      }
      bytes += chars;
      files += 1;
      recordMainThreadWriteBytes(bytes, files);
    },
  };
}

/** 读走处方（读即清）。无处方返回空串——envFacts 装配零开销。 */
export function takeBuildParallelNudge(): string {
  const p = pending;
  pending = null;
  return p ?? '';
}

/** 测试与跨回合清场用（进程级状态，flaky-quartet 判例）。 */
export function resetParallelNudgeForTests(): void {
  pending = null;
}
