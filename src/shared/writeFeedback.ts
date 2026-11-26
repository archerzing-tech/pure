// src/shared/writeFeedback.ts
// 写入的即时反馈（2026-11-23）：用户的体感是「同一个任务里反复出现 1.2 万字符
// 的写入」。查过现有机制：write_file 描述里写了「超过 ~5k 默认拆」，但那是
// 常驻提示词里的一行，模型在动手那一刻手里没有成本信号；parallelNudge 要累计
// 到 24KB 才说话，而且只在回合中段注入一次——等它开口，整份正文已经重新生成
// 完了。GUI 的「正在消化 write_file 的结果（1.2 万字符）」是写完之后等下一轮
// 的等待卡，同样不在决策点上。
//
// 这一层把成本事实放到工具结果里：模型下一次看到这行时，同一回合的下一步还没
// 发生。只给事实与可选动作，不替模型决定该不该拆（决策边界：机制只做感知）。
// 三种形状分开说，因为它们该做的事不同：
//   · 首次大写入   —— 提示这是一个「整份正文进转录」的形状，下次怎么切;
//   · 同路径重写   —— 磁盘上已经有这份内容，第二次生成是纯白烧，改用 edit_file;
//   · append 分段  —— 这是被鼓励的形态，不提醒，只记账（便于后续重写判定）。
// 每条路径每个回合至多两条（首次 + 重写各一），避免长任务里逐次刷屏。
// shared 层不碰存储、不读 i18n（parallelNudge / providerSelfHeal 同构）。

/** 单次 write_file 正文到这个体量才提醒（≈ 一篇长文档或一个中等模块）。 */
export const LARGE_WRITE_CHARS = 6_000;

/** 同路径再次整写时，正文超过这个量才算「重写」——几百字符的补丁不值得拦。 */
export const REWRITE_MIN_CHARS = 1_200;

/** 回退开关：`PURE_WRITE_FEEDBACK=0`（与验收即停/无进展同款，便于同码 A/B）。 */
export function writeFeedbackEnabled(): boolean {
  return typeof process === 'undefined' || process.env?.PURE_WRITE_FEEDBACK !== '0';
}

export interface WriteCallFacts {
  toolName: string;
  /** 参数：已解析对象或原始 JSON 字符串（宿主两种都有）。 */
  args?: Record<string, unknown> | string | undefined;
  success: boolean;
}

export interface WriteFeedbackWatch {
  /**
   * 记一笔写入结果。返回非空即调用方应把它附加到该工具结果之后（模型在同一
   * 配对结果里读到，不占额外一轮）。
   */
  note(facts: WriteCallFacts): string;
  /** 会话边界清场（新会话/换工作区）。 */
  reset(): void;
}

interface PathRecord {
  /** 本会话累计写入字符（append 也计入，重写判定要看「已经给过多少」）。 */
  chars: number;
  /** 该路径的整写次数（append 不计）。 */
  writes: number;
}

function baseName(toolName: string): string {
  return toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
}

function asRecord(args: WriteCallFacts['args']): Record<string, unknown> | null {
  if (!args) return null;
  if (typeof args === 'string') {
    try {
      const parsed: unknown = JSON.parse(args);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return args;
}

function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function kb(n: number): string {
  return `${Math.round(n / 100) / 10} KB`;
}

/**
 * 这次调用会写进多少字符（正文体量）。宿主可在执行前用它显示/记录成本；
 * 非写工具、append 分段、参数缺失都返回 0。
 */
export function writeVolumeChars(toolName: string, args: WriteCallFacts['args']): number {
  if (baseName(toolName) !== 'write_file') return 0;
  const record = asRecord(args);
  if (!record || record.append === true) return 0;
  return typeof record.content === 'string' ? record.content.length : 0;
}

export function createWriteFeedbackWatch(): WriteFeedbackWatch {
  const seen = new Map<string, PathRecord>();
  const announced = new Set<string>();

  return {
    note(facts: WriteCallFacts): string {
      if (!facts.success) return '';
      if (baseName(facts.toolName) !== 'write_file') return '';

      const record = asRecord(facts.args);
      if (!record) return '';
      const path = typeof record.path === 'string' ? record.path : '';
      if (!path) return '';
      const content = typeof record.content === 'string' ? record.content : '';
      const isAppend = record.append === true;

      const entry = seen.get(path) ?? { chars: 0, writes: 0 };
      seen.set(path, entry);

      if (isAppend) {
        // 分段续写是被鼓励的形状：只记账，不说话（结果里已有 file now 锚点）。
        entry.chars += content.length;
        return '';
      }

      const firstWrite = entry.writes === 0;
      const previousChars = entry.chars;
      entry.chars += content.length;
      entry.writes += 1;

      if (firstWrite) {
        // 首次提示只管「大写入」：几百到几千字符的首次写入不值得讲拆分形状。
        if (content.length < LARGE_WRITE_CHARS) return '';
        const key = `first:${path}`;
        if (announced.has(key)) return '';
        announced.add(key);
        return `[write feedback] This single write_file carried ${grouped(content.length)} characters (≈${kb(content.length)}) for ${path}. ` +
          'The whole body now sits in the transcript and is re-sent on every later round. ' +
          'For the rest of this build: independent files go out as one parallel batch, a single large file continues with append:true chunks, ' +
          'and later changes to this file go through edit_file with only the changed lines.';
      }

      // 同路径再整写：判据只看「文件里是否已有内容」（REWRITE_MIN_CHARS），与本次
      // 体量解耦——2026-11-26 判例：旧实现把这条挂在 LARGE_WRITE_CHARS(6k) 的早退
      // 之后，1.2k–6k 之间的中等文档（设计文档/说明页的典型体量）重写时模型一条
      // 成本信号都收不到，于是「简化文档」直接整篇重写且毫无提示。
      // 本次体量也要过 REWRITE_MIN_CHARS，避免几百字符的小补丁被判成重写。
      if (previousChars >= REWRITE_MIN_CHARS && content.length >= REWRITE_MIN_CHARS) {
        const key = `rewrite:${path}`;
        if (announced.has(key)) return '';
        announced.add(key);
        const shrink = content.length < previousChars
          ? ` This rewrite shrinks it from ${grouped(previousChars)} to ${grouped(content.length)} characters; deleting each section with edit_file keeps the untouched sections verbatim.`
          : '';
        return `[write feedback] You have written ${path} from scratch again — ${grouped(content.length)} characters re-generated this time ` +
          `(previous write in this session: ${grouped(previousChars)} characters). The file on disk already contains that earlier body, ` +
          'so re-emitting the unchanged parts buys nothing: send only the changed regions with edit_file (oldString → newString), ' +
          `or continue with append:true when adding to the end.${shrink}`;
      }

      return '';
    },

    reset(): void {
      seen.clear();
      announced.clear();
    },
  };
}
