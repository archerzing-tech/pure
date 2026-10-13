// src/__tests__/cli-reap-mcp.test.ts
// 审计批 6③ — CLI 退出路径的 MCP 收割契约：reap 恰好一次、disconnectAll 的
// 抛错被吞（收尾尽力而为）、指针已空时幂等 no-op。activeMcpClient 是模块私有
// 状态，registerActiveMcpClient 就是注入缝。
import { describe, expect, it } from 'bun:test';
import { reapCliMcp, registerActiveMcpClient } from '../cliHarness';
import type { MCPClient } from '../harness/mcp/MCPClient';

const fakeClient = (behavior: () => void): MCPClient =>
  ({ disconnectAll: behavior }) as unknown as MCPClient;

describe('reapCliMcp (审计批 6③)', () => {
  it('disconnects the registered client exactly once, then idles', () => {
    let disconnects = 0;
    registerActiveMcpClient(fakeClient(() => { disconnects++; }));
    reapCliMcp();
    reapCliMcp(); // 指针已清空 → no-op
    expect(disconnects).toBe(1);
  });

  it('swallows a disconnectAll throw and still clears the pointer', () => {
    let calls = 0;
    registerActiveMcpClient(fakeClient(() => {
      calls++;
      throw new Error('transport already dead');
    }));
    expect(() => reapCliMcp()).not.toThrow();
    reapCliMcp();
    expect(calls).toBe(1); // 抛错的那次也清了指针，第二次摸不到客户端
  });

  it('is a no-op when nothing was registered', () => {
    registerActiveMcpClient(undefined);
    expect(() => reapCliMcp()).not.toThrow();
  });
});
