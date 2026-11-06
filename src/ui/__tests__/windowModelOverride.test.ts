// 会话级持久模型覆盖（2026-11-06 多窗口各自选模型）：
//   - 模型跟会话存档走：窗口是视图、会话是实体。A 会话 deepseek、B 会话 glm
//     互不串线；重启后模型随 session.json 回来（adoptSessionModel 固化恢复）。
//   - 覆盖挂 SessionChatManager 的会话表（sessionModels），经 options 注入
//     getter 给 controller；查不到落到窗口级常驻 lastChoice（复验二判例：
//     会话更替换 id 不丢选择），再查不到才是全局默认。
//   - 首发定型（复验三判例）：从没选过模型的会话回退全局＝跟共享值串线——
//     别的窗口换模型写盘,本会话跟着变。首次发送把当时生效值钉进会话表,
//     之后全局怎么变都不影响;显式换模型照常覆盖。
//   - config.json 的 model 仍是全局默认（新窗口初值 / agent 可改）。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { readFileSync } from 'node:fs';
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
    // 当前会话 = b（最后 open）：选择钉进 b 的表项，同时成为窗口 lastChoice。
    manager.setActiveSessionModel('glm', 'glm-5.3');
    expect(manager.sessionModelFor('session_b')).toEqual({ provider: 'glm', model: 'glm-5.3' });
    // a 没有自己的表项 → 落窗口 lastChoice（glm），不回全局——「本窗口最近
    // 一次选择」对没选过模型的会话生效，这是真机判例（复验二）的兜底语义。
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'glm', model: 'glm-5.3' });
    // 切回 a 选 deepseek：a 有了自己的表项——这是「同窗口多会话各自保持」
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
    // 老档/未覆盖（model/provider 为空）不落表：走窗口兜底/全局默认，改全局
    // 默认不被旧会话钉死。
    manager.adoptSessionModel('session_old1', '', 'deepseek-chat');
    manager.adoptSessionModel('session_old2', 'deepseek', '');
    manager.adoptSessionModel('', 'deepseek', 'deepseek-chat');
    expect(manager.sessionModelFor('session_old1')).toBeNull();
    expect(manager.sessionModelFor('session_old2')).toBeNull();
  });

  test('窗口兜底:无活动会话时选模型,lastChoice 对后续会话常驻可见', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    manager.setActiveSessionModel('qwen', 'qwen-max');
    // 未绑会话：lastChoice 对任意会话可见（controller 消费链不空转）。
    expect(manager.sessionModelFor('session_x')).toEqual({ provider: 'qwen', model: 'qwen-max' });
    manager.openSession('session_x');
    expect(manager.sessionModelFor('session_x')).toEqual({ provider: 'qwen', model: 'qwen-max' });
  });

  test('真机判例(2026-11-06 复验二):新对话换 id 不丢选择', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    // landing 懒创建出 id0,用户在 id0 上选了 glm。
    manager.openSession('session_id0');
    manager.setActiveSessionModel('glm', 'glm-5.3');
    // 「新对话」:clear→forget(id0)→mint 新 id1——选择必须跟过来,
    // 不能悄悄回退全局(复验二打回的串线根因)。
    manager.openSession('session_id1');
    expect(manager.sessionModelFor('session_id1')).toEqual({ provider: 'glm', model: 'glm-5.3' });
    expect(manager.activeSessionModel()).toEqual({ provider: 'glm', model: 'glm-5.3' });
    // 旧会话的选择也钉在表里:切回 id0 仍是 glm。
    expect(manager.sessionModelFor('session_id0')).toEqual({ provider: 'glm', model: 'glm-5.3' });
  });

  test('存档值优先:已 adopt 的会话不被窗口 lastChoice 抢走', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    manager.adoptSessionModel('session_a', 'deepseek', 'deepseek-chat');
    manager.setActiveSessionModel('glm', 'glm-5.3'); // lastChoice=glm + map[current]
    manager.openSession('session_a');
    // session_a 在表里有存档模型,优先于窗口 lastChoice。
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(manager.activeSessionModel()).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  test('首发定型:首问钉住当时全局值,之后全局被别的窗口改掉不再串(复验三)', () => {
    const manager = new SessionChatManager();
    mountChatRoot();
    manager.openSession('session_a');
    // A 首问:无覆盖,controller 经注入的 pinSessionModel 把当时全局值(glm)
    // 钉进会话表——private,经类型桥调用真实现。
    const pin = (manager as unknown as { pinSessionModelIfUnset(id: string, p: string, m: string): void }).pinSessionModelIfUnset.bind(manager, 'session_a');
    pin('glm', 'glm-4.7');
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'glm', model: 'glm-4.7' });
    // B 窗口换模型写全局(全局是共享值,manager 管不到)——A 已定型,不受影响。
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'glm', model: 'glm-4.7' });
    // 幂等:显式选择后 pin 不覆盖(用户换模型权最高);表里有条目时 pin 是 no-op。
    manager.setActiveSessionModel('qwen', 'qwen-max');
    pin('deepseek', 'deepseek-chat');
    expect(manager.sessionModelFor('session_a')).toEqual({ provider: 'qwen', model: 'qwen-max' });
    // 未定型的会话不沾光也不受害:照旧走窗口兜底/全局。
    expect(manager.sessionModelFor('session_b')).toEqual({ provider: 'qwen', model: 'qwen-max' }); // lastChoice
  });

  test('send 链接线:定型只在无覆盖时发生,写的是快照的 provider/model', () => {
    const chat = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8');
    expect(chat).toContain('if (!this.readWindowModelOverride() && config) {');
    expect(chat).toContain('this.pinSessionModel(config.provider, config.model);');
    expect(chat).toContain('pinSessionModelIfUnset(sessionId, provider, model)');
  });
});
