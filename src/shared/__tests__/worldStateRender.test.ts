// src/shared/__tests__/worldStateRender.test.ts
// 四期 4b：世界状态分区 diff 渲染的契约——状态不变零内容 token（一行指针），
// 变了全量重发；指针期限是历史淘汰的保险丝；reset 后宁可全量不可悬空引用。

import { describe, expect, it } from 'bun:test';
import { WorldStateRenderer } from '../worldStateRender';

const ENV = '<project_conventions>\nuse bun, use rtk\n</project_conventions>\n\nEnvironment runtimes (installed on this machine): bun 1.4.3';

describe('WorldStateRenderer (framework-reform phase 4b)', () => {
  it('renders the first turn in full', () => {
    const r = new WorldStateRenderer();
    const out = r.renderTurn({ envFacts: ENV });
    expect(out.envFacts).toBe(ENV);
  });

  it('emits a pointer for an unchanged partition on the next turns, full text after the age cap', () => {
    const r = new WorldStateRenderer();
    r.renderTurn({ envFacts: ENV }); // 回合 1：全量
    const p2 = r.renderTurn({ envFacts: ENV }); // 回合 2：指针
    expect(p2.envFacts).toContain('[envFacts]');
    expect(p2.envFacts).toContain('unchanged since the previous task_context');
    expect(p2.envFacts).not.toContain('project_conventions');
    const p3 = r.renderTurn({ envFacts: ENV }); // 回合 3：仍在指针期限内
    expect(p3.envFacts).toContain('unchanged');
    const full3 = r.renderTurn({ envFacts: ENV }); // 回合 4：期限到，强制全量
    expect(full3.envFacts).toBe(ENV);
  });

  it('re-renders in full the moment the content changes, and re-ages the clock', () => {
    const r = new WorldStateRenderer();
    r.renderTurn({ envFacts: ENV });
    r.renderTurn({ envFacts: ENV }); // 指针
    const changed = `${ENV}\n\nEnvironment network (this machine): direct`;
    const out = r.renderTurn({ envFacts: changed }); // 内容变了：立即全量
    expect(out.envFacts).toBe(changed);
    expect(r.renderTurn({ envFacts: changed }).envFacts).toContain('unchanged'); // 新基准上继续 diff
  });

  it('forgetting an emptied partition: empty passes through, a later return renders in full', () => {
    const r = new WorldStateRenderer();
    r.renderTurn({ ledgerFacts: 'entry' });
    const emptied = r.renderTurn({ ledgerFacts: '' });
    expect(emptied.ledgerFacts).toBe('');
    expect(r.renderTurn({ ledgerFacts: 'entry' }).ledgerFacts).toBe('entry'); // 回归非空：全量，不发指针
  });

  it('reset() forces full renders — no pointer may reference evicted history', () => {
    const r = new WorldStateRenderer();
    r.renderTurn({ envFacts: ENV });
    r.reset();
    expect(r.renderTurn({ envFacts: ENV }).envFacts).toBe(ENV);
  });

  it('passes through only the partitions it was given, values verbatim when full', () => {
    const r = new WorldStateRenderer();
    const out = r.renderTurn({ plan: 'step one', ledgerFacts: undefined });
    expect(Object.keys(out)).toEqual(['plan']);
    expect(out.plan).toBe('step one');
  });

  it('a fresh entry never pointers within the same renderTurn (age=0 short-circuit)', () => {
    const r = new WorldStateRenderer();
    // 同一回合内首次出现的分区必须全量——age=0 的短路是「本回合刚全量渲染」
    // 的守卫，防未来有人在同一回合调两次 renderTurn 时把第二份当指针。
    const first = r.renderTurn({ assessment: 'on track' });
    expect(first.assessment).toBe('on track');
  });
});
