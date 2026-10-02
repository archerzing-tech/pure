// src/shared/__tests__/arityLock.ts
// 场景开关默认值的共享回归锁（2026-10-01）。
//
// 判据（见 改进进度记录.md 续十五）：形参带默认值 = 调用点忘传时静默走错
// 场景（取消/追加、委派/单任务、停/暂停、构建/非构建、已批/待批……）。正确
// 分支取决于调用现场，没有全局安全的默认，所以这类开关一律必填。
//
// 测试对每个函数断言 Function.length——JS 只数「首个默认参数之前」的形参，
// 因此 length 等于形参总数就是「每个形参都必须显式给」的运行时证据；谁把默认
// 值加回来，length 立刻掉下来。抽到这里是为了让各模块共用同一套断言，而不是
// 各自重复写 for + expect。
import { expect } from 'bun:test';

/** [函数展示名, 形参总数, 函数本身]。 */
export type ArityCase = readonly [name: string, expectedArity: number, fn: { length: number }];

/** 断言每个函数都没有默认形参（Function.length === 形参总数）。 */
export function expectNoDefaultParams(cases: readonly ArityCase[]): void {
  for (const [name, expectedArity, fn] of cases) {
    expect({ name, length: fn.length }).toEqual({ name, length: expectedArity });
  }
}
