// 会话级持久模型覆盖（2026-11-06 多窗口各自选模型，第二刀）：
//   - 模型跟会话存档走：窗口是视图、会话是实体。A 会话 deepseek、B 会话 glm
//     互不串线；重启后模型随 session.json 回来（adoptSessionModel 固化恢复），
//     修复前覆盖是窗口内存态、重启全归零（用户复验打回）。
//   - 覆盖挂 SessionChatManager 的会话表（sessionModels），经 options 注入
//     getter 给 controller；getter 按会话 id 查表，选模型/恢复对已活
//     controller 立即可见。
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

/** openSession 的宿主容器：manager.container() 非空断言 #chat。 */
function mountChatRoot(): void {
  if (document.getElementById('chat')) return;
  const root = document.createElement('div');
  root.id = 'chat';
  document.body.appendChild(root);
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

  test('SessionChatManager:选模型落当前会话,各会话互不串线', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    manager.openSession('session_a');
    manager.openSession('session_b');
    // 当前会话 = b（最后 open）：选择只落 b，a 保持未覆盖。
    manager.setActiveSessionModel('glm', 'glm-5.3');
    expect(manager.sessionModelFor('session_b')).toEqual({ provider: 'glm', model: 'glm-5.3' });
    expect(manager.sessionModelFor('session_a')).toBeNull();
    // 切回 a 选 deepseek：a/b 各自保持——这是「A 窗口 deepseek、B 窗口 glm」
    // 的核心语义（会话是实体，覆盖跟会话走）。
    manager.openSession('session_a');
    manager.setActiveSessionModel('deepseek', 'deepseek-chat');
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(manager.sessionModelFor('session_b')).toEqual({ provider: 'glm', model: 'glm-5.3' });
    // activeSessionModel 跟当前会话（此刻 a）走：显示链读它。
    expect(manager.activeSessionModel()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    manager.openSession('session_b');
    expect(manager.activeSessionModel()).toEqual({ provider: 'glm', model: 'glm-5.3' });
  });

  test('adoptSessionModel:存档模型随冷恢复固化,字段不全不落表', () => {
    const manager = new SessionChatManager();
    manager.adoptSessionModel('session_a', 'deepseek', 'deepseek-chat');
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    // 老档/未覆盖（model/provider 为空）不落表：走全局默认，改全局默认不被
    // 旧会话钉死。
    manager.adoptSessionModel('session_old1', '', 'deepseek-chat');
    manager.adoptSessionModel('session_old2', 'deepseek', '');
    manager.adoptSessionModel('', 'deepseek', 'deepseek-chat');
    expect(manager.sessionModelFor('session_old1')).toBeNull();
    expect(manager.sessionModelFor('session_old2')).toBeNull();
  });

  test('极早期兜底:无活动会话时选模型进 pending,绑会话后固化且不泄漏', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    manager.setActiveSessionModel('qwen', 'qwen-max');
    // 未绑会话：pending 对任意会话可见（controller 消费链不空转）。
    expect(manager.sessionModelFor('session_x')).toEqual({ provider: 'qwen', model: 'qwen-max' });
    // 绑真实 id 后固化到该会话，pending 清掉——不再泄漏给别的会话。
    manager.openSession('session_x');
    expect(manager.sessionModelFor('session_x')).toEqual({ provider: 'qwen', model: 'qwen-max' });
    expect(manager.sessionModelFor('session_y')).toBeNull();
  });

  test('存档值优先:已 adopt 的会话不被极早期 pending 抢走', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    manager.adoptSessionModel('session_a', 'deepseek', 'deepseek-chat');
    manager.setActiveSessionModel('glm', 'glm-5.3'); // currentSessionId='' → pending
    manager.openSession('session_a');
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(manager.activeSessionModel()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});
