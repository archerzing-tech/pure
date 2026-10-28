// src/coding-agent/__tests__/interjectionPort.test.ts
// 插话端口契约锁（2026-10-28）：对接点唯一、插入点三处、宿主不旁路。
// 契约本体见 ../interjectionPort.ts 模块头——这里锁的是「边界不被绕开」：
// 后续换队列+注入式实现时端口签名不动（编译期类型锁），宿主不得直调
// 裁决序（源码锁）。

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InterjectionInjectionPoints, InterjectionIngress } from '../interjectionPort';
import { InterjectOrchestrator } from '../interjectOrchestrator';

// ── 编译期端口锁：编排器满足对接点契约；P3 形状与契约一致 ──────────────
type IngressOk = InterjectOrchestrator extends InterjectionIngress ? true : false;
const ingressOk: IngressOk = true;
type P3Ok = InterjectOrchestrator['takePreflightSupplements'] extends InterjectionInjectionPoints['takePreflightSupplements']
  ? true
  : false;
const p3Ok: P3Ok = true;

const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8');

describe('interjectionPort（插话端口契约）', () => {
  test('对接点签名真实存在（编排器可实例化的类面）', () => {
    expect(typeof InterjectOrchestrator.prototype.interject).toBe('function');
    expect(typeof InterjectOrchestrator.prototype.takePreflightSupplements).toBe('function');
  });

  test('契约文件声明一个对接点与三个插入点', () => {
    const port = read('../interjectionPort.ts');
    for (const name of ['interject', 'takeSteerMessages', 'takeSyntheticToolCalls', 'takePreflightSupplements']) {
      expect(port).toContain(name);
    }
  });

  test('宿主不旁路：chat/main 不直接调裁决序 classifyAndApply', () => {
    for (const host of ['../../ui/chat.ts', '../../ui/main.ts']) {
      expect(read(host).indexOf('.classifyAndApply(')).toBe(-1);
    }
  });

  test('宿主端口标注在位：对接点 + P1/P2/P3 都引用契约文件', () => {
    const chat = read('../../ui/chat.ts');
    // 对接点转发 + 两个宿主侧插入点回调 + P3 取件并账，各挂一处契约引用
    expect(chat.split('interjectionPort.ts').length - 1).toBeGreaterThanOrEqual(4);
  });
});
