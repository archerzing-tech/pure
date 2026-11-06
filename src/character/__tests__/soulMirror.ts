// src/character/__tests__/soulMirror.ts
// SOUL.md 的测试侧切块器（2026-11-06 人读面归一）。
//
// pure 的人格人读面已归一项目根 SOUL.md：原 kernels/ 下四份分散镜像的断言面
// 全部改锚本文件的四个机器块——`<!-- soul:kernel:<id> -->` /
// `<!-- soul:expression:<id> -->`。逐字同文的断言语义不变，只换读取面：
// 块内文本 = 断言面，块外（总纲、版本史等）改动不红。
//
// 缺块直接抛错而非返回空串：镜像丢失必须红在「缺块」，不能红在后续某个
// toContain 上让人去猜。

import { readFileSync } from 'node:fs';

const SOUL = readFileSync(new URL('../../../SOUL.md', import.meta.url), 'utf8');

export function soulSection(kind: 'kernel' | 'expression', kernelId: string): string {
  const open = `<!-- soul:${kind}:${kernelId} -->`;
  const close = `<!-- /soul:${kind}:${kernelId} -->`;
  const start = SOUL.indexOf(open);
  const end = SOUL.indexOf(close);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`SOUL.md 缺 ${open} 块：人格人读面归一后，缺块=镜像丢失`);
  }
  return SOUL.slice(start + open.length, end);
}
