// src/ui/errorLedger.ts
// GUI 未捕获异常台账。
// 「快速甩动后按钮全死、聊天窗口空白」这类僵尸态事故,WebContent 进程活着
// (采样空闲、RSS 三百多兆)但页面已经聋了——它的 console 外面读不到,
// 事后没有任何第一手证据。这里在页面内拦 window error /
// unhandledrejection,攒批落盘到 ~/.pure/gui_errors.log(Rust gui_error_log
// 命令只管 append),下次再聋,精确异常栈就在文件里。
// 台账自身必须比页面更皮实:落盘失败静默丢弃,绝不再抛;同一次异常级联里
// 保前 50 条(最早的往往是根因),超长字段截断。

export interface GuiErrorInput {
  /** info = 设计内正常路径的取证现场（如 ctx-shape 门禁进入），不是故障；
   * 与 panic/error 混排会毁掉台账的信噪比（Windows 判例 2026-11-14）。 */
  kind: 'error' | 'unhandledrejection' | 'info';
  message?: unknown;
  source?: unknown;
  line?: unknown;
  column?: unknown;
  stack?: unknown;
}

const MAX_PENDING = 50;
const MAX_FIELD_CHARS = 4000;

const asString = (v: unknown, cap = MAX_FIELD_CHARS): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = typeof v === 'string' ? v : String(v);
  return s.length > cap ? s.slice(0, cap) : s;
};

export interface ErrorLedgerDeps {
  /** The persistence sink — one call per flushed batch of JSONL lines. */
  sink: (lines: string[]) => void | Promise<void>;
  now?: () => number;
}

export interface ErrorLedger {
  record(entry: GuiErrorInput): void;
  /** Flush immediately (used by tests and by pagehide). */
  flush(): Promise<void>;
  pendingCount(): number;
}

// ── 模块级诊断通道 ──
// chat.ts 里的设计内取证现场（ctx-shape 门禁进入等）不该走
// window.dispatchEvent(ErrorEvent)——那会以 kind:"error" + 完整 stack 落进
// 台账，和真正的 panic / tool_error 混在同一份台账里。这里给一个装配点 +
// 调用口：装配在 main.ts（chat.ts import main.ts 会成环），chat.ts 只 import
// 本模块。sink 未装配（测试 / web 模式）时静默丢弃，绝不成为新故障源。
let diagnosticSink: ((message: string) => void) | null = null;

export function setGuiDiagnosticSink(sink: ((message: string) => void) | null): void {
  diagnosticSink = sink;
}

export function recordGuiDiagnostic(message: string): void {
  try {
    diagnosticSink?.(message);
  } catch {
    /* 台账不可用不追击 */
  }
}

export function createErrorLedger(deps: ErrorLedgerDeps): ErrorLedger {
  const now = deps.now ?? Date.now;
  let pending: string[] = [];
  let flushing = false;
  let flushScheduled = false;

  const flush = async (): Promise<void> => {
    if (flushing || pending.length === 0) return;
    flushing = true;
    const batch = pending;
    pending = [];
    try {
      await deps.sink(batch);
    } catch {
      // 持久面不可用(Tauri 桥断了/web 模式)——丢弃这一批,台账不成为新故障源。
    } finally {
      flushing = false;
      // 攒批期间又进来的错误排到了新的 pending:补一刀。
      if (pending.length > 0 && !flushScheduled) void flush();
    }
  };

  const schedule = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      void flush();
    }, 0);
  };

  return {
    record(entry: GuiErrorInput): void {
      const line = JSON.stringify({
        ts: now(),
        source: 'webview',
        kind: entry.kind,
        message: asString(entry.message) ?? '',
        ...(asString(entry.source) !== undefined ? { source: asString(entry.source) } : {}),
        ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
        ...(typeof entry.column === 'number' ? { column: entry.column } : {}),
        ...(asString(entry.stack) !== undefined ? { stack: asString(entry.stack) } : {}),
      });
      // 同一次级联保最早的一批:根因几乎总在第一条,后来的全是雪崩回声。
      if (pending.length >= MAX_PENDING) return;
      pending.push(line);
      schedule();
    },
    flush,
    pendingCount: () => pending.length,
  };
}
