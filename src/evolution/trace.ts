// 演化痕迹打点：appendTrace 往 <cwd>/.pure-evo/trace.jsonl 追加一行 JSONL。
// 本模块经 chat → turnRoute/interjectOrchestrator/SubagentOrchestrator 被
// 打进 GUI 浏览器 bundle：node:fs/node:path 的静态具名导入会让 vite build
// 对 __vite-browser-external 直接判死（v3.3.3 首轮 release 三平台全红，
// bun test 全在 node 侧跑所以拦不住）。因此 node 内建一律动态引入 + 浏览器
// 守卫：WebView 里 process 不存在，静默 no-op——打点本是诊断设施，不配
// 拦任何主流程。

export type TraceEventType =
  | 'interject'
  | 'interject_block'
  | 'cancel_before_dispatch'
  | 'route_decided'
  | 'delegate'
  | 'turn_route_prefetch'
  | 'turn_route_decided';

export interface TraceEvent {
  ts: number;
  type: TraceEventType;
  reason?: string;
  turnId?: string;
  subagentId?: string;
  route?: string;
  snippet?: string;
  [k: string]: unknown;
}

function inNodeRuntime(): boolean {
  return typeof process !== 'undefined' && typeof process.cwd === 'function';
}

export function appendTrace(event: Omit<TraceEvent, 'ts'>): void {
  try {
    if (!inNodeRuntime()) return; // 浏览器 bundle：无盘可落，静默放弃
    void writeTrace(event);
  } catch {
    // 静默：不影响主流程
  }
}

async function writeTrace(event: Omit<TraceEvent, 'ts'>): Promise<void> {
  try {
    const [fs, path] = await Promise.all([import('node:fs'), import('node:path')]);
    // 优先使用项目根目录下 .pure-evo
    const dir = path.join(process.cwd(), '.pure-evo');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const rec: TraceEvent = { ts: Date.now(), ...event } as TraceEvent;
    fs.appendFileSync(path.join(dir, 'trace.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    // 静默：不影响主流程
  }
}
