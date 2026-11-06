// src/character/__tests__/soulMirror.ts
// SOUL.md 的测试侧切块器（2026-11-06 人读面归一）。
//
// pure 的人格人读面已归一项目根 SOUL.md：原 kernels/ 下四份分散镜像的断言面
// 全部改锚本文件的四个机器块——`<!-- soul:kernel:<id> -->` /
// `<!-- soul:expression:<id> -->`。逐字同文的断言语义不变，只换读取面：
// 块内文本 = 断言面，块外（总纲、版本史等）改动不红。
//
// 切块逻辑与运行时覆盖层（../soulOverride.ts 的 sliceSoulSection）同源；这里
// 只保留「缺块即抛错」的测试语义——镜像丢失必须红在「缺块」，不能红在后续
// 某个 toContain 上让人去猜。运行时同函数返回 null（缺块=不覆盖）。

import { readFileSync } from 'node:fs';
import { sliceSoulSection } from '../soulOverride';

const SOUL = readFileSync(new URL('../../../SOUL.md', import.meta.url), 'utf8');

export function soulSection(kind: 'kernel' | 'expression', kernelId: string): string {
  const section = sliceSoulSection(SOUL, kind, kernelId);
  if (section === null) {
    throw new Error(`SOUL.md 缺 soul:${kind}:${kernelId} 块：人格人读面归一后，缺块=镜像丢失`);
  }
  return section;
}
