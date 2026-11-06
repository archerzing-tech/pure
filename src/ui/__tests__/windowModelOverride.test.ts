// 窗口级模型覆盖（2026-11-06 多窗口各自选模型）：
//   - 每窗口一个实例对应一份用户选择：A 窗口 glm、B 窗口 deepseek、C 窗口 qwen
//     互不串线——修复前模型选择写全局 config（localStorage + config.json 双通
//     道），最后选择的窗口覆盖前面所有窗口（adapter 与 model_identity 全变）。
//   - override 挂 SessionChatManager（窗口单例），经 options 注入 getter 给
//     controller；getter 形状让覆盖变更对已活 controller 立即可见。
//   - config.json 的 model 仍是全局默认（新窗口初值 / agent 可改），覆盖为空
//     时行为与旧版完全一致（单窗口用户零感知）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { ChatController, SessionChatManager, type ChatControllerOptions } from '../chat';
import type { PureConfig } from '../config';

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

function makeConfig(model: string, provider = 'glm'): PureConfig {
  return { provider, model, taskMode: 'auto' } as unknown as PureConfig;
}

function makeController(opts: ChatControllerOptions = {}): Record<string, any> {
  return new ChatController(opts) as unknown as Record<string, any>;
}

describe('窗口级模型覆盖', () => {
  test('无覆盖时 resolvedGuiConfig 原样返回全局 config（单窗口零感知）', () => {
    const controller = makeController();
    const base = makeConfig('glm-4.7');
    expect(controller.resolvedGuiConfig(base)).toBe(base);
    expect(controller.resolvedGuiConfig(null)).toBeNull();
  });

  test('有覆盖时 provider/model 被替换，其余字段原样保留', () => {
    const controller = makeController({ readWindowModelOverride: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) });
    const base = makeConfig('glm-4.7');
    (base as unknown as Record<string, unknown>).proxy = 'http://127.0.0.1:7890';
    const resolved = controller.resolvedGuiConfig(base);
    expect(resolved).not.toBe(base);
    expect(resolved?.provider).toBe('deepseek');
    expect(resolved?.model).toBe('deepseek-chat');
    expect((resolved as unknown as Record<string, unknown> | null)?.proxy).toBe('http://127.0.0.1:7890');
  });

  test('覆盖 getter 变更对已建 controller 立即可见（不必重建）', () => {
    const state: { override: { provider: string; model: string } | null } = { override: null };
    const controller = makeController({ readWindowModelOverride: () => state.override });
    const base = makeConfig('glm-4.7');
    expect(controller.resolvedGuiConfig(base)?.model).toBe('glm-4.7');
    state.override = { provider: 'qwen', model: 'qwen-max' };
    expect(controller.resolvedGuiConfig(base)?.model).toBe('qwen-max');
    expect(controller.resolvedGuiConfig(base)?.provider).toBe('qwen');
  });

  test('SessionChatManager setter/getter 读写窗口覆盖', () => {
    const manager = new SessionChatManager();
    expect(manager.windowModelOverrideValue()).toBeNull();
    manager.setModelOverride('deepseek', 'deepseek-chat');
    expect(manager.windowModelOverrideValue()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    manager.setModelOverride('qwen', 'qwen-max');
    expect(manager.windowModelOverrideValue()).toEqual({ provider: 'qwen', model: 'qwen-max' });
  });
});
