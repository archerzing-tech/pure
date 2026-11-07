// src/shared/network/dest.ts
// P0b 接线刀的 Destination 工厂。出口声明选路，目标只声明自己（不变量 1）：
// 调用点只需给出 URL 和目标类，幂等/可重放按 web 出口的统一事实填
// （全部是 GET，失败发生在副作用之前）。key 解析失败（相对路径、坏 URL）
// 返回空串——recordAttempt 对空 key 只入 class 层，样本不丢。

import type { Destination } from './types';

export function destFromUrl(url: string, destClass: Destination['class'], expect: Destination['expect']): Destination {
  let key = '';
  try {
    // WHATWG URL 的 hostname 序列化保证小写 + punycode，天然满足账本键的归一。
    key = new URL(url).hostname;
  } catch {
    // 只入 class 层
  }
  return { key, class: destClass, idempotent: true, replayable: true, mirrorable: false, expect };
}
