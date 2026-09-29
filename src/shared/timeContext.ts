// src/shared/timeContext.ts
// 「现在」的单一事实来源。训练语料的时代不是现在——凡是调研、趋势、版本、
// 新闻这类带时间维度的任务，模型必须知道「今天」是哪天才能把基准放对。
//
// 设计约束（2026-09-29 用户定调）：不写死、不做模式/关键词匹配。时间是运行时
// 事实，注入是结构性的（每个回合的环境行 + 调研角色的系统提示词），行为指导
// 是泛化的（"带时间维度的任务以现在为基准"），不挑话术。曾经的设计是"时间
// 不进 system prompt（会立即过时），模型自己调 sys_info"——那个决定防的是
// 缓存失效与过时，但它只对"精确时刻"必要；"今天几号"这个基准粒度每回合
// 现算现注入，既不过时也不需要一次工具往返才存在，实测缺了它模型就拿训练
// 语料的旧时间当"当前"。sys_info 仍负责秒级时刻/时区细节，两层不打架。

export interface TimeContext {
  /** ISO 8601（含时区偏移），给需要精确时刻的场合。 */
  iso: string;
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  /** 英文星期名（Wednesday），提示词层稳定用英文。 */
  weekday: string;
  /** 本地月日英文名（September 29, 2026）。 */
  longDate: string;
  /** IANA 时区名（Asia/Shanghai）；解析失败退回 UTC 标记。 */
  timezone: string;
}

/** 纯函数：给定时刻产出时间上下文。timeZone 省略时用运行环境的本地时区。 */
export function currentTimeContext(now: Date = new Date(), timeZone?: string): TimeContext {
  const tz = timeZone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? 'UTC';
  const safeTz = isValidTimeZone(tz) ? tz : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = pick('year');
  const month = pick('month');
  const day = pick('day');
  return {
    iso: now.toISOString(),
    date: new Intl.DateTimeFormat('en-CA', { timeZone: safeTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now),
    weekday: pick('weekday'),
    longDate: `${month} ${day}, ${year}`,
    timezone: safeTz,
  };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 环境行里的时间基准句：泛化指导，不含任何任务关键词匹配。 */
export function formatTimeContextLine(ctx: TimeContext): string {
  return `Current date: ${ctx.weekday}, ${ctx.longDate} (local timezone: ${ctx.timezone}). This is TODAY — treat it as the reference point for anything dated (recent events, versions, releases, trends, news, schedules): judge what is current against it, label historical information with its time, and never take the era of your training data as the present. Call sys_info() when a task needs the exact time of day.`;
}

/** 调研角色的系统提示词时间基准段：子代理没有父回合的环境行，把"以现在
 *  为基准"直接长进角色提示词。注入是结构性的（每次派发现算），非关键词。 */
export function formatResearchTimeBaseline(ctx: TimeContext): string {
  return `当前时间基准：${ctx.longDate}（${ctx.weekday}，时区 ${ctx.timezone}）。调研以「现在」为基准：优先采信当前有效的事实（最新版本、最新数据、近期进展与状态），历史信息必须标注它的时间；无法确定某条信息是否仍然有效时如实说明，绝不把训练语料里的时代当成现在。`;
}
